'use strict';

const FORMATS = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg', lossy: true },
  png: { mime: 'image/png', ext: 'png', lossy: false },
  webp: { mime: 'image/webp', ext: 'webp', lossy: true },
};
const DEFAULTS = { format: 'jpeg', size: '1280', custom: 1280, quality: 85 };
const SIZE_VALUES = ['640', '1280', '1920', '2560', 'original', 'custom'];
const STORAGE_KEY = 'image-resize:settings';
const IMAGE_NAME = /\.(jpe?g|jfif|png|gif|webp|bmp|ico|avif|heic|heif|tiff?)$/i;
const HEIC_NAME = /\.(heic|heif)$/i;
const PARALLEL = 2;
const THUMB_PX = 112;

const $ = (selector) => document.querySelector(selector);
const el = {
  drop: $('#drop'),
  input: $('#file-input'),
  results: $('#results'),
  list: $('#list'),
  summary: $('#summary'),
  progressWrap: $('#progress-wrap'),
  progress: $('#progress'),
  zip: $('#save-zip'),
  folder: $('#save-folder'),
  clear: $('#clear'),
  quality: $('#quality'),
  qualityOut: $('#quality-out'),
  qualityField: $('#quality-field'),
  custom: $('#custom-size'),
  customWrap: $('#custom-wrap'),
  reset: $('#reset'),
  toast: $('#toast'),
};

const canEncodeWebp = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  return c.toDataURL('image/webp').startsWith('data:image/webp');
})();

const settings = loadSettings();
const items = [];
let queue = [];
let running = 0;

/* ---------- Settings ---------- */

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch { /* storage blocked or corrupt: use defaults */ }
  const s = { ...DEFAULTS, ...saved };
  if (!FORMATS[s.format] || (s.format === 'webp' && !canEncodeWebp)) s.format = DEFAULTS.format;
  if (!SIZE_VALUES.includes(String(s.size))) s.size = DEFAULTS.size;
  s.size = String(s.size);
  s.custom = clamp(Math.round(Number(s.custom)) || DEFAULTS.custom, 16, 16384);
  s.quality = clamp(Math.round(Number(s.quality)) || DEFAULTS.quality, 40, 100);
  return s;
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* not persisted; still works for this visit */ }
}

function isDefault() {
  return Object.keys(DEFAULTS).every((k) => String(settings[k]) === String(DEFAULTS[k]));
}

function syncSettingsUI() {
  for (const group of document.querySelectorAll('.seg[data-setting]')) {
    const value = String(settings[group.dataset.setting]);
    for (const btn of group.querySelectorAll('button')) {
      const on = btn.dataset.value === value;
      btn.setAttribute('aria-checked', String(on));
      btn.tabIndex = on ? 0 : -1;
    }
  }
  el.customWrap.hidden = settings.size !== 'custom';
  el.custom.value = settings.custom;
  el.quality.value = settings.quality;
  el.qualityOut.textContent = settings.quality;
  const lossy = FORMATS[settings.format].lossy;
  el.quality.disabled = !lossy;
  el.qualityField.classList.toggle('is-disabled', !lossy);
  el.reset.hidden = isDefault();
}

function settingsChanged() {
  saveSettings();
  syncSettingsUI();
  reconvertAll();
}

function choose(group, btn) {
  const key = group.dataset.setting;
  if (String(settings[key]) === btn.dataset.value) return;
  settings[key] = btn.dataset.value;
  settingsChanged();
  if (key === 'size' && btn.dataset.value === 'custom') el.custom.select();
}

for (const group of document.querySelectorAll('.seg[data-setting]')) {
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn && !btn.disabled) choose(group, btn);
  });
  group.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const buttons = [...group.querySelectorAll('button:not(:disabled)')];
    const next = buttons[(buttons.indexOf(document.activeElement) + step + buttons.length) % buttons.length];
    choose(group, next);
    next.focus();
  });
}

el.quality.addEventListener('input', () => {
  el.qualityOut.textContent = el.quality.value;
});
el.quality.addEventListener('change', () => {
  settings.quality = Number(el.quality.value);
  settingsChanged();
});
el.custom.addEventListener('change', () => {
  settings.custom = clamp(Math.round(Number(el.custom.value)) || DEFAULTS.custom, 16, 16384);
  settingsChanged();
});
el.reset.addEventListener('click', () => {
  Object.assign(settings, DEFAULTS);
  settingsChanged();
});

if (!canEncodeWebp) {
  const webp = $('[data-setting="format"] [data-value="webp"]');
  webp.disabled = true;
  webp.title = 'このブラウザはWebPの書き出しに対応していません';
}

/* ---------- Receiving files ---------- */

function isImage(file) {
  // Names starting with "." include macOS "._foo.jpg" companion files, which are not images.
  if (file.name.startsWith('.')) return false;
  return file.type.startsWith('image/') || IMAGE_NAME.test(file.name);
}

function isHeic(file) {
  return /image\/hei[cf]/.test(file.type) || HEIC_NAME.test(file.name);
}

function addFiles(files) {
  const images = files.filter(isImage);
  const skipped = files.length - images.length;
  if (skipped) toast(`画像ではないファイル${skipped}件は飛ばしました`);
  for (const file of images) {
    const item = { file, row: createRow(), state: 'waiting', result: null, error: '', token: null };
    item.row.remove.addEventListener('click', () => removeItem(item));
    items.push(item);
    el.list.append(item.row.root);
    schedule(item);
  }
  updateSummary();
}

async function collectDropped(dt) {
  // Entries must be read before the first await: the DataTransfer is emptied once the drop handler returns.
  const entries = [...dt.items].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.() ?? null);
  const plain = [...dt.files];
  if (!entries.length || entries.includes(null)) return plain;
  const files = [];
  for (const entry of entries) await walk(entry, files);
  return files;
}

async function walk(entry, out) {
  if (entry.isFile) {
    out.push(await new Promise((resolve, reject) => entry.file(resolve, reject)));
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  const children = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    children.push(...batch);
  }
  children.sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
  for (const child of children) await walk(child, out);
}

function hasFiles(e) {
  return Boolean(e.dataTransfer) && [...e.dataTransfer.types].includes('Files');
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  collectDropped(e.dataTransfer)
    .then(addFiles)
    .catch(() => toast('ファイルを受け取れませんでした。もう一度お試しください'));
});

el.drop.addEventListener('click', () => el.input.click());
el.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    el.input.click();
  }
});
el.input.addEventListener('change', () => {
  addFiles([...el.input.files]);
  el.input.value = '';
});

document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});

/* ---------- Conversion queue ---------- */

function schedule(item) {
  // A fresh token marks older in-flight runs for this item as stale.
  item.token = {};
  item.state = 'waiting';
  render(item);
  queue.push(item);
  pump();
}

function pump() {
  while (running < PARALLEL && queue.length) {
    const item = queue.shift();
    running++;
    run(item).finally(() => {
      running--;
      pump();
      updateSummary();
    });
  }
}

async function run(item) {
  const token = item.token;
  if (!token) return;
  item.state = 'working';
  render(item);
  try {
    const result = await convert(item.file, { ...settings });
    if (item.token !== token) return;
    dropResult(item);
    item.result = {
      ...result,
      url: URL.createObjectURL(result.blob),
      thumbUrl: URL.createObjectURL(result.thumb),
    };
    item.state = 'done';
  } catch (err) {
    if (item.token !== token) return;
    dropResult(item);
    item.error = err instanceof Error && err.message ? err.message : 'この画像は変換できませんでした';
    item.state = 'error';
  }
  render(item);
}

function reconvertAll() {
  if (!items.length) return;
  queue = [];
  for (const item of items) schedule(item);
  updateSummary();
}

function dropResult(item) {
  if (!item.result) return;
  URL.revokeObjectURL(item.result.url);
  URL.revokeObjectURL(item.result.thumbUrl);
  item.result = null;
}

function removeItem(item) {
  item.token = null;
  dropResult(item);
  items.splice(items.indexOf(item), 1);
  queue = queue.filter((i) => i !== item);
  item.row.root.remove();
  updateSummary();
}

el.clear.addEventListener('click', () => {
  for (const item of [...items]) removeItem(item);
});

/* ---------- Image processing ---------- */

async function convert(file, opts) {
  const source = await decode(file);
  try {
    const w = source.naturalWidth || source.width;
    const h = source.naturalHeight || source.height;
    if (!w || !h) throw new Error('画像の大きさを読み取れませんでした');
    const [outW, outH] = fitSize(w, h, opts);
    const format = FORMATS[opts.format];
    // JPEG has no transparency, so transparent areas become white instead of black.
    const canvas = scaleTo(source, w, h, outW, outH, format.mime === 'image/jpeg');
    try {
      const blob = await encode(canvas, format.mime, format.lossy ? opts.quality / 100 : undefined);
      const thumb = await makeThumb(canvas);
      const name = `${splitExt(file.name.normalize('NFC'))[0]}.${format.ext}`;
      return { blob, thumb, name, srcW: w, srcH: h, outW, outH };
    } finally {
      canvas.width = canvas.height = 0;
    }
  } finally {
    source.close?.();
  }
}

async function decode(file) {
  try {
    return await decodeBlob(file);
  } catch {
    if (!isHeic(file)) throw new Error('この形式の画像は読み込めませんでした');
  }
  // Only Safari decodes HEIC on its own; other browsers go through the bundled decoder.
  return decodeBlob(await heicToPng(file));
}

async function decodeBlob(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch { /* option or format unsupported here; <img> below handles both */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

let heicLoader = null;
function loadHeicDecoder() {
  heicLoader ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/heic2any.min.js';
    script.onload = () => resolve(window.heic2any);
    script.onerror = () => {
      heicLoader = null;
      reject(new Error('HEICを読むための部品を読み込めませんでした'));
    };
    document.head.append(script);
  });
  return heicLoader;
}

async function heicToPng(file) {
  const heic2any = await loadHeicDecoder();
  try {
    const out = await heic2any({ blob: file, toType: 'image/png' });
    return Array.isArray(out) ? out[0] : out;
  } catch {
    throw new Error('HEIC画像を読み込めませんでした');
  }
}

function fitSize(w, h, opts) {
  const limit = opts.size === 'original' ? Infinity : opts.size === 'custom' ? opts.custom : Number(opts.size);
  const scale = Math.min(1, limit / Math.max(w, h));
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}

function scaleTo(source, w, h, outW, outH, opaque) {
  let src = source;
  // Halve in steps first: one large downscale on a canvas skips pixels and looks jagged.
  while (w >= outW * 2 && h >= outH * 2) {
    w = Math.ceil(w / 2);
    h = Math.ceil(h / 2);
    const step = makeCanvas(w, h);
    step.getContext('2d').drawImage(src, 0, 0, w, h);
    if (src !== source) src.width = src.height = 0;
    src = step;
  }
  const canvas = makeCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  if (opaque) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, outW, outH);
  }
  ctx.drawImage(src, 0, 0, outW, outH);
  if (src !== source) src.width = src.height = 0;
  return canvas;
}

function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return canvas;
}

function encode(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob && blob.type === mime) resolve(blob);
      else reject(new Error('書き出しに失敗しました'));
    }, mime, quality);
  });
}

async function makeThumb(canvas) {
  const scale = Math.min(1, THUMB_PX / Math.max(canvas.width, canvas.height));
  const t = makeCanvas(Math.max(1, Math.round(canvas.width * scale)), Math.max(1, Math.round(canvas.height * scale)));
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  try {
    return await encode(t, 'image/png');
  } finally {
    t.width = t.height = 0;
  }
}

/* ---------- List ---------- */

function createRow() {
  const root = document.createElement('li');
  root.className = 'item';
  root.innerHTML = `
    <div class="thumb"><img alt=""></div>
    <div class="info"><p class="name"></p><p class="meta"></p></div>
    <div class="row-actions">
      <a class="btn small" hidden>保存</a>
      <button type="button" class="icon-btn" aria-label="一覧から外す" title="一覧から外す">
        <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12"/></svg>
      </button>
    </div>`;
  return {
    root,
    img: root.querySelector('img'),
    name: root.querySelector('.name'),
    meta: root.querySelector('.meta'),
    save: root.querySelector('a'),
    remove: root.querySelector('button'),
  };
}

function render(item) {
  const { row, result } = item;
  row.root.dataset.state = item.state;
  row.name.textContent = item.file.name;
  row.name.title = item.file.name;

  if (result) row.img.src = result.thumbUrl;
  else row.img.removeAttribute('src');

  row.save.hidden = item.state !== 'done';
  if (item.state === 'done') {
    row.save.href = result.url;
    row.save.download = result.name;
    row.save.title = `${result.name} として保存`;
    const same = result.srcW === result.outW && result.srcH === result.outH;
    row.meta.replaceChildren(
      same
        ? `${result.outW}×${result.outH}（大きさはそのまま）`
        : `${result.srcW}×${result.srcH}`,
      ...(same ? [] : [arrow(), `${result.outW}×${result.outH}`]),
      '　',
      formatBytes(item.file.size),
      arrow(),
      `${formatBytes(result.blob.size)}（${result.name}）`,
    );
  } else if (item.state === 'error') {
    row.meta.textContent = item.error;
  } else {
    row.meta.textContent = item.state === 'working' ? '変換しています…' : '順番を待っています…';
  }
}

function arrow() {
  const span = document.createElement('span');
  span.className = 'arrow';
  span.textContent = '→';
  return span;
}

function doneItems() {
  return items.filter((i) => i.state === 'done');
}

function updateSummary() {
  const total = items.length;
  const done = doneItems();
  const failed = items.filter((i) => i.state === 'error').length;
  const pending = total - done.length - failed;

  el.results.hidden = total === 0;
  document.body.classList.toggle('has-items', total > 0);
  el.progressWrap.hidden = pending === 0;
  el.progress.style.width = total ? `${((total - pending) / total) * 100}%` : '0';

  const parts = [];
  if (pending) {
    parts.push(strong(`変換しています… ${total - pending} / ${total}枚`));
  } else if (done.length) {
    const before = done.reduce((s, i) => s + i.file.size, 0);
    const after = done.reduce((s, i) => s + i.result.blob.size, 0);
    parts.push(strong(`${done.length}枚 変換しました`), span('sub', `合計 ${formatBytes(before)} → ${formatBytes(after)}`));
  }
  if (failed) parts.push(span('bad', `${failed}枚は変換できませんでした`));
  el.summary.replaceChildren(...parts);

  const ready = pending === 0 && done.length > 0;
  el.zip.disabled = el.folder.disabled = !ready;
  el.zip.textContent = done.length === 1 ? '保存' : 'まとめて保存（ZIP）';
}

function strong(text) {
  const s = document.createElement('strong');
  s.textContent = text;
  return s;
}

function span(className, text) {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}

/* ---------- Saving ---------- */

el.zip.addEventListener('click', async () => {
  const files = uniqueNames(doneItems());
  if (!files.length) return;
  if (files.length === 1) {
    download(files[0].blob, files[0].name);
    return;
  }
  el.zip.disabled = true;
  try {
    download(await makeZip(files), `変換画像_${stamp()}.zip`);
  } catch {
    toast('ZIPを作れませんでした。枚数を減らしてお試しください');
  } finally {
    updateSummary();
  }
});

el.folder.hidden = typeof window.showDirectoryPicker !== 'function';
el.folder.addEventListener('click', async () => {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'image-resize', mode: 'readwrite' });
  } catch (err) {
    if (err.name !== 'AbortError') toast('このフォルダには保存できません。別のフォルダを選んでください');
    return;
  }
  const files = uniqueNames(doneItems());
  let saved = 0;
  el.folder.disabled = true;
  try {
    for (const f of files) {
      const handle = await dir.getFileHandle(await freeName(dir, f.name), { create: true });
      const writable = await handle.createWritable();
      await writable.write(f.blob);
      await writable.close();
      saved++;
    }
    toast(`${saved}枚を「${dir.name}」に保存しました`);
  } catch {
    toast(saved ? `${saved}枚まで保存したところで止まりました` : '保存できませんでした');
  } finally {
    updateSummary();
  }
});

// Picks "name 2.jpg", "name 3.jpg", ... so files already in the folder are never overwritten.
async function freeName(dir, name) {
  const [base, ext] = splitExt(name);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${base} ${n}${ext}`;
    try {
      await dir.getFileHandle(candidate);
    } catch (err) {
      if (err.name === 'NotFoundError') return candidate;
      if (err.name !== 'TypeMismatchError') throw err;
    }
  }
}

// Same-named outputs (e.g. photo.png and photo.heic) get " 2", " 3"... Windows ignores case, so compare lowercased.
function uniqueNames(list) {
  const used = new Set();
  return list.map((item) => {
    const [base, ext] = splitExt(item.result.name);
    let name = item.result.name;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}${ext}`;
    used.add(name.toLowerCase());
    return { name, blob: item.result.blob };
  });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/* ---------- ZIP (stored, no compression: JPEG/PNG/WebP are already compressed) ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function makeZip(files) {
  const encoder = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const UTF8_NAMES = 0x0800; // tells Windows/Mac unzip tools the names are UTF-8, so Japanese names don't garble
  const body = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = encoder.encode(f.name);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_NAMES, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    body.push(local, name, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, UTF8_NAMES, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(entry, name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = central.reduce((s, part) => s + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...body, ...central, end], { type: 'application/zip' });
}

/* ---------- Helpers ---------- */

function splitExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

let toastTimer = 0;
function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3500);
}

syncSettingsUI();
updateSummary();
