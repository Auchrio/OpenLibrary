
'use strict';

// ═══════════════════════════════════════════════════════════════
// CRYPTO — mirrors crypto.js / library.go parameters exactly
// ═══════════════════════════════════════════════════════════════
const CRYPTO = {
  SALT_SIZE: 16, NONCE_SIZE: 12, ITERATIONS: 100000, KEY_SIZE: 256,

  async decryptWithPassword(encryptedData, password) {
    const view = new Uint8Array(encryptedData);
    const salt  = view.slice(0, this.SALT_SIZE);
    const nonce = view.slice(this.SALT_SIZE, this.SALT_SIZE + this.NONCE_SIZE);
    const ct    = view.slice(this.SALT_SIZE + this.NONCE_SIZE);
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password),
      'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name:'PBKDF2', salt, iterations:this.ITERATIONS, hash:'SHA-256' }, km, this.KEY_SIZE);
    const key = await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name:'AES-GCM', iv:nonce }, key, ct);
    return new Uint8Array(plain);
  },

  async decryptWithKey(encryptedData, keyBuffer) {
    const view  = new Uint8Array(encryptedData);
    const nonce = view.slice(0, this.NONCE_SIZE);
    const ct    = view.slice(this.NONCE_SIZE);
    const key = await crypto.subtle.importKey('raw', keyBuffer, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name:'AES-GCM', iv:nonce }, key, ct);
    return new Uint8Array(plain);
  },

  hexToBuffer(hex) {
    const b = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) b[i/2] = parseInt(hex.substr(i,2), 16);
    return b;
  },

  formatBytes(n, d=2) {
    if (!n) return '—';
    const k=1024, s=['B','KB','MB','GB'], i=Math.floor(Math.log(n)/Math.log(k));
    return (n/k**i).toFixed(d)+' '+s[i];
  }
};

// ═══════════════════════════════════════════════════════════════
// URL hash state  —  persists library source list client-side
// ═══════════════════════════════════════════════════════════════
function b64enc(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function b64dec(str) {
  str = str.replace(/-/g,'+').replace(/_/g,'/');
  while (str.length%4) str+='=';
  return decodeURIComponent(escape(atob(str)));
}
function loadSources() {
  const h = location.hash.slice(1);
  if (!h) return [];
  try { return JSON.parse(b64dec(h)); } catch { return []; }
}
function saveSources(arr) {
  history.replaceState(null,'','#'+b64enc(JSON.stringify(arr)));
}

// ═══════════════════════════════════════════════════════════════
// Library loader
// ═══════════════════════════════════════════════════════════════
// state.sources  = [{url, name}]
// state.libs     = Map<url, {lib.json obj, books: Map<id, entry>}>
// state.books    = [] (flat sorted/filtered view)
const state = {
  sources: loadSources(),
  libs: new Map(),     // url → {name, encryption_type, links, books: Map}
  books: [],           // all books flat
  filtered: [],        // after search+sort
  page: 1,
  perPage: 20,
  search: '',
  sort: 'series',
  coverCache: new Map() // bookId → objectURL
};

function normaliseUrl(url) {
  return url.trim().replace(/\/+$/, '');
}

async function fetchLib(url) {
  const res = await fetch(url+'/lib.json', { cache:'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function decryptIndex(lib, password) {
  const raw = atob(lib.index);
  const buf = new Uint8Array(raw.length);
  for (let i=0;i<raw.length;i++) buf[i]=raw.charCodeAt(i);
  const plain = await CRYPTO.decryptWithPassword(buf.buffer, password||'0');
  return JSON.parse(new TextDecoder().decode(plain));
}

async function loadLibrary(url) {
  url = normaliseUrl(url);
  const libJson = await fetchLib(url);
  const password = libJson.encryption_type === 0 ? '0' : null;
  if (password === null) throw new Error('Encryption type 1 requires a key (not yet supported in UI)');
  const books = await decryptIndex(libJson, password);
  const bookMap = new Map(Object.entries(books));
  state.libs.set(url, {
    name: libJson.name || url,
    encryption_type: libJson.encryption_type,
    links: libJson.links || {},
    books: bookMap
  });
  rebuildBookList();
  return { name: libJson.name, links: libJson.links || {}, bookCount: bookMap.size };
}

// Build a flat array of per-format download descriptors for one raw book.
function buildFormatEntries(book) {
  const e = book.entry;
  const formats = e.formats || [];
  return formats.map(fmt => {
    let sourceFile = null;
    if (typeof e.source === 'string') {
      sourceFile = e.source;   // legacy single-file entry
    } else if (e.source && typeof e.source === 'object') {
      sourceFile = e.source[fmt] || null;
    }
    let filesize = null;
    if (e.filesize != null) {
      if (typeof e.filesize === 'object') {
        filesize = e.filesize[fmt] ?? null;
      } else {
        // scalar filesize: assign only when this is the sole format
        filesize = formats.length === 1 ? e.filesize : null;
      }
    }
    return { format: fmt, libUrl: book.libUrl, libName: book.libName,
             sourceFile, filesize, sourceKey: e.source_key, bookId: book.id };
  });
}

// Merge raw books that share (title, author, series) into a single UI record.
function mergeBooks(rawBooks) {
  const merged = new Map();
  for (const book of rawBooks) {
    const e = book.entry;
    const key = [
      (e.title  || '').toLowerCase().trim(),
      (e.author || '').toLowerCase().trim(),
      (e.series || '').toLowerCase().trim()
    ].join('\x00');
    if (!merged.has(key)) {
      merged.set(key, {
        id:           book.id,
        entry:        e,
        libUrl:       book.libUrl,
        libName:      book.libName,
        formatEntries: buildFormatEntries(book),
        merged:       false
      });
    } else {
      const m = merged.get(key);
      m.formatEntries.push(...buildFormatEntries(book));
      m.merged = true;
    }
  }
  return [...merged.values()];
}

function rebuildBookList() {
  const rawBooks = [];
  for (const [url, lib] of state.libs) {
    for (const [id, entry] of lib.books) {
      rawBooks.push({ id, entry, libUrl: url, libName: lib.name });
    }
  }
  state.books = mergeBooks(rawBooks);
  applyFilter();
}

function applyFilter() {
  const q = state.search.toLowerCase();
  let arr = state.books.filter(b => {
    if (!q) return true;
    const e = b.entry;
    return (e.title||'').toLowerCase().includes(q)
      || (e.author||'').toLowerCase().includes(q)
      || (e.series||'').toLowerCase().includes(q);
  });
  const sort = state.sort;
  arr.sort((a, b) => {
    const ae=a.entry, be=b.entry;
    if (sort==='series') {
      const sa=ae.series||'', sb=be.series||'';
      if (sa!==sb) return sa<sb?-1:1;
      const ia=(ae.series_index||0), ib=(be.series_index||0);
      if (ia!==ib) return ia-ib;
      return (ae.title||'').localeCompare(be.title||'');
    }
    if (sort==='title'||sort==='title_desc') {
      const cmp=(ae.title||'').localeCompare(be.title||'');
      return sort==='title'?cmp:-cmp;
    }
    if (sort==='author') return (ae.author||'').localeCompare(be.author||'');
    return 0;
  });
  state.filtered = arr;
  state.page = 1;
  renderAll();
}

// ═══════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════
function renderAll() {
  renderChips();
  renderGrid();
  renderPagination();
  const total = state.books.length;
  document.getElementById('bookCount').textContent =
    total ? `${state.filtered.length} book${state.filtered.length!==1?'s':''}`+
            (state.filtered.length<total?` (of ${total})`:'') : '';
  document.getElementById('toolbar').style.display = total ? 'flex' : 'none';
  const es = document.getElementById('emptyState');
  if (total===0 && state.sources.length===0) {
    es.classList.add('show');
    es.querySelector('.empty-sub').innerHTML =
      'Click <strong>+ Add Source</strong> and enter a library URL to get started.';
  } else if (total===0 && state.sources.length>0) {
    es.classList.add('show');
    es.querySelector('.empty-sub').textContent = 'Loading libraries…';
  } else {
    es.classList.remove('show');
  }
}

function renderChips() {
  const list = document.getElementById('srcList');
  list.innerHTML = '';

  if (state.sources.length === 0) {
    list.innerHTML = '<div class="src-empty">No sources added yet.</div>';
  } else {
    for (const src of state.sources) {
      const url = normaliseUrl(src.url);
      const lib = state.libs.get(url);
      const name = lib ? lib.name : src.name || src.url;
      const isLoading = !lib && state.sources.find(s => normaliseUrl(s.url) === url);

      let countHtml;
      if (lib) {
        countHtml = `<span class="src-count-badge">${lib.books.size} book${lib.books.size!==1?'s':''}</span>`;
      } else {
        countHtml = `<span class="src-count-loading">loading…</span>`;
      }

      const row = document.createElement('div');
      row.className = 'src-row';
      row.innerHTML = `
        <div class="src-info">
          <div class="src-name" title="${esc(name)}">${esc(name)}</div>
          <div class="src-url" title="${esc(src.url)}">${esc(src.url)}</div>
          <div class="src-count">${countHtml}</div>
        </div>
        <div class="src-actions">
          <button class="src-btn" data-action="copy" data-url="${esc(src.url)}" title="Copy URL">⎘ Copy</button>
          <button class="src-btn danger" data-action="remove" data-url="${esc(src.url)}" title="Remove source">✕ Remove</button>
        </div>
      `;
      list.appendChild(row);
    }
  }

  // Update button label
  const n = state.sources.length;
  document.getElementById('srcBtnLabel').textContent =
    n === 0 ? '📚 Sources' : `📚 Sources (${n})`;

  list.querySelectorAll('.src-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const url = btn.dataset.url;
      if (btn.dataset.action === 'remove') {
        removeSource(url);
      } else if (btn.dataset.action === 'copy') {
        navigator.clipboard.writeText(url).then(() => {
          const orig = btn.textContent;
          btn.textContent = '✓ Copied';
          setTimeout(() => { btn.textContent = orig; }, 1800);
        }).catch(() => prompt('Source URL:', url));
      }
    });
  });
}

function renderGrid() {
  const grid = document.getElementById('bookGrid');
  grid.innerHTML = '';
  const start = (state.page-1)*state.perPage;
  const page = state.filtered.slice(start, start+state.perPage);
  for (const book of page) {
    const card = makeCard(book);
    grid.appendChild(card);
  }
  // Kick off IntersectionObserver for lazy cover loading
  observeCovers();
}

function makeCard(book) {
  const e = book.entry;
  const card = document.createElement('div');
  card.className = 'book-card';
  card.dataset.bookId = book.id;
  card.dataset.libUrl = book.libUrl;

  const initial = (e.title||'?')[0].toUpperCase();
  card.innerHTML = `
    <div class="cover-wrap">
      <div class="cover-placeholder lazy-cover" id="cp-${book.id}">${initial}</div>
    </div>
    <div class="book-info">
      <div class="book-title">${esc(e.title||'Untitled')}</div>
      <div class="book-author">${esc(e.author||'Unknown')}</div>
      ${e.series ? `<div class="book-series">${esc(e.series)} #${+(e.series_index||0)}</div>` : ''}
    </div>
  `;
  // If cover already cached, show immediately
  if (state.coverCache.has(book.id)) {
    replaceCoverPlaceholder(card, state.coverCache.get(book.id));
  }
  card.addEventListener('click', () => openBookModal(book));
  return card;
}

// Lazy cover loading via IntersectionObserver
let coverObserver = null;
function observeCovers() {
  if (coverObserver) coverObserver.disconnect();
  coverObserver = new IntersectionObserver(async (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      coverObserver.unobserve(el);
      const bookId = el.id.replace('cp-','');
      await loadCover(bookId);
    }
  }, { rootMargin: '100px' });
  document.querySelectorAll('.lazy-cover').forEach(el => coverObserver.observe(el));
}

async function loadCover(bookId) {
  if (state.coverCache.has(bookId)) return;
  // Find book
  const book = state.filtered.find(b => b.id===bookId)
    || state.books.find(b => b.id===bookId);
  if (!book || !book.entry.source_cover) return;
  const lib = state.libs.get(normaliseUrl(book.libUrl));
  if (!lib) return;
  try {
    const keyBuf = CRYPTO.hexToBuffer(book.entry.source_key);
    const res = await fetch(`${normaliseUrl(book.libUrl)}/${book.entry.source_cover}`);
    if (!res.ok) return;
    const enc = await res.arrayBuffer();
    const plain = await CRYPTO.decryptWithKey(enc, keyBuf);
    const mime = detectImageMime(plain);
    const url = URL.createObjectURL(new Blob([plain], { type: mime }));
    state.coverCache.set(bookId, url);
    // Update all card placeholders on current page
    const ph = document.getElementById('cp-'+bookId);
    if (ph) {
      const card = ph.closest('.book-card');
      if (card) replaceCoverPlaceholder(card, url);
    }
    // Also update the book modal if open
    const bmImg = document.getElementById('bmCoverImg');
    if (bmImg && bmImg.dataset.bookId === bookId) {
      bmImg.src = url;
      document.getElementById('bmCoverPh').style.display = 'none';
      bmImg.style.display = 'block';
    }
  } catch { /* cover load failed silently */ }
}

function replaceCoverPlaceholder(card, url) {
  const ph = card.querySelector('.lazy-cover, .cover-placeholder');
  if (!ph) return;
  const img = document.createElement('img');
  img.src = url;
  img.alt = 'cover';
  img.style.width='100%';img.style.height='100%';img.style.objectFit='cover';
  ph.replaceWith(img);
}

function detectImageMime(bytes) {
  if (bytes[0]===0x89 && bytes[1]===0x50) return 'image/png';
  if (bytes[0]===0xFF && bytes[1]===0xD8) return 'image/jpeg';
  if (bytes[0]===0x47 && bytes[1]===0x49) return 'image/gif';
  if (bytes[0]===0x52 && bytes[4]===0x57) return 'image/webp';
  return 'image/jpeg';
}

function renderPagination() {
  const pg = document.getElementById('pagination');
  pg.innerHTML = '';
  const total = Math.ceil(state.filtered.length / state.perPage);
  if (total <= 1) return;
  const cur = state.page;

  const mkBtn = (label, page, active=false, disabled=false) => {
    const b = document.createElement('button');
    b.className = 'page-btn' + (active?' active':'');
    b.textContent = label;
    b.disabled = disabled;
    if (!disabled) b.addEventListener('click', () => { state.page=page; renderGrid(); renderPagination(); window.scrollTo(0,0); });
    return b;
  };
  pg.appendChild(mkBtn('←', cur-1, false, cur===1));

  // always show first, last, and up to 3 around current
  const pages = new Set([1, total]);
  for (let i=Math.max(1,cur-2); i<=Math.min(total,cur+2); i++) pages.add(i);
  let prev = 0;
  for (const p of [...pages].sort((a,b)=>a-b)) {
    if (p - prev > 1) { const d=document.createElement('span'); d.className='page-dots'; d.textContent='…'; pg.appendChild(d); }
    pg.appendChild(mkBtn(p, p, p===cur));
    prev = p;
  }
  pg.appendChild(mkBtn('→', cur+1, false, cur===total));
}

// ═══════════════════════════════════════════════════════════════
// Book detail modal
// ═══════════════════════════════════════════════════════════════
function openBookModal(book) {
  const e = book.entry;
  // Guard: if the modal elements are missing (e.g. stale cached HTML served
  // without the current markup), bail out rather than throwing an unhandled error.
  if (!document.getElementById('bmTitle')) {
    console.error(
      '[OpenLibrary] openBookModal: modal elements not found in DOM. ' +
      'Try a hard-refresh (Ctrl+Shift+R) to reload the latest index.html.'
    );
    return;
  }
  document.getElementById('bmTitle').textContent = e.title || 'Untitled';
  document.getElementById('bmAuthor').textContent = e.author || 'Unknown author';
  document.getElementById('bmId').textContent = book.id;

  const seriesRow = document.getElementById('bmSeriesRow');
  if (e.series) {
    seriesRow.style.display = 'flex';
    document.getElementById('bmSeries').textContent =
      `${e.series} #${+(e.series_index||0)}`;
  } else { seriesRow.style.display = 'none'; }

  // Unique formats across all sources
  const uniqueFormats = [...new Set(book.formatEntries.map(fe => fe.format))];
  document.getElementById('bmFormats').textContent = uniqueFormats.join(', ') || '—';


  // Source label in header tag
  const srcNames = [...new Set(book.formatEntries.map(fe => fe.libName))];
  document.getElementById('bmSource').textContent = srcNames.join(' · ');

  // Cover
  const bmCoverEl = document.getElementById('bmCover');
  const ph = document.getElementById('bmCoverPh');
  ph.textContent = (e.title||'?')[0].toUpperCase();
  ph.style.display = 'flex';
  // Remove old img if present
  const oldImg = bmCoverEl.querySelector('img');
  if (oldImg) oldImg.remove();
  if (state.coverCache.has(book.id)) {
    const img = document.createElement('img');
    img.id = 'bmCoverImg'; img.dataset.bookId = book.id;
    img.src = state.coverCache.get(book.id); img.alt='cover';
    img.className='bm-cover-ph';
    bmCoverEl.appendChild(img); ph.style.display='none';
  } else if (e.source_cover) {
    const img = document.createElement('img');
    img.id = 'bmCoverImg'; img.dataset.bookId = book.id;
    img.alt='cover'; img.className='bm-cover-ph'; img.style.display='none';
    bmCoverEl.appendChild(img);
    loadCover(book.id); // async, will update when ready
  }

  // Download buttons — one per formatEntry, labelled with source when merged
  const btns = document.getElementById('bmDlButtons');
  btns.innerHTML = '';
  if (book.formatEntries.length === 0) {
    btns.innerHTML = '<span style="color:var(--muted);font-size:.82rem">No downloadable formats found.</span>';
  } else {
    // Read Online first
    for (const fe of book.formatEntries) {
      if (fe.format === 'epub' && fe.sourceFile) {
        const readBtn = document.createElement('a');
        readBtn.className = 'btn-dl btn-read';
        readBtn.href = buildReaderUrl(fe, book.entry.title || '');
        readBtn.target = '_blank';
        readBtn.rel = 'noopener noreferrer';
        readBtn.innerHTML = `Read Online${book.merged ? ` (${fe.libName})` : ''}`;
        btns.appendChild(readBtn);
      }
    }
    // Download buttons
    for (const fe of book.formatEntries) {
      const btn = document.createElement('button');
      btn.className = 'btn-dl';
      const fmtLabel = fe.format.toUpperCase();
      const srcLabel = book.merged ? ` (${fe.libName})` : '';
      const sizeLabel = fe.filesize ? `\u2002${CRYPTO.formatBytes(fe.filesize)}` : '';
      btn.innerHTML = `⬇ ${fmtLabel}${srcLabel}${sizeLabel}`;
      btn.addEventListener('click', () => downloadBook(fe, book.entry, btn));
      btns.appendChild(btn);
    }
  }

  document.getElementById('bookOverlay').classList.add('open');
}

function buildReaderUrl(fe, title) {
  const params = JSON.stringify({
    src:     `${normaliseUrl(fe.libUrl)}/${fe.sourceFile}`,
    key:     fe.sourceKey,
    title:   title || '',
    libHash: location.hash
  });
  // base64url encode
  const b64 = btoa(unescape(encodeURIComponent(params)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return 'reader/index.html#' + b64;
}

async function downloadBook(fe, entry, btn) {
  const { format, libUrl, sourceFile, sourceKey } = fe;
  if (!sourceFile) { alert('Source file not found for ' + format); return; }

  const orig = btn.innerHTML;
  btn.disabled = true;

  function setProgress(pct, label) {
    btn.innerHTML =
      `<span class="dl-prog-wrap">` +
      `<span class="dl-prog-bar" style="width:${pct}%"></span>` +
      `<span class="dl-prog-label">${label}</span>` +
      `</span>`;
  }

  try {
    const keyBuf = CRYPTO.hexToBuffer(sourceKey);
    setProgress(0, 'Connecting…');
    const res = await fetch(`${normaliseUrl(libUrl)}/${sourceFile}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

    const contentLength = parseInt(res.headers.get('Content-Length') || '0', 10);
    const hasLength = contentLength > 0;

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (hasLength) {
        // Reserve last 10% for decrypt phase
        const pct = Math.round((received / contentLength) * 88);
        setProgress(pct,
          `${CRYPTO.formatBytes(received)} / ${CRYPTO.formatBytes(contentLength)}`);
      } else {
        setProgress(15, `Downloading ${CRYPTO.formatBytes(received)}…`);
      }
    }

    // Reassemble into single buffer
    const encBuf = new Uint8Array(received);
    let off = 0;
    for (const chunk of chunks) { encBuf.set(chunk, off); off += chunk.length; }

    setProgress(90, 'Decrypting…');
    const plain = await CRYPTO.decryptWithKey(encBuf.buffer, keyBuf);
    setProgress(100, 'Done!');
    const mimeMap = { epub:'application/epub+zip', mobi:'application/x-mobipocket-ebook',
      pdf:'application/pdf', azw3:'application/x-mobipocket-ebook' };
    const mime = mimeMap[format] || 'application/octet-stream';
    const blob = new Blob([plain], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const fname = `${entry.title||'book'}${entry.author?' - '+entry.author:''}.${format}`;
    a.href = url; a.download = fname.replace(/[<>:"/\\|?*]/g,'_');
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); document.body.removeChild(a); }, 1000);
  } catch(err) {
    alert('Download failed: '+err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

// ═══════════════════════════════════════════════════════════════
// Source management
// ═══════════════════════════════════════════════════════════════
function removeSource(url) {
  url = normaliseUrl(url);
  state.sources = state.sources.filter(s => normaliseUrl(s.url) !== url);
  state.libs.delete(url);
  // Clean up cover cache for books from this lib
  for (const [id, _] of (state.libs.get(url)||{books:new Map()}).books||[]) {
    const cached = state.coverCache.get(id);
    if (cached) { URL.revokeObjectURL(cached); state.coverCache.delete(id); }
  }
  saveSources(state.sources);
  rebuildBookList();
  renderAll();
}

async function addSource(url, name) {
  url = normaliseUrl(url);
  if (!state.sources.find(s => normaliseUrl(s.url) === url)) {
    state.sources.push({ url, name: name || url });
    saveSources(state.sources);
    renderChips();
  }
  try {
    const { name: realName, bookCount } = await loadLibrary(url);
    // Update name in sources if we got a real one
    const src = state.sources.find(s => normaliseUrl(s.url) === url);
    if (src) { src.name = realName || src.name; saveSources(state.sources); }
    renderAll();
  } catch(err) {
    showStatus('Error loading '+url+': '+err.message, 'error');
    renderChips();
  }
}

// ═══════════════════════════════════════════════════════════════
// Add-source dialog
// ═══════════════════════════════════════════════════════════════
let _pendingLib = null; // { url, name, links, bookCount }

function openAddDialog() {
  _pendingLib = null;
  document.getElementById('addUrl').value = '';
  document.getElementById('addError').classList.remove('show');
  document.getElementById('addPreview').classList.remove('show');
  document.getElementById('addPreviewBtn').style.display = '';
  document.getElementById('addConfirmBtn').style.display = 'none';
  document.getElementById('linkedContainer').style.display = 'none';
  document.getElementById('addOverlay').classList.add('open');
  setTimeout(() => document.getElementById('addUrl').focus(), 80);
}

function closeAddDialog() {
  document.getElementById('addOverlay').classList.remove('open');
}

async function previewLibrary() {
  const raw = document.getElementById('addUrl').value.trim();
  if (!raw) return showAddError('Please enter a URL.');
  const url = normaliseUrl(raw);
  if (state.sources.find(s => normaliseUrl(s.url) === url)) {
    return showAddError('This source is already in your library list.');
  }
  const btn = document.getElementById('addPreviewBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Fetching…';
  document.getElementById('addError').classList.remove('show');
  try {
    const libJson = await fetchLib(url);
    const password = libJson.encryption_type === 0 ? '0' : null;
    let bookCount = 0;
    if (password !== null) {
      try {
        const idx = await decryptIndex(libJson, password);
        bookCount = Object.keys(idx).length;
      } catch { bookCount = '?'; }
    }
    const links = libJson.links || {};
    const linkEntries = Object.entries(links)
      .filter(([,v]) => v && (v.link||v.url));

    document.getElementById('prevName').textContent = libJson.name || url;
    document.getElementById('prevCount').textContent =
      `${bookCount} book${bookCount!==1?'s':''} · encryption_type ${libJson.encryption_type}`;

    const lc = document.getElementById('linkedContainer');
    const ll = document.getElementById('linkedList');
    ll.innerHTML = '';
    if (linkEntries.length > 0) {
      lc.style.display = 'block';
      for (const [name, val] of linkEntries) {
        const linkUrl = normaliseUrl(val.link || val.url || '');
        const already = !!state.sources.find(s => normaliseUrl(s.url) === linkUrl);
        const item = document.createElement('div');
        item.className = 'linked-item';
        item.innerHTML = `
          <input type="checkbox" id="lnk-${esc(linkUrl)}" value="${esc(linkUrl)}" ${already?'disabled checked':''}>
          <div>
            <div class="linked-name">${esc(name)}</div>
            <div class="linked-url">${esc(linkUrl)}</div>
          </div>
          ${already?'<span class="linked-already">✓ already added</span>':''}
        `;
        ll.appendChild(item);
      }
    } else { lc.style.display = 'none'; }

    document.getElementById('addPreview').classList.add('show');
    document.getElementById('addConfirmBtn').style.display = '';
    document.getElementById('addPreviewBtn').style.display = 'none';
    _pendingLib = { url, name: libJson.name||url, links: linkEntries };
  } catch(err) {
    showAddError('Could not load library: '+err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Preview';
  }
}

async function confirmImport() {
  if (!_pendingLib) return;
  closeAddDialog();
  // Add primary source
  await addSource(_pendingLib.url, _pendingLib.name);
  // Add checked linked sources
  document.querySelectorAll('#linkedList input[type=checkbox]:checked:not(:disabled)').forEach(cb => {
    const linkUrl = cb.value;
    const name = cb.closest('.linked-item').querySelector('.linked-name').textContent;
    addSource(linkUrl, name);
  });
}

function showAddError(msg) {
  const el = document.getElementById('addError');
  el.textContent = msg; el.classList.add('show');
}

// ═══════════════════════════════════════════════════════════════
// Status banner
// ═══════════════════════════════════════════════════════════════
let _statusTimer = null;
function showStatus(msg, type='info', duration=5000) {
  const el = document.getElementById('statusBanner');
  el.textContent = msg;
  el.className = 'status-banner show ' + type;
  clearTimeout(_statusTimer);
  if (duration > 0) _statusTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ═══════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ═══════════════════════════════════════════════════════════════
// Theme management
// ═══════════════════════════════════════════════════════════════
function applyTheme(val) {
  if (val === 'light' || val === 'dark') {
    document.documentElement.dataset.theme = val;
  } else {
    delete document.documentElement.dataset.theme;
  }
  const sel = document.getElementById('themeSelect');
  if (sel) sel.value = val;
  try { localStorage.setItem('ol-theme', val); } catch {}
}
// Apply before first paint to avoid flash
(function() {
  let saved = 'auto';
  try { saved = localStorage.getItem('ol-theme') || 'auto'; } catch {}
  applyTheme(saved);
})();

// ═══════════════════════════════════════════════════════════════
// Event wiring
// ═══════════════════════════════════════════════════════════════
document.getElementById('themeSelect').addEventListener('change', e => applyTheme(e.target.value));

// ═══════════════════════════════════════════════════════════════
// Sources manager (full-screen overlay)
// ═══════════════════════════════════════════════════════════════
function openSourcesManager() {
  document.getElementById('sourcesOverlay').classList.add('open');
}
function closeSourcesManager() {
  document.getElementById('sourcesOverlay').classList.remove('open');
  document.getElementById('srcImportPanel').classList.remove('show');
  document.getElementById('srcImportTa').value = '';
  document.getElementById('srcImportError').classList.remove('show');
}

document.getElementById('btnSources').addEventListener('click', openSourcesManager);
document.getElementById('srcMgrClose').addEventListener('click', closeSourcesManager);

document.getElementById('srcExportBtn').addEventListener('click', () => {
  const json = JSON.stringify(state.sources, null, 2);
  navigator.clipboard.writeText(json).then(() => {
    const btn = document.getElementById('srcExportBtn');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }).catch(() => prompt('Copy this JSON:', json));
});

document.getElementById('srcImportBtn').addEventListener('click', () => {
  const panel = document.getElementById('srcImportPanel');
  const isOpen = panel.classList.toggle('show');
  if (isOpen) setTimeout(() => document.getElementById('srcImportTa').focus(), 50);
});

document.getElementById('srcImportCancel').addEventListener('click', () => {
  document.getElementById('srcImportPanel').classList.remove('show');
  document.getElementById('srcImportTa').value = '';
  document.getElementById('srcImportError').classList.remove('show');
});

document.getElementById('srcImportConfirm').addEventListener('click', () => {
  const raw = document.getElementById('srcImportTa').value.trim();
  const errEl = document.getElementById('srcImportError');
  errEl.classList.remove('show');
  let parsed;
  try { parsed = JSON.parse(raw); } catch(e) {
    errEl.textContent = 'Invalid JSON: ' + e.message;
    errEl.classList.add('show');
    return;
  }
  if (!Array.isArray(parsed)) {
    errEl.textContent = 'Expected a JSON array of source objects [{url, name}].';
    errEl.classList.add('show');
    return;
  }
  const newSources = [];
  for (const item of parsed) {
    if (!item.url) continue;
    const url = normaliseUrl(item.url);
    if (!state.sources.find(s => normaliseUrl(s.url) === url)) {
      state.sources.push({ url, name: item.name || url });
      newSources.push({ url, name: item.name || url });
    }
  }
  saveSources(state.sources);
  document.getElementById('srcImportPanel').classList.remove('show');
  document.getElementById('srcImportTa').value = '';
  renderChips();
  if (newSources.length > 0) {
    showStatus(`Importing ${newSources.length} new source${newSources.length>1?'s':'…'}`, 'info', 0);
    Promise.allSettled(newSources.map(s => loadLibrary(s.url))).then(results => {
      const errors = results.filter(r => r.status==='rejected').map(r => r.reason.message);
      if (errors.length) showStatus('Failed to load '+errors.length+' source(s): '+errors.join('; '), 'error');
      else document.getElementById('statusBanner').classList.remove('show');
      renderAll();
    });
  }
});

document.getElementById('btnAdd').addEventListener('click', () => {
  closeSourcesManager();
  openAddDialog();
});
document.getElementById('addCancel').addEventListener('click', closeAddDialog);
document.getElementById('addPreviewBtn').addEventListener('click', previewLibrary);
document.getElementById('addConfirmBtn').addEventListener('click', confirmImport);
document.getElementById('bmClose').addEventListener('click', () => {
  document.getElementById('bookOverlay').classList.remove('open');
});

// Close overlays on backdrop click or Escape
['bookOverlay','addOverlay','sourcesOverlay'].forEach(id => {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target.id===id) document.getElementById(id).classList.remove('open');
  });
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  document.getElementById('bookOverlay').classList.remove('open');
  document.getElementById('addOverlay').classList.remove('open');
  closeSourcesManager();
});

// Enter key in URL field triggers preview
document.getElementById('addUrl').addEventListener('keydown', e => {
  if (e.key==='Enter') previewLibrary();
});

document.getElementById('searchInput').addEventListener('input', e => {
  state.search = e.target.value;
  applyFilter();
});

document.getElementById('sortSelect').addEventListener('change', e => {
  state.sort = e.target.value;
  applyFilter();
});

// ═══════════════════════════════════════════════════════════════
// Initialise — load all sources from hash
// ═══════════════════════════════════════════════════════════════
(async function init() {
  renderAll(); // show empty state / sources immediately
  if (state.sources.length === 0) return;
  showStatus(`Loading ${state.sources.length} source${state.sources.length>1?'s':''}…`, 'info', 0);
  const results = await Promise.allSettled(
    state.sources.map(s => loadLibrary(s.url))
  );
  const errors = results.filter(r => r.status==='rejected').map(r => r.reason.message);
  if (errors.length) showStatus('Failed to load '+errors.length+' source(s): '+errors.join('; '), 'error');
  else { document.getElementById('statusBanner').classList.remove('show'); }
  renderAll();
})();
