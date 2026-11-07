const crypto = require('crypto');
const { TTLCache } = require('./cache');

// Stremio stops paging on a short response. Source pages are smaller (currently
// nine ABB books), so retain a stable, deduplicated cursor across source pages.
function createCatalogPager(fetchPage) {
  const searches = new TTLCache(5 * 60 * 1000, 30);
  return async (cfg, query, skip = 0) => {
    const key = crypto.createHash('sha256').update(JSON.stringify([cfg, query])).digest('hex');
    let state = searches.get(key);
    if (!state) {
      state = { items: [], seen: new Set(), next: 1, done: false, pending: Promise.resolve() };
      searches.set(key, state);
    }
    const fill = async () => {
      while (!state.done && state.items.length < skip + 100) {
        const rows = await fetchPage(cfg, query, state.next);
        for (const row of rows) {
          const id = row.infohash || row.magnet || row.name;
          if (!state.seen.has(id)) {
            state.seen.add(id);
            state.items.push(row);
          }
        }
        state.next++;
        state.done = rows.hasMore !== true;
        if (rows.partial) searches.set(key, state, 30 * 1000);
      }
      return state.items.slice(skip, skip + 100);
    };
    // Concurrent catalog requests share the cursor instead of fetching the
    // same page twice. A failed fetch keeps the cursor available for retry.
    const result = state.pending.then(fill);
    state.pending = result.catch(() => {});
    return result;
  };
}

module.exports = { createCatalogPager };
