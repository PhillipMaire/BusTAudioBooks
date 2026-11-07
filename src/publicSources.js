// Public search adapters; TorBox remains the resolver, not the search engine.
const { TTLCache } = require('./cache');
const pages = new TTLCache(5 * 60 * 1000, 100);
const PAGE_SIZE = 100;
const NAMES = { knaben: 'Knaben', tpb: 'The Pirate Bay', torrentscsv: 'Torrents.csv' };
function enabledSources(config = {}) {
  const allowed = String(process.env.PUBLIC_SOURCES || '').split(',').map(s => s.trim()).filter(s => NAMES[s]);
  return Array.isArray(config.sources) ? allowed.filter(s => config.sources.includes(s)) : allowed;
}
function normalize(r, tracker) {
  const rawHash = r.hash || r.info_hash || r.infohash || '';
  const magnet = typeof r.magnetUrl === 'string' && r.magnetUrl.startsWith('magnet:?') ? r.magnetUrl : null;
  const hash = /^[a-f0-9]{40}$/i.test(rawHash) ? rawHash.toLowerCase() : magnet?.match(/urn:btih:([a-f0-9]{40})(?:&|$)/i)?.[1]?.toLowerCase();
  if (!hash) return null;
  const name = String(r.title || r.name || '').trim();
  if (!name) return null;
  return { name, infohash: hash, magnet, size: Math.max(0, Number(r.bytes ?? r.size ?? r.size_bytes) || 0),
    seeders: Math.max(0, Number(r.seeders) || 0), tracker, format: name.match(/\b(mp3|m4b|m4a|flac|aac|opus)\b/i)?.[1]?.toUpperCase() || null };
}
async function searchPublic(source, query, page = 1) {
  const key = JSON.stringify([source, query, page]);
  const hit = pages.get(key);
  if (hit) return hit;
  if (source !== 'knaben' && page > 1) return Object.assign([], { hasMore: false });
  let url, init = {};
  if (source === 'knaben') {
    url = 'https://api.knaben.org/v1';
    init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      search_type: '100%', search_field: 'title', query, categories: [1003000],
      order_by: 'seeders', order_direction: 'desc', from: (page - 1) * PAGE_SIZE,
      size: PAGE_SIZE, hide_unsafe: true, hide_xxx: true,
    }) };
  } else if (source === 'tpb') {
    url = 'https://apibay.org/q.php?' + new URLSearchParams({ q: query, cat: '102' });
  } else if (source === 'torrentscsv') {
    url = 'https://torrents-csv.com/service/search?' + new URLSearchParams({ q: query, size: '100' });
  } else { throw new Error('Unknown public source'); }
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${NAMES[source]} HTTP ${res.status}`);
  const json = await res.json();
  const raw = source === 'knaben' ? json.hits : source === 'tpb' ? json : json.torrents;
  if (!Array.isArray(raw)) throw new Error(`${NAMES[source]} returned an invalid response`);
  const items = raw.filter(r => {
    if (source === 'tpb') return String(r.category) === '102';
    if (source === 'knaben') return Array.isArray(r.categoryId) && r.categoryId.includes(1003000);
    // This index has no categories: keep explicit audiobook releases, not films/music.
    return /audiobook|audio[ ._-]?book|\bm4b\b|unabridged|narrated[ ._-]by/i.test(r.name || '');
  }).map(r => normalize(r, source === 'knaben' ? `Knaben · ${r.tracker || r.cachedOrigin || 'indexed'}` : NAMES[source])).filter(Boolean);
  const total = Number(json.total?.value);
  const hasMore = source === 'knaben' && raw.length > 0 && (Number.isFinite(total) ? page * PAGE_SIZE < total : raw.length === PAGE_SIZE);
  return pages.set(key, Object.assign(items, { hasMore }));
}
module.exports = { enabledSources, searchPublic, NAMES };
