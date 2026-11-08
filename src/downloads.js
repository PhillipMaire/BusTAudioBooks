const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { TTLCache } = require('./cache');

function installDownloads(app, { getConfig, resolveForItem, decodeItemId }) {
  // Only resolve server-issued file links. Never accept a target URL from the client.
  const tickets = new TTLCache(15 * 60 * 1000, 100);
  app.post('/api/download', async (req, res) => {
    const cfg = getConfig(req, res);
    if (!cfg) return;
    const item = decodeItemId(req.body?.id);
    const index = req.body?.index;
    if (!item || item.legacyComic || !Number.isInteger(index) || index < 0) {
      return res.status(400).json({ error: 'Choose a valid audio file.' });
    }
    try {
      const result = await resolveForItem(cfg, item);
      if (!result.ready) return res.status(409).json({ error: result.status || 'TorBox is preparing this book. Check again shortly.' });
      const file = result.streams?.[index];
      if (!file || !/^https:\/\//i.test(file.url)) return res.status(400).json({ error: 'That audio file is unavailable.' });
      const raw = file.behaviorHints?.filename || file.title || item.name || 'audiobook';
      const filename = String(raw).split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'audiobook';
      const ticket = crypto.randomBytes(32).toString('hex');
      tickets.set(ticket, { url: file.url, filename });
      res.json({ url: '/api/download/' + ticket, filename });
    } catch (_) { res.status(502).json({ error: 'Could not prepare the download. Check TorBox and try again.' }); }
  });
  app.get('/api/download/:ticket', async (req, res) => {
    const file = tickets.get(req.params.ticket);
    if (!file) return res.status(410).json({ error: 'Download link expired. Choose Download again.' });
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on('close', abort);
    // Timeout only the response headers, not a long audiobook transfer.
    const timer = setTimeout(abort, 30000);
    try {
      const range = req.headers.range;
      const headers = /^bytes=\d*-\d*$/.test(range || '') ? { Range: range } : {};
      const upstream = await fetch(file.url, { signal: controller.signal, headers });
      clearTimeout(timer);
      if (![200, 206].includes(upstream.status) || !upstream.body) throw new Error('File unavailable');
      res.status(upstream.status);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/[^a-zA-Z0-9._ -]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/'/g, '%27')}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      for (const header of ['content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      // Backpressure keeps transfers in bounded memory. No temp file touches the SD card.
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (_) {
      if (!res.headersSent && !res.destroyed) res.status(502).json({ error: 'Download unavailable. Generate a fresh link and retry.' });
      else res.destroy();
    } finally { clearTimeout(timer); res.off('close', abort); }
  });
}
module.exports = { installDownloads };
