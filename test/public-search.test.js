const test = require('node:test');
const assert = require('node:assert/strict');
const { searchAudiobooks } = require('../src/sources');
const { searchPublic, enabledSources } = require('../src/publicSources');
const torbox = require('../src/torbox');
const { app } = require('../src/index');
const { encodeItemId } = require('../src/itemid');
const realFetch = global.fetch;
const hash = n => n.toString(16).padStart(40, '0');
function json(data) { return { ok: true, status: 200, json: async () => data }; }
function mockSearch() {
  const calls = [];
  global.fetch = async (url, init) => {
    const u = new URL(url); calls.push({ u, init });
    if (u.hostname === 'api.knaben.org') {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.categories, [1003000]); assert.equal(body.size, 100);
      assert.equal(body.hide_xxx, true);
      const start = body.from;
      return json({ total: { value: 225 }, hits: Array.from({ length: Math.min(100, 225 - start) }, (_, n) => ({
        title: 'Book ' + (start + n), hash: hash(start + n + 1).toUpperCase(), categoryId: [1003000], tracker: 'Fixture tracker', seeders: 5,
      })) });
    }
    if (u.hostname === 'apibay.org') return json([
      { name: 'Duplicate', info_hash: hash(1), category: '102', seeders: 10 },
      { name: 'Distinct audiobook', info_hash: hash(500), category: '102' },
      { name: 'Movie', info_hash: hash(501), category: '201' },
      { name: 'No results', info_hash: '0', category: '0' },
    ]);
    if (u.hostname === 'torrents-csv.com') return json({ torrents: [
      { name: 'Extra audiobook M4B', infohash: hash(600), size_bytes: 10000 },
      { name: 'Book movie 1080p', infohash: hash(601) },
    ] });
    throw new Error('Unexpected external call: ' + u.hostname);
  };
  return calls;
}
async function withEnvironment(run) {
  const old = { PUBLIC_SOURCES: process.env.PUBLIC_SOURCES, ABB_ENABLED: process.env.ABB_ENABLED };
  process.env.PUBLIC_SOURCES = 'knaben,tpb,torrentscsv'; process.env.ABB_ENABLED = '0';
  try { await run(); } finally { global.fetch = realFetch; for (const [k,v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('all public sources combine, filter audiobook categories, dedupe hashes, and walk 225 source results', async () => withEnvironment(async () => {
  const calls = mockSearch(), all = [];
  for (let page = 1; page <= 3; page++) {
    const rows = await searchAudiobooks({ abbDomain: 'must-not-contact.test' }, 'combined-fixture', page);
    all.push(...rows);
    assert.equal(rows.hasMore, page < 3);
    assert.equal(rows.partial, false);
    assert.equal(rows.statuses.length, 3);
  }
  assert.equal(all.length, 227);
  assert.equal(new Set(all.map(r => r.infohash)).size, 227);
  assert.deepEqual(calls.filter(c => c.u.hostname === 'api.knaben.org').map(c => JSON.parse(c.init.body).from), [0,100,200]);
  assert.equal(calls.filter(c => c.u.hostname === 'apibay.org').length, 1);
  assert.equal(calls.filter(c => c.u.hostname === 'torrents-csv.com').length, 1);
  assert.ok(!all.some(r => /movie/i.test(r.name)));
}));

test('partial source failures remain visible; total failure is an outage rather than empty results', async () => withEnvironment(async () => {
  global.fetch = async url => { if (String(url).includes('api.knaben')) throw new Error('offline'); return json([{ name: 'Working audio', info_hash: hash(700), category: '102' }]); };
  const partial = await searchAudiobooks({ sources: ['knaben', 'tpb'] }, 'partial-public');
  assert.equal(partial.length, 1); assert.equal(partial.partial, true);
  assert.equal(partial.statuses.find(s => s.name === 'Knaben').status, 'unavailable');
  await assert.rejects(searchAudiobooks({ sources: ['knaben'] }, 'failed-public'), { name: 'SearchUnavailableError' });
}));

test('malformed and missing hashes cannot become playable public search results', async () => withEnvironment(async () => {
  global.fetch = async () => json({ total: { value: 0 }, hits: [{ title: 'bad', hash: '0', categoryId: [1003000] }] });
  assert.equal((await searchPublic('knaben', 'invalid-hash')).length, 0);
  assert.deepEqual(enabledSources({ sources: ['unknown', 'knaben'] }), ['knaben']);
  global.fetch = async () => json({ unexpected: true });
  await assert.rejects(searchPublic('tpb', 'bad-json'), /invalid response/);
}));

test('private browser searches without a key, pages fully, and sends playback keys only in POST bodies', async () => withEnvironment(async () => {
  mockSearch();
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => realFetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const originalCached = torbox.checkCachedMany, originalResolve = torbox.resolveStreams;
  torbox.checkCachedMany = async () => { throw new Error('Browsing without key must not call TorBox'); };
  torbox.resolveStreams = async (key, item) => {
    assert.equal(key, 'fixture-private-key'); assert.equal(item.infohash, hash(800));
    return { ready: true, streams: [{ title: 'Part 1', url: 'https://audio.test/file.mp3' }] };
  };
  try {
    const response = await post('/api/search', { config: {}, q: 'browser-fixture', page: 1 });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const first = await response.json(); assert.equal(first.results.length, 102); assert.equal(first.hasMore, true); assert.equal(first.sources.length, 3);
    assert.ok(first.results.every(r => r.source));
    const second = await (await post('/api/search', { config: {}, q: 'browser-fixture', page: 2 })).json();
    assert.equal(second.results.length, 100);
    const id = encodeItemId({ name: 'Browser book', infohash: hash(800) });
    assert.equal((await post('/api/streams', { config: {}, id })).status, 400);
    const streams = await post('/api/streams', { config: { apiKey: 'fixture-private-key' }, id });
    assert.equal(streams.status, 200); assert.equal((await streams.json()).streams[0].url, 'https://audio.test/file.mp3');
    assert.equal((await post('/api/streams', { config: { apiKey: 'fixture-private-key' }, id: 'bad' })).status, 400);
    const ui = await realFetch(base + '/listen/');
    assert.match(ui.headers.get('content-type'), /text\/html/);
    assert.match(ui.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await ui.text(), /Find your next listen/);
    const js = await (await realFetch(base + '/listen/app.js')).text();
    assert.ok(!js.includes('innerHTML')); assert.ok(!js.includes('sessionStorage'));
    assert.ok(!js.includes('localStorage.setItem(\'api'));
  } finally { torbox.checkCachedMany = originalCached; torbox.resolveStreams = originalResolve; await new Promise(r => server.close(r)); }
}));
