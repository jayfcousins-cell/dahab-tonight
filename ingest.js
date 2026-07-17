#!/usr/bin/env node
/* Dahab Tonight - event ingester.
 * Sources are probed in order; the first that yields DATED events wins:
 *   1. WP REST API      /wp-json/wp/v2/<type>      (richest, if the CPT is exposed)
 *   2. Explore endpoint /explore/?type=event       (confirmed to carry real start times)
 *   3. RSS              /feed/?post_type=<type>    (change detector; post dates, not event dates)
 * Enriches from seed.json (covers, coords, descriptions), drops past events, writes events.json.
 * No dependencies. Node 20+ (global fetch).
 */
const fs = require('fs');
const path = require('path');

const BASE = 'https://dailydahab.com';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; DahabTonight/1.0; +https://dahab-tonight.web.app)' };
const OUT = path.join(__dirname, 'events.json');
const SEED = path.join(__dirname, 'seed.json');

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const MONTH_N = {january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};

const CATS = ['Class/Workshop','Live Music','Art/Culture','Dance','Trip','Community','Social','Sports/Fitness','Health & Wellness','Food & Drink','Other Services','Event & Class Calendar'];
const GLYPH = {
  'Class/Workshop':'\uD83E\uDDD8', 'Live Music':'\uD83C\uDFB8', 'Art/Culture':'\uD83C\uDFAC', 'Dance':'\uD83D\uDC83',
  'Trip':'\uD83C\uDFD4\uFE0F', 'Community':'\uD83D\uDD25', 'Social':'\uD83E\uDDE0', 'Sports/Fitness':'\uD83C\uDFC0',
  'Health & Wellness':'\uD83E\uDDD8', 'Food & Drink':'\uD83C\uDF7D\uFE0F', 'default':'\uD83D\uDCC5'
};
const TAGS = {
  'Class/Workshop':['Wellness'], 'Live Music':['Music','Social'], 'Art/Culture':['Culture','Social'],
  'Dance':['Movement','Social'], 'Trip':['Outdoors'], 'Community':['Social'], 'Social':['Social'],
  'Sports/Fitness':['Movement'], 'Health & Wellness':['Wellness'], 'Food & Drink':['Social'], 'default':['Social']
};

const pad = n => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try { return await fetch(url, { headers: UA, signal: ctl.signal, redirect: 'follow' }); }
  finally { clearTimeout(t); }
}
const strip = html => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#8217;|&#039;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
  .replace(/\s+/g, ' ').trim();

function classify(text) {
  for (const c of CATS) if (text.includes(c) && c !== 'Event & Class Calendar') return c;
  return 'Event';
}
function findDate(text) {
  const m = text.match(new RegExp(`(${MONTHS})\\s+(\\d{1,2}),\\s+(\\d{4})(?:\\s+(\\d{1,2}):(\\d{2}))?(?:\\s*-\\s*(?:(?:${MONTHS})\\s+\\d{1,2},\\s+\\d{4}\\s+)?(\\d{1,2}):(\\d{2}))?`, 'i'));
  if (!m) return null;
  const mo = MONTH_N[m[1].toLowerCase()];
  const date = `${m[3]}-${pad(mo)}-${pad(+m[2])}`;
  let time = null, hour = 19;
  if (m[4]) { hour = +m[4]; time = `${m[4]}:${m[5]}`; if (m[6]) time += ` - ${m[6]}:${m[7]}`; }
  return { date, time, hour };
}

/* ---------- source 1: WP REST ---------- */
async function tryRest() {
  const types = ['job_listing', 'listing', 'event', 'mylisting'];
  for (const t of types) {
    try {
      const r = await get(`${BASE}/wp-json/wp/v2/${t}?per_page=50`);
      if (!r.ok) continue;
      const j = await r.json();
      if (!Array.isArray(j) || !j.length) continue;
      const out = [];
      for (const p of j) {
        const title = strip(String(p.title?.rendered || p.title || ''));
        const blob = JSON.stringify(p.meta || {}) + ' ' + strip(String(p.content?.rendered || ''));
        const d = findDate(blob);
        if (!title || !d) continue;
        const cat = classify(blob);
        out.push(mk(title, p.link, cat, d));
      }
      if (out.length) return { src: `wp-rest:${t}`, events: out };
    } catch (_) { /* probe on */ }
  }
  return null;
}

/* ---------- source 2: explore endpoint (the reliable spine) ---------- */
async function tryExplore() {
  const urls = [
    `${BASE}/explore/?type=event&sort=order-by-date`,
    `${BASE}/explore/?type=event`,
    `${BASE}/`
  ];
  for (const u of urls) {
    try {
      const r = await get(u);
      if (!r.ok) continue;
      const html = await r.text();
      const out = parseExploreHtml(html);
      if (out.length) return { src: `explore:${u.replace(BASE, '')}`, events: out };
    } catch (_) { /* probe on */ }
  }
  return null;
}

/* ---------- source 3: RSS (change detector) ---------- */
async function tryRss() {
  const urls = [`${BASE}/feed/?post_type=job_listing`, `${BASE}/feed/?post_type=listing`, `${BASE}/feed/`];
  for (const u of urls) {
    try {
      const r = await get(u);
      if (!r.ok) continue;
      const xml = await r.text();
      if (!/<rss|<feed/i.test(xml)) continue;
      const items = xml.split(/<item[\s>]/i).slice(1);
      const out = [];
      for (const it of items) {
        const link = (it.match(/<link>([^<]+)<\/link>/i) || [])[1];
        const title = strip((it.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
        if (!link || !link.includes('/listing/') || !title) continue;
        const d = findDate(strip(it));
        if (!d) continue; // RSS carries post dates, not event dates: only keep real ones
        out.push(mk(title, link.trim(), classify(strip(it)), d));
      }
      if (out.length) return { src: `rss:${u.replace(BASE, '')}`, events: out };
    } catch (_) { /* probe on */ }
  }
  return null;
}

function mk(title, url, cat, d) {
  return { t: title, cat, glyph: GLYPH[cat] || GLYPH.default, date: d.date, time: d.time, hour: d.hour,
    budget: '£', tags: TAGS[cat] || TAGS.default, url, src: 'Daily Dahab', zone: 'masbat' };
}

/* parse a page of listing HTML into dated events (exported for tests) */
function parseExploreHtml(html) {
  const rx = /href="(https:\/\/dailydahab\.com\/listing\/[^"#?]+)"/g;
  const seen = new Set(), out = [];
  let m;
  while ((m = rx.exec(html)) !== null) {
    const link = m[1];
    if (seen.has(link)) continue;
    seen.add(link);
    // start reading after the anchor tag closes, or the href attribute bleeds into the title
    const tagEnd = html.indexOf('>', rx.lastIndex);
    const from = tagEnd === -1 ? rx.lastIndex : tagEnd + 1;
    const text = strip(html.slice(from, from + 1400));
    const d = findDate(text);
    if (!d) continue;
    let title = (text.split(' - Event & Class Calendar')[0] || text).slice(0, 90).trim();
    title = title.replace(new RegExp(`\\s*(${MONTHS})\\s+\\d{1,2},\\s+\\d{4}.*$`, 'i'), '').trim();
    for (const c of CATS) title = title.split(` - ${c}`)[0];
    if (!title || title.length < 3) continue;
    out.push(mk(title, link, classify(text), d));
  }
  return out;
}

module.exports = { strip, findDate, classify, parseExploreHtml, mk };
if (require.main !== module) return;

(async () => {
  let seed = [];
  try { seed = JSON.parse(fs.readFileSync(SEED, 'utf8')); } catch (_) {}

  const result = (await tryRest()) || (await tryExplore()) || (await tryRss());
  if (!result) {
    console.error('All sources failed. Leaving events.json untouched.');
    process.exit(fs.existsSync(OUT) ? 0 : 1);
  }
  console.log(`source: ${result.src} -> ${result.events.length} dated events`);

  // enrich from seed (covers, coords, price, host, real descriptions)
  const byUrl = new Map(seed.map(e => [e.url, e]));
  const merged = result.events.map(e => {
    const s = byUrl.get(e.url);
    if (!s) return e;
    return Object.assign({}, e, {
      cover: s.cover || e.cover, desc: s.desc || e.desc, loc: s.loc, coords: s.coords,
      price: s.price, host: s.host, contact: s.contact, zone: s.zone || e.zone,
      tags: s.tags && s.tags.length ? s.tags : e.tags, glyph: s.glyph || e.glyph, budget: s.budget || e.budget
    });
  });

  // keep seed-only entries that are still upcoming, then drop the past
  const have = new Set(merged.map(e => e.url));
  for (const s of seed) if (s.url && !have.has(s.url)) merged.push(s);
  const t = todayStr();
  const fresh = merged.filter(e => !e.date || e.date >= t)
                      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  if (!fresh.length) { console.error('Nothing upcoming. Keeping previous events.json.'); process.exit(0); }

  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const next = JSON.stringify(fresh, null, 0);
  if (prev === next) { console.log('No change.'); process.exit(0); }
  fs.writeFileSync(OUT, next);
  console.log(`wrote events.json: ${fresh.length} upcoming events`);
})();
