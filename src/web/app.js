'use strict';
const $ = id => document.getElementById(id);
let page = 1, query = '', busy = false, seen = new Set(), count = 0, currentBook = null, files = [], searchConfig = null;
let activeFile = '', lastSaved = 0, playGeneration = 0, downloadMode = false;
const config = () => ({ apiKey: $('api-key').value.trim(), token: $('token').value.trim(),
  instantOnly: $('instant-only').checked, sources: [...$('sources').querySelectorAll('input:checked')].map(el => el.value) });
function keyChanged() { $('key-state').textContent = $('api-key').value.trim() ? '· key ready in this tab' : '· add your key to play'; }
$('api-key').addEventListener('input', keyChanged);
$('import-link').addEventListener('click', () => {
  try {
    const url = new URL($('install-link').value.trim().replace(/^stremio:/, 'https:'));
    const segment = url.pathname.split('/').find(Boolean);
    const encoded = segment.replace(/-/g, '+').replace(/_/g, '/');
    const cfg = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0))));
    if (typeof cfg.apiKey !== 'string' || !cfg.apiKey) throw new Error('Missing key');
    $('api-key').value = cfg.apiKey;
    if (typeof cfg.token === 'string') $('token').value = cfg.token;
    $('install-link').value = '';
    keyChanged(); $('connection').open = false;
    $('status').textContent = 'TorBox key loaded. All public sources are selected.';
  } catch (_) { $('status').textContent = 'That link could not be read. Paste the full BusTAudio manifest link or enter your TorBox API key.'; }
});
async function api(path, body) {
  const response = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(120000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.err || data.status || 'Request failed');
  return data;
}
function sourceStatus(sources) {
  $('source-status').replaceChildren(...sources.map(source => {
    const el = document.createElement('span');
    el.textContent = source.name + ': ' + (source.status === 'ok' ? source.count + ' this page' : 'unavailable');
    return el;
  }));
}
function renderBook(book) {
  const identity = book.infohash || book.id;
  if (seen.has(identity)) return;
  seen.add(identity); count++;
  const row = document.createElement('article'), icon = document.createElement('div'), copy = document.createElement('div');
  icon.className = 'book-icon'; icon.textContent = '♫'; copy.className = 'book-copy';
  const title = document.createElement('h3'), subtitle = document.createElement('p'), play = document.createElement('button');
  title.textContent = book.title;
  subtitle.textContent = [book.cached ? '⚡ Cached on TorBox' : 'TorBox cache not confirmed', book.source, book.format, book.sizeText, book.seeders + ' seeders'].filter(Boolean).join(' · ');
  play.type = 'button'; play.textContent = 'Listen'; play.addEventListener('click', () => playBook(book));
  const download = document.createElement('button');
  download.type = 'button'; download.className = 'secondary'; download.textContent = 'Download';
  download.addEventListener('click', () => playBook(book, true));
  const actions = document.createElement('div'); actions.className = 'book-actions'; actions.append(play, download);
  copy.append(title, subtitle); row.append(icon, copy, actions); $('results').append(row);
}
async function search(more = false) {
  if (busy) return;
  if (!more) {
    query = $('query').value.trim(); page = 1; count = 0; seen = new Set(); searchConfig = config();
    if (!query) return;
    if (!searchConfig.sources.length) { $('status').textContent = 'Choose at least one source.'; return; }
    if (searchConfig.instantOnly && !searchConfig.apiKey) { $('status').textContent = 'Add your TorBox key to check cached results.'; $('connection').open = true; return; }
    $('results').replaceChildren(); $('source-status').replaceChildren();
  }
  busy = true; $('search').disabled = true; $('more').disabled = true;
  $('status').textContent = 'Searching sources…';
  try {
    const data = await api('search', { config: searchConfig, q: query, page });
    data.results.forEach(renderBook); sourceStatus(data.sources || []);
    $('more').hidden = !data.hasMore; page++;
    $('status').textContent = count + ' unique results for “' + query + '”' + (data.hasMore ? ' · more available below' : '') + (data.partial ? ' · some sources are unavailable' : '') + '.';
  } catch (err) { $('status').textContent = err.message; }
  finally { busy = false; $('search').disabled = false; $('more').disabled = false; }
}
$('search-form').addEventListener('submit', event => { event.preventDefault(); search(false); });
$('more').addEventListener('click', () => search(true));
function saveProgress() {
  if (!activeFile || !$('audio').currentTime) return;
  try { localStorage.setItem('bustaudio-progress:' + activeFile, String($('audio').currentTime)); } catch (_) { /* storage may be disabled */ }
}
function chooseFile(index) {
  saveProgress(); const file = files[index]; if (!file) return;
  activeFile = currentBook.id + ':' + index;
  $('audio').src = file.url; $('audio').playbackRate = Number($('speed').value);
  $('download').href = file.url; $('parts').value = String(index);
  $('audio').load();
  if (!downloadMode) $('audio').play().catch(() => { $('playback-status').textContent = 'Ready. Press play to start listening.'; });
}
async function playBook(book, forDownload = false) {
  const cfg = config();
  if (!cfg.apiKey) { $('connection').open = true; $('api-key').focus(); $('status').textContent = 'Add your TorBox key above, then choose Listen or Download again.'; return; }
  saveProgress(); $('audio').pause(); currentBook = book; downloadMode = forDownload;
  const generation = ++playGeneration;
  $('save-file').disabled = true; $('download-status').textContent = ''; $('download-files').replaceChildren(); $('download-files').hidden = true;
  $('playback').hidden = false; $('book-title').textContent = book.title;
  $('playback-status').textContent = 'Asking TorBox for playable files…'; $('retry').hidden = true;
  $('parts-label').hidden = true; $('audio').removeAttribute('src'); $('audio').load(); $('download').removeAttribute('href'); activeFile = '';
  try {
    const data = await api('streams', { config: cfg, id: book.id });
    if (generation !== playGeneration) return;
    files = (data.streams || []).filter(file => /^https:\/\//i.test(file.url));
    if (!data.ready || !files.length) {
      $('playback-status').textContent = data.status || 'TorBox is preparing this book. Check again shortly.';
      $('retry').hidden = false; return;
    }
    $('parts').replaceChildren(...files.map((file, i) => { const option = document.createElement('option'); option.value = i; option.textContent = file.filename || file.title || 'Part ' + (i + 1); return option; }));
    $('parts-label').hidden = files.length < 2;
    $('playback-status').textContent = files.length + ' audio file' + (files.length === 1 ? '' : 's') + ' ready from TorBox.';
    $('save-file').disabled = false;
    if (files.length > 1) {
      $('download-files').hidden = false;
      for (let i = 0; i < files.length; i++) {
        const row = document.createElement('div'), label = document.createElement('span'), button = document.createElement('button');
        row.className = 'file-row'; label.textContent = files[i].filename || files[i].title || 'Part ' + (i + 1);
        button.type = 'button'; button.textContent = 'Download'; button.addEventListener('click', () => downloadFile(i, button));
        row.append(label, button); $('download-files').append(row);
      }
    }
    chooseFile(0);
    if (forDownload && files.length === 1) await downloadFile(0, $('save-file'));
    else if (forDownload) $('download-status').textContent = 'This release has ' + files.length + ' files. Choose the file(s) you want to save below.';
  } catch (err) { if (generation === playGeneration) { $('playback-status').textContent = err.message; $('retry').hidden = false; } }
}
$('retry').addEventListener('click', () => currentBook && playBook(currentBook, downloadMode));
async function downloadFile(index, button) {
  const book = currentBook;
  if (!book || !files[index]) return;
  button.disabled = true;
  $('download-status').textContent = 'Preparing download…';
  try {
    const data = await api('download', { config: config(), id: book.id, index });
    if (!/^\/api\/download\/[a-f0-9]{64}$/.test(data.url)) throw new Error('Invalid download link');
    const link = document.createElement('a'); link.href = data.url; link.download = data.filename || 'audiobook';
    link.hidden = true; document.body.append(link); link.click(); link.remove();
    $('download-status').textContent = 'Download started. Check your browser’s downloads.';
  } catch (err) { $('download-status').textContent = err.message; }
  finally { button.disabled = false; }
}
$('save-file').addEventListener('click', () => downloadFile(Number($('parts').value), $('save-file')));
$('parts').addEventListener('change', () => chooseFile(Number($('parts').value)));
$('speed').addEventListener('change', () => { $('audio').playbackRate = Number($('speed').value); });
$('back').addEventListener('click', () => { $('audio').currentTime = Math.max(0, $('audio').currentTime - 30); });
$('forward').addEventListener('click', () => { if (Number.isFinite($('audio').duration)) $('audio').currentTime = Math.min($('audio').duration, $('audio').currentTime + 30); });
$('close-player').addEventListener('click', () => { saveProgress(); ++playGeneration; $('audio').pause(); $('playback').hidden = true; });
$('audio').addEventListener('loadedmetadata', () => {
  try { const position = Number(localStorage.getItem('bustaudio-progress:' + activeFile)); if (position > 0 && position < $('audio').duration - 5) $('audio').currentTime = position; } catch (_) { /* optional progress */ }
});
$('audio').addEventListener('timeupdate', () => { if (Date.now() - lastSaved > 5000) { saveProgress(); lastSaved = Date.now(); } });
$('audio').addEventListener('pause', saveProgress);
$('audio').addEventListener('ended', () => { try { localStorage.removeItem('bustaudio-progress:' + activeFile); } catch (_) {} activeFile = ''; const next = Number($('parts').value) + 1; if (next < files.length) chooseFile(next); });
$('audio').addEventListener('error', () => { $('playback-status').textContent = 'This file could not play in your browser. Try Download file or Open in audio player, or check TorBox again for a fresh link.'; $('retry').hidden = false; });
window.addEventListener('pagehide', saveProgress);
fetch('/api/sources').then(r => r.json()).then(data => {
  for (const source of data.sources) { const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.value = source.id; input.checked = true; label.append(input, document.createTextNode(source.name)); $('sources').append(label); }
  $('token-label').hidden = !data.requireToken;
  $('status').textContent = 'All ' + data.sources.length + ' public sources selected. Search first; add your TorBox key when you’re ready to listen.';
}).catch(() => { $('status').textContent = 'Could not load sources. Reload to try again.'; });
