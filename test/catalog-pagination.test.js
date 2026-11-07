const test = require('node:test');
const assert = require('node:assert/strict');
const metadata = require('../src/metadata');
const torbox = require('../src/torbox');
metadata.enrich = async () => ({ poster: null, author: 'Fixture Author' });
const { app } = require('../src/index');
const { encodeConfig } = require('../src/config');
const { searchAudiobooks } = require('../src/sources');
const realFetch = global.fetch;
const html = body => ({ ok: true, status: 200, text: async () => body });

async function fixture({ count = 225, perPage = 9, instantOnly = false, duplicate = false }, run) {
  const originalCached = torbox.checkCachedMany;
  torbox.checkCachedMany = async (_key, hashes) => new Set(instantOnly ? hashes.filter(h => parseInt(h, 16) % 2 === 0) : []);
  const requestedPages = [];
  global.fetch = async raw => {
    const u = new URL(raw);
    assert.equal(u.hostname, 'pagination.test', 'Tests must not contact external services');
    if (u.pathname.startsWith('/abss/')) {
      const n = Number(u.pathname.split('/')[2]);
      return html(`<tr><td>Info Hash:</td><td>${(n + 1).toString(16).padStart(40, '0')}</td></tr>`);
    }
    const page = Number(u.pathname.match(/\/page\/(\d+)/)?.[1] || 1);
    requestedPages.push(page);
    const start = (page - 1) * perPage;
    let body = '';
    for (let n = start; n < Math.min(start + perPage, count); n++) {
      const id = duplicate && n === perPage ? 1 : n;
      body += `<a href="/abss/${id}/" rel="bookmark">Fixture ${id} - Author</a>`;
    }
    if (start + perPage < count) body += `<a class="next page-numbers" href="/page/${page + 1}/?s=fixture">Next</a>`;
    return html(body);
  };
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const cfg = encodeConfig({ apiKey: 'fixture-key', abbDomain: 'pagination.test', instantOnly });
  const base = `http://127.0.0.1:${server.address().port}/${cfg}`;
  const catalog = async skip => {
    const response = await realFetch(`${base}/catalog/audiobook/torbox-audiobooks-search/search=${encodeURIComponent('fixture-' + count + '-' + perPage + '-' + instantOnly + '-' + duplicate)}&skip=${skip}.json`);
    assert.equal(response.status, 200);
    return (await response.json()).metas;
  };
  try { await run({ catalog, requestedPages }); }
  finally {
    global.fetch = realFetch;
    torbox.checkCachedMany = originalCached;
    await new Promise(resolve => server.close(resolve));
  }
}

test('Stremio pages contain 100 items and do not skip nine-item source pages', async () => {
  await fixture({}, async ({ catalog, requestedPages }) => {
    const first = await catalog(0);
    assert.equal(first.length, 100, 'Short source page must not look like the end of the Stremio catalog');
    const second = await catalog(100);
    const last = await catalog(200);
    assert.equal(second.length, 100);
    assert.equal(last.length, 25);
    assert.equal(new Set([...first, ...second, ...last].map(x => x.id)).size, 225);
    assert.deepEqual(requestedPages, Array.from({ length: 25 }, (_, i) => i + 1));
    assert.deepEqual(await catalog(225), []);
    assert.deepEqual((await catalog(0)).map(x => x.id), first.map(x => x.id));
  });
});

test('instant-only and duplicate results do not prematurely end a catalog', async () => {
  await fixture({ instantOnly: true, duplicate: true }, async ({ catalog }) => {
    const first = await catalog(0);
    const rest = await catalog(100);
    assert.equal(first.length, 100);
    assert.equal(rest.length, 11);
    assert.equal(new Set([...first, ...rest].map(x => x.id)).size, 111);
  });
});

test('source pages retain all listed books instead of truncating at twelve', async () => {
  await fixture({ count: 15, perPage: 15 }, async () => {
    const rows = await searchAudiobooks({ abbDomain: 'pagination.test' }, 'source-full-page');
    assert.equal(rows.length, 15);
    assert.equal(rows.hasMore, false);
  });
});

const { createCatalogPager } = require('../src/catalog');
const rows = (start, length, hasMore) => Object.assign(
  Array.from({ length }, (_, n) => ({ infohash: String(start + n), name: 'Fixture' })), { hasMore }
);

test('concurrent catalog requests share the source cursor without duplicate fetches', async () => {
  const calls = [];
  const page = createCatalogPager(async (_cfg, _query, n) => {
    calls.push(n);
    return rows((n - 1) * 100, 100, n < 2);
  });
  const [first, second] = await Promise.all([page({}, 'concurrent', 0), page({}, 'concurrent', 100)]);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(new Set([...first, ...second].map(x => x.infohash)).size, 200);
});

test('a failed source page retries its cursor rather than caching a false catalog end', async () => {
  let fail = true;
  const calls = [];
  const page = createCatalogPager(async (_cfg, _query, n) => {
    calls.push(n);
    if (n === 2 && fail) throw new Error('Temporary source outage');
    return rows((n - 1) * 50, 50, n < 2);
  });
  await assert.rejects(page({}, 'retry'), /Temporary source outage/);
  fail = false;
  assert.equal((await page({}, 'retry')).length, 100);
  assert.deepEqual(calls, [1, 2, 2]);
});
