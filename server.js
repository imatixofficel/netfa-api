'use strict';

/**
 * NET.fa API
 * ----------
 * یک پروکسیِ سبک که فیدهای RSS خبرگزاری‌ها را می‌خواند، با کلیدواژه‌های
 * اختلال اینترنت / حمله سایبری / دیتاسنتر فیلتر می‌کند و ۵ خبر تازه را برمی‌گرداند.
 *
 * قانون اصلی: هیچ داده‌ای ساخته نمی‌شود. اگر منبعی جواب ندهد یا خبری پیدا نشود،
 * آرایه خالی (یا خطای 503 با پیام روشن) برگردانده می‌شود.
 *
 * Endpoints:
 *   GET /api/status  -> آرایه حداکثر ۵ خبر
 *   GET /api/health  -> وضعیت هر منبع (برای عیب‌یابی)
 */

const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');

/* ------------------------------------------------------------------ */
/* تنظیمات                                                            */
/* ------------------------------------------------------------------ */

const PORT = Number(process.env.PORT) || 3000;
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_SECONDS) || 300) * 1000; // ۵ دقیقه
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 10000;
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS) || 30;
const MAX_ITEMS = 5;

// فیدهای پیش‌فرض. اگر آدرسی کار نکرد، در /api/health دلیلش دیده می‌شود.
// برای عوض کردن بدون دست‌زدن به کد: متغیر محیطی FEEDS_JSON
// مثال: [{"name":"ایسنا","url":"https://www.isna.ir/rss"}]
const DEFAULT_FEEDS = [
  { name: 'خبرآنلاین', url: 'https://www.khabaronline.ir/rss' },
  { name: 'خبرگزاری مهر', url: 'https://www.mehrnews.com/rss' },
  { name: 'همشهری آنلاین', url: 'https://www.hamshahrionline.ir/rss' },
  { name: 'ایسنا', url: 'https://www.isna.ir/rss' },
  { name: 'دیجیاتو', url: 'https://digiato.com/feed' },
  { name: 'زومیت', url: 'https://www.zoomit.ir/feed/' },
];

// صفحه وضعیت اپراتورهای دیتاسنتر (فرمت Atlassian Statuspage). به‌صورت پیش‌فرض خالی است.
// مثال: STATUS_PAGES_JSON=[{"name":"وضعیت اپراتور","url":"https://status.example.com"}]
const DEFAULT_STATUS_PAGES = [];

function readJsonEnv(key, fallback) {
  if (!process.env[key]) return fallback;
  try {
    const v = JSON.parse(process.env[key]);
    return Array.isArray(v) ? v : fallback;
  } catch {
    console.warn(`[config] ${key} معتبر نیست؛ از مقدار پیش‌فرض استفاده می‌شود.`);
    return fallback;
  }
}

const FEEDS = readJsonEnv('FEEDS_JSON', DEFAULT_FEEDS);
const STATUS_PAGES = readJsonEnv('STATUS_PAGES_JSON', DEFAULT_STATUS_PAGES);

/* ------------------------------------------------------------------ */
/* کلیدواژه‌ها و دسته‌بندی                                             */
/* ------------------------------------------------------------------ */

// ترتیب مهم است: اگر چند دسته با هم جور شد، اولی برنده است.
const RULES = [
  {
    category: 'CyberAttack',
    terms: ['حمله سایبری', 'حملات سایبری', 'حمله هکری', 'ddos'],
  },
  {
    category: 'DataCenter',
    terms: ['دیتاسنتر', 'دیتا سنتر', 'مرکز داده'],
  },
  {
    category: 'Internet',
    terms: [
      'اختلال اینترنت',
      'اختلال در اینترنت',
      'قطعی اینترنت',
      'قطعی در اینترنت',
      'قطع اینترنت',
    ],
    // «افت کیفیت» تنها کافی نیست (ممکن است درباره نان یا آب باشد)؛
    // فقط وقتی معتبر است که کنارش از اینترنت/شبکه حرفی باشد.
    contextual: { term: 'افت کیفیت', needs: ['اینترنت', 'شبکه', 'ارتباط', 'موبایل', 'همراه', 'پهنای باند'] },
  },
];

/** یکسان‌سازی متن فارسی برای مقایسه (ی/ک عربی، نیم‌فاصله، اعراب، حروف بزرگ) */
function normalize(input) {
  return String(input || '')
    .replace(/[\u064A\u0649]/g, '\u06CC') // ي ى -> ی
    .replace(/\u0643/g, '\u06A9') // ك -> ک
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // اعراب و کشیده
    .replace(/[\u200C\u200D\u200E\u200F]/g, '') // نیم‌فاصله و کاراکترهای جهت
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const NORMALIZED_RULES = RULES.map((r) => ({
  category: r.category,
  terms: r.terms.map(normalize),
  contextual: r.contextual
    ? { term: normalize(r.contextual.term), needs: r.contextual.needs.map(normalize) }
    : null,
}));

/** دسته‌ی خبر را برمی‌گرداند؛ اگر به هیچ کلیدواژه‌ای نخورد، null */
function classify(title, description) {
  const text = normalize(`${title} ${description}`);
  for (const rule of NORMALIZED_RULES) {
    if (rule.terms.some((t) => text.includes(t))) return rule.category;
    if (
      rule.contextual &&
      text.includes(rule.contextual.term) &&
      rule.contextual.needs.some((n) => text.includes(n))
    ) {
      return rule.category;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* ابزارهای متن                                                        */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»' };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[e.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function stripHtml(html) {
  const noTags = String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(noTags)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** حداکثر دو جمله از توضیحات (و حداکثر ۳۰۰ نویسه) */
function summarize(text, maxSentences = 2, maxChars = 300) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const sentences = clean.match(/[^.!؟?…]+[.!؟?…]*/g) || [clean];
  let out = sentences.slice(0, maxSentences).map((x) => x.trim()).join(' ').trim();
  if (out.length > maxChars) out = out.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
  return out;
}

function safeUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
}

/* ------------------------------------------------------------------ */
/* دریافت داده                                                         */
/* ------------------------------------------------------------------ */

const parser = new Parser();
const UA = 'Mozilla/5.0 (compatible; NETfaBot/1.0; +status-dashboard)';

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'application/rss+xml, application/xml, text/xml;q=0.9, application/json;q=0.8, */*;q=0.5',
        'accept-language': 'fa,en;q=0.5',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('timeout');
    const code = err.cause && (err.cause.code || err.cause.message);
    throw new Error(code ? `${err.message} (${code})` : err.message);
  } finally {
    clearTimeout(timer);
  }
}

/** یک فید RSS را می‌خواند و آیتم‌های خام را برمی‌گرداند */
async function readFeed(feed) {
  const raw = (await fetchText(feed.url)).replace(/^\uFEFF/, '');
  if (!/^\s*(<\?xml|<rss|<feed|<rdf)/i.test(raw.slice(0, 300))) {
    throw new Error('پاسخ، RSS نیست (احتمالاً صفحه HTML یا مسدودسازی)');
  }
  const parsed = await parser.parseString(raw);
  return (parsed.items || []).map((it) => ({
    title: String(it.title || '').trim(),
    description: stripHtml(it.content || it.summary || it['content:encoded'] || it.contentSnippet || ''),
    date: new Date(it.isoDate || it.pubDate || NaN),
    link: safeUrl(it.link),
  }));
}

/** یک صفحه وضعیت (Atlassian Statuspage) را می‌خواند؛ همه‌ی رویدادها دسته‌ی DataCenter می‌گیرند */
async function readStatusPage(page) {
  const base = String(page.url).replace(/\/+$/, '');
  const data = JSON.parse(await fetchText(`${base}/api/v2/incidents.json`));
  return (data.incidents || []).slice(0, 20).map((inc) => {
    const firstUpdate = Array.isArray(inc.incident_updates) ? inc.incident_updates[0] : null;
    return {
      title: String(inc.name || '').trim(),
      description: stripHtml(firstUpdate && firstUpdate.body),
      date: new Date(inc.updated_at || inc.created_at || NaN),
      link: safeUrl(inc.shortlink) || base,
      forcedCategory: 'DataCenter',
    };
  });
}

/** همه‌ی منابع را موازی می‌خواند و ۵ خبر تازه‌ی مرتبط را برمی‌گرداند */
async function collect() {
  const jobs = [
    ...FEEDS.map((f) => ({ name: f.name, run: () => readFeed(f) })),
    ...STATUS_PAGES.map((p) => ({ name: p.name, run: () => readStatusPage(p) })),
  ];

  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  const now = Date.now();
  const oldest = now - MAX_AGE_DAYS * 86400000;
  const newest = now + 10 * 60000; // تاریخ‌های آینده (غیرمعتبر) را نمی‌پذیریم

  const sources = [];
  const matched = [];

  settled.forEach((result, i) => {
    const name = jobs[i].name;
    if (result.status === 'rejected') {
      sources.push({ name, ok: false, scanned: 0, matched: 0, error: String(result.reason.message || result.reason) });
      return;
    }
    let count = 0;
    for (const it of result.value) {
      const t = it.date.getTime();
      if (!it.title || Number.isNaN(t) || t < oldest || t > newest) continue;
      const category = it.forcedCategory || classify(it.title, it.description);
      if (!category) continue;
      const summary = normalize(it.description) === normalize(it.title) ? '' : summarize(it.description);
      matched.push({
        timestamp: it.date.toISOString(),
        source: name,
        headline: it.title,
        summary,
        category,
        link: it.link,
      });
      count += 1;
    }
    sources.push({ name, ok: true, scanned: result.value.length, matched: count });
  });

  // حذف تکراری‌ها (لینک یا تیتر یکسان) و مرتب‌سازی از جدیدترین
  const seen = new Set();
  const items = matched
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .filter((it) => {
      const key = it.link || normalize(it.headline);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_ITEMS);

  return { items, sources, allFailed: sources.length > 0 && sources.every((s) => !s.ok), updatedAt: now };
}

/* ------------------------------------------------------------------ */
/* کش حافظه‌ای (۵ دقیقه)                                               */
/* ------------------------------------------------------------------ */

let cache = null; // آخرین نتیجه‌ی موفق
let inflight = null; // جلوگیری از چند درخواست هم‌زمان به منابع
let lastSources = [];

async function getData() {
  const fresh = cache && Date.now() - cache.updatedAt < CACHE_TTL_MS;
  if (fresh) return { data: cache, state: 'HIT' };

  if (!inflight) {
    inflight = collect()
      .then((result) => {
        lastSources = result.sources;
        if (!result.allFailed) cache = result;
        return result;
      })
      .finally(() => {
        inflight = null;
      });
  }

  const result = await inflight;
  if (!result.allFailed) return { data: result, state: 'MISS' };
  // همه‌ی منابع شکست خوردند: اگر خبر واقعیِ قبلی داریم، همان را (با برچسب STALE) نشان بده
  if (cache) return { data: cache, state: 'STALE' };
  const err = new Error('هیچ‌کدام از منابع خبری پاسخ ندادند.');
  err.code = 'SOURCES_UNAVAILABLE';
  throw err;
}

/* ------------------------------------------------------------------ */
/* سرور                                                                */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: '*', methods: ['GET'], exposedHeaders: ['X-Updated-At', 'X-Cache'] }));

app.get('/', (_req, res) => {
  res.json({ service: 'NET.fa API', endpoints: ['/api/status', '/api/health'] });
});

app.get('/api/status', async (_req, res) => {
  try {
    const { data, state } = await getData();
    res.set({
      'Cache-Control': 'public, max-age=60',
      'X-Cache': state,
      'X-Updated-At': new Date(data.updatedAt).toISOString(),
    });
    res.json(data.items);
  } catch (err) {
    res.status(503).json({
      error: err.code || 'INTERNAL_ERROR',
      message: err.message || 'خطای داخلی سرور',
    });
  }
});

app.get('/api/health', async (_req, res) => {
  let state = 'ERROR';
  let updatedAt = null;
  try {
    const out = await getData();
    state = out.state;
    updatedAt = new Date(out.data.updatedAt).toISOString();
  } catch {
    /* وضعیت منابع پایین‌تر نشان داده می‌شود */
  }
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: state !== 'ERROR',
    cache: state,
    updatedAt,
    cacheTtlSeconds: CACHE_TTL_MS / 1000,
    sources: lastSources,
  });
});

app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

if (require.main === module) {
  app.listen(PORT, () => console.log(`NET.fa API listening on :${PORT} (${FEEDS.length} feeds)`));
}

module.exports = { app, classify, summarize, stripHtml, normalize };
