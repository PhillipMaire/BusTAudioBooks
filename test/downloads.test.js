const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../src/index');
const torbox = require('../src/torbox');
const { encodeItemId } = require('../src/itemid');
const realFetch = global.fetch;

test('downloads stream attachments with ranges, reject arbitrary URLs, and keep keys out of links', async () => {
  const resolve = torbox.resolveStreams;
  let resolutionCalls = 0, fetched = 0;
  torbox.resolveStreams = async (key) => {
    assert.equal(key, 'fixture-download-key'); resolutionCalls++;
    return { ready: true, streams: [{ url: 'https://cdn.example.test/audio', title: 'Book', behaviorHints: { filename: 'Bóok "one".mp3' } }] };
  };
  global.fetch = async (url, init) => {
    assert.equal(url, 'https://cdn.example.test/audio'); fetched++;
    const range = init.headers.Range;
    return new Response(range ? 'part' : 'fixture-audio-bytes', { status: range ? 206 : 200,
      headers: range ? { 'Content-Range': 'bytes 0-3/19', 'Content-Length': '4' } : { 'Content-Length': '19' } });
  };
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => realFetch(base + '/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const id = encodeItemId({ name: 'Download book', infohash: 'd'.repeat(40) });
  try {
    assert.equal((await post({ config: {}, id, index: 0 })).status, 400);
    assert.equal((await post({ config: { apiKey: 'fixture-download-key' }, id, index: -1 })).status, 400);
    assert.equal((await post({ config: { apiKey: 'fixture-download-key' }, id, index: '0' })).status, 400);
    const ready = await post({ config: { apiKey: 'fixture-download-key' }, id, index: 0, url: 'http://127.0.0.1/secret' });
    assert.equal(ready.status, 200);
    const { url } = await ready.json(); assert.match(url, /^\/api\/download\/[a-f0-9]{64}$/); assert.ok(!url.includes('fixture-download-key'));
    const download = await realFetch(base + url);
    assert.equal(download.status, 200); assert.equal(await download.text(), 'fixture-audio-bytes');
    assert.match(download.headers.get('content-disposition'), /^attachment;/);
    assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''B%C3%B3ok/);
    assert.equal(download.headers.get('cache-control'), 'no-store');
    const partial = await realFetch(base + url, { headers: { Range: 'bytes=0-3' } });
    assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), 'bytes 0-3/19');
    assert.equal(await partial.text(), 'part'); assert.equal(fetched, 2);
    assert.equal((await realFetch(base + '/api/download/' + '0'.repeat(64))).status, 410);
    assert.equal((await post({ config: { apiKey: 'fixture-download-key' }, id, index: 99 })).status, 400);
    assert.equal(resolutionCalls, 1, 'Downloads reuse existing TorBox resolution, including repeat downloads');
  } finally { global.fetch = realFetch; torbox.resolveStreams = resolve; await new Promise(r => server.close(r)); }
});

test('unready TorBox items cannot issue a download ticket', async () => {
  const resolve = torbox.resolveStreams;
  torbox.resolveStreams = async () => ({ ready: false, streams: [], status: 'Still preparing' });
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  try {
    const response = await realFetch(`http://127.0.0.1:${server.address().port}/api/download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { apiKey: 'fixture-key' }, id: encodeItemId({ name: 'Waiting book', infohash: 'e'.repeat(40) }), index: 0 }) });
    assert.equal(response.status, 409); assert.equal((await response.json()).error, 'Still preparing');
  } finally { torbox.resolveStreams = resolve; await new Promise(r => server.close(r)); }
});
