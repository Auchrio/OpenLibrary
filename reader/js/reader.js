'use strict';

// ═══════════════════════════════════════════════════════════════
// CRYPTO — identical params to app.js / library.go
// ═══════════════════════════════════════════════════════════════
const CRYPTO = {
  NONCE_SIZE: 12,

  async decryptWithKey(encryptedData, keyBuffer) {
    const view  = new Uint8Array(encryptedData);
    const nonce = view.slice(0, this.NONCE_SIZE);
    const ct    = view.slice(this.NONCE_SIZE);
    const key = await crypto.subtle.importKey('raw', keyBuffer, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct);
    return new Uint8Array(plain);
  },

  hexToBuffer(hex) {
    const b = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.substr(i, 2), 16);
    return b;
  }
};

// ═══════════════════════════════════════════════════════════════
// HASH PARAMS  — base64url-encoded JSON {src, key, title}
// ═══════════════════════════════════════════════════════════════
function parseHash() {
  const h = location.hash.slice(1);
  if (!h) return null;
  try {
    let s = h.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return JSON.parse(decodeURIComponent(escape(atob(s))));
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
// ZIP PARSER
// ═══════════════════════════════════════════════════════════════
const EOCD_SIG = 0x06054b50;
const CD_SIG   = 0x02014b50;

async function inflateRaw(data) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(data);
  writer.close();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

async function parseZip(buffer) {
  const view  = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const len   = buffer.byteLength;

  // Locate End-of-Central-Directory record (search from end)
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 65558); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP file');

  const cdCount  = view.getUint16(eocd + 8,  true);
  const cdOffset = view.getUint32(eocd + 16, true);

  const files = new Map();
  let pos = cdOffset;

  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(pos, true) !== CD_SIG) break;
    const method   = view.getUint16(pos + 10, true);
    const cSize    = view.getUint32(pos + 20, true);
    const fnLen    = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const cmtLen   = view.getUint16(pos + 32, true);
    const lfhOff   = view.getUint32(pos + 42, true);
    const name     = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + fnLen));
    pos += 46 + fnLen + extraLen + cmtLen;

    if (name.endsWith('/')) continue; // directory entry

    // Read from Local File Header to get actual data offset
    const lfhFnLen    = view.getUint16(lfhOff + 26, true);
    const lfhExtraLen = view.getUint16(lfhOff + 28, true);
    const dataStart   = lfhOff + 30 + lfhFnLen + lfhExtraLen;
    const compressed  = bytes.slice(dataStart, dataStart + cSize);

    let data;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      data = await inflateRaw(compressed);
    } else {
      // Unsupported compression — store null, we'll skip it
      data = null;
    }
    if (data) files.set(name, data);
  }
  return files;
}

// ═══════════════════════════════════════════════════════════════
// PATH UTILITIES
// ═══════════════════════════════════════════════════════════════
function resolvePath(base, relative) {
  if (!relative) return base;
  if (relative.startsWith('/')) return relative.replace(/^\/+/, '');
  // Treat base as a directory path (may end with '/')
  const dir = base.includes('/') ? base.substring(0, base.lastIndexOf('/') + 1) : '';
  const parts = (dir + relative).split('/');
  const resolved = [];
  for (const p of parts) {
    if (p === '..') resolved.pop();
    else if (p !== '.') resolved.push(p);
  }
  return resolved.join('/');
}

function basename(path) {
  return path.split('/').pop() || path;
}

function extname(path) {
  const b = basename(path);
  const dot = b.lastIndexOf('.');
  return dot >= 0 ? b.slice(dot + 1).toLowerCase() : '';
}

// ═══════════════════════════════════════════════════════════════
// EPUB STRUCTURE PARSING
// ═══════════════════════════════════════════════════════════════
function decodeXml(bytes) {
  // Detect encoding from XML declaration, fall back to UTF-8
  const head = new TextDecoder('utf-8').decode(bytes.slice(0, 100));
  const m = head.match(/encoding=["']([^"']+)["']/i);
  const enc = m ? m[1] : 'utf-8';
  try { return new TextDecoder(enc).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

function getOpfPath(files) {
  const containerBytes = files.get('META-INF/container.xml');
  if (!containerBytes) throw new Error('META-INF/container.xml not found in EPUB');
  const xml = decodeXml(containerBytes);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const rf = doc.querySelector('rootfile[full-path]');
  if (!rf) throw new Error('No rootfile in container.xml');
  return rf.getAttribute('full-path');
}

function parseOPF(files, opfPath) {
  const opfBytes = files.get(opfPath);
  if (!opfBytes) throw new Error(`OPF not found: ${opfPath}`);
  const xml = decodeXml(opfBytes);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const opfBase = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  // Metadata
  const title  = doc.querySelector('metadata > *|title, metadata title')?.textContent?.trim() || 'Untitled';
  const author = doc.querySelector('metadata > *|creator, metadata creator')?.textContent?.trim() || '';

  // Build manifest map: id → {href (absolute), mediaType, properties}
  const manifest = {};
  doc.querySelectorAll('manifest item').forEach(item => {
    const id   = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id && href) {
      manifest[id] = {
        href:       resolvePath(opfBase, decodeURIComponent(href)),
        mediaType:  item.getAttribute('media-type') || '',
        properties: item.getAttribute('properties') || ''
      };
    }
  });

  // Spine: ordered idrefs
  const spine = [];
  doc.querySelectorAll('spine itemref').forEach(ref => {
    const idref  = ref.getAttribute('idref');
    const linear = ref.getAttribute('linear');
    if (idref && manifest[idref] && linear !== 'no') {
      spine.push({ idref, href: manifest[idref].href, mediaType: manifest[idref].mediaType });
    }
  });

  // Locate NCX (EPUB2) and nav doc (EPUB3)
  let ncxPath = null, navPath = null;
  const ncxId = doc.querySelector('spine')?.getAttribute('toc');
  if (ncxId && manifest[ncxId]) ncxPath = manifest[ncxId].href;
  for (const id in manifest) {
    if (manifest[id].properties.includes('nav')) { navPath = manifest[id].href; break; }
  }
  // Fallback: find .ncx file in manifest
  if (!ncxPath) {
    for (const id in manifest) {
      if (manifest[id].mediaType === 'application/x-dtbncx+xml') { ncxPath = manifest[id].href; break; }
    }
  }

  return { title, author, spine, manifest, opfBase, ncxPath, navPath };
}

// ── TOC from NCX (EPUB2) ──────────────────────────────────────────────────
function parseNCX(files, ncxPath, opfBase) {
  const bytes = files.get(ncxPath);
  if (!bytes) return [];
  const xml = decodeXml(bytes);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const base = ncxPath.includes('/') ? ncxPath.substring(0, ncxPath.lastIndexOf('/') + 1) : '';

  function parseNavPoint(el, depth) {
    const label  = el.querySelector('navLabel text')?.textContent?.trim() || '';
    const src    = el.getAttribute('src') || el.querySelector('content')?.getAttribute('src') || '';
    const [pathPart, anchor] = src.split('#');
    const href   = resolvePath(base, decodeURIComponent(pathPart));
    const item   = { label, href, anchor: anchor || null, depth, children: [] };
    el.querySelectorAll(':scope > navPoint').forEach(child => {
      item.children.push(parseNavPoint(child, depth + 1));
    });
    return item;
  }

  const items = [];
  doc.querySelectorAll('navMap > navPoint').forEach(el => items.push(parseNavPoint(el, 0)));
  return items;
}

// ── TOC from nav.xhtml (EPUB3) ───────────────────────────────────────────────
function parseNavDoc(files, navPath) {
  const bytes = files.get(navPath);
  if (!bytes) return [];
  const html = new TextDecoder('utf-8').decode(bytes);
  const doc  = new DOMParser().parseFromString(html, 'text/html');
  const base = navPath.includes('/') ? navPath.substring(0, navPath.lastIndexOf('/') + 1) : '';
  const nav  = doc.querySelector('nav[epub\\:type="toc"], nav[role="doc-toc"], nav');
  if (!nav) return [];

  function parseOl(ol, depth) {
    const items = [];
    ol.querySelectorAll(':scope > li').forEach(li => {
      const a   = li.querySelector('a');
      if (!a) return;
      const raw = a.getAttribute('href') || '';
      const [pathPart, anchor] = raw.split('#');
      const href = pathPart ? resolvePath(base, decodeURIComponent(pathPart)) : base;
      const item = { label: a.textContent.trim(), href, anchor: anchor || null, depth, children: [] };
      const subOl = li.querySelector('ol');
      if (subOl) item.children = parseOl(subOl, depth + 1);
      items.push(item);
    });
    return items;
  }

  const root = nav.querySelector('ol');
  return root ? parseOl(root, 0) : [];
}

// Flatten nested TOC into a list for UI rendering
function flattenToc(items, out = []) {
  for (const item of items) {
    out.push(item);
    if (item.children?.length) flattenToc(item.children, out);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// BLOB URL BUILDER
// ═══════════════════════════════════════════════════════════════
const BINARY_MIME = {
  jpg:   'image/jpeg', jpeg:  'image/jpeg', png:   'image/png',
  gif:   'image/gif',  webp:  'image/webp', svg:   'image/svg+xml',
  ttf:   'font/ttf',   otf:   'font/otf',   woff:  'font/woff',
  woff2: 'font/woff2', mp3:   'audio/mpeg', ogg:   'audio/ogg',
};

async function buildBlobUrls(files) {
  const blobUrls = new Map();

  // Pass 1: binary assets
  for (const [path, data] of files) {
    const ext = extname(path);
    const mime = BINARY_MIME[ext];
    if (mime) blobUrls.set(path, URL.createObjectURL(new Blob([data], { type: mime })));
  }

  // Pass 2: CSS (with url() references rewritten to blob URLs)
  for (const [path, data] of files) {
    if (extname(path) !== 'css') continue;
    const base = path.includes('/') ? path.substring(0, path.lastIndexOf('/') + 1) : '';
    let css = new TextDecoder('utf-8').decode(data);
    css = rewriteUrlRefs(css, base, blobUrls);
    blobUrls.set(path, URL.createObjectURL(new Blob([css], { type: 'text/css' })));
  }

  return blobUrls;
}

// ═══════════════════════════════════════════════════════════════
// HTML REWRITER
// ═══════════════════════════════════════════════════════════════
// Rewrite src="..." href="..." for non-http relative refs
function rewriteAttrRefs(html, base, blobUrls) {
  return html.replace(/((?:src|href|poster)\s*=\s*)["']([^"']+)["']/g, (m, attr, ref) => {
    if (/^(https?:|data:|#|mailto:|javascript:)/i.test(ref)) return m;
    const [pathPart, anchor] = ref.split('#');
    const resolved = pathPart ? resolvePath(base, decodeURIComponent(pathPart)) : '';
    const blob = resolved && blobUrls.get(resolved);
    if (!blob) return m;
    const q = m.includes("'") ? "'" : '"';
    return `${attr}${q}${blob}${anchor ? '#' + anchor : ''}${q}`;
  });
}

// Rewrite url(...) in CSS content within HTML
function rewriteUrlRefs(text, base, blobUrls) {
  return text.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (m, ref) => {
    if (/^(https?:|data:)/i.test(ref)) return m;
    const resolved = resolvePath(base, decodeURIComponent(ref.trim()));
    const blob = blobUrls.get(resolved);
    return blob ? `url("${blob}")` : m;
  });
}

function rewriteChapterHtml(raw, chapterPath, blobUrls, readerSettings) {
  const base = chapterPath.includes('/') ? chapterPath.substring(0, chapterPath.lastIndexOf('/') + 1) : '';

  // Strip XML declaration (breaks srcdoc in some browsers)
  let html = raw.replace(/^<\?xml[^>]*\?>\s*/i, '');

  // Rewrite attribute refs
  html = rewriteAttrRefs(html, base, blobUrls);

  // Rewrite url() in inline <style> blocks and style= attributes
  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, css, close) => {
    return open + rewriteUrlRefs(css, base, blobUrls) + close;
  });
  html = html.replace(/style\s*=\s*"([^"]*)"/gi, (m, s) =>
    `style="${rewriteUrlRefs(s, base, blobUrls)}"`);

  // Inject reader chrome overrides just before </head>
  const overrides = buildOverrideStyle(readerSettings);
  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, overrides + '</head>');
  } else {
    html = overrides + html;
  }

  return html;
}

function buildOverrideStyle({ theme, size, font }) {
  const sizes = { small: '15px', medium: '18px', large: '21px', xlarge: '25px' };
  const fonts = {
    serif: "Georgia,'Times New Roman',Times,serif",
    sans:  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
    mono:  "ui-monospace,'Cascadia Code',monospace"
  };
  const themes = {
    dark:  { bg: '#181818', text: '#e0e0e0', link: '#90caf9' },
    light: { bg: '#f8f8f8', text: '#1a1a1a', link: '#1565c0' },
    sepia: { bg: '#f7f0dc', text: '#3b2a1a', link: '#6b4c24' },
  };
  // Resolve 'auto' by reading the system preference at render time.
  const resolvedTheme = theme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  const t = themes[resolvedTheme] || themes.light;
  const bgLine      = `background:${t.bg} !important;`;
  const textLine    = `color:${t.text} !important;`;
  const allTextLine = `*,*::before,*::after{color:${t.text} !important;}`;
  const linkLine    = `a,a *{color:${t.link}!important;}`;

  return `
<style id="ol-reader-overrides">
  *,*::before,*::after{box-sizing:border-box}
  html,body{
    max-width:700px !important;
    margin:0 auto !important;
    padding:24px 20px 40px !important;
    font-family:${fonts[font] || fonts.serif} !important;
    font-size:${sizes[size] || '18px'} !important;
    line-height:1.75 !important;
    ${bgLine}
    ${textLine}
  }
  ${allTextLine}
  img,svg{max-width:100% !important;height:auto !important;}
  pre,code{white-space:pre-wrap;word-break:break-word;}
  ${linkLine}
</style>`;
}

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════
const state = {
  params:      null,   // {src, key, title}
  files:       null,   // Map<path, Uint8Array>
  blobUrls:    null,   // Map<path, blobUrl>
  spine:       [],     // [{idref, href, mediaType}]
  toc:         [],     // flat array of toc items
  chapter:     0,      // current spine index
  settings: {
    theme:  localStorage.getItem('ol-theme')      || 'auto',
    size:   localStorage.getItem('ol-reader-size') || 'medium',
    font:   localStorage.getItem('ol-reader-font') || 'serif',
  }
};

// ═══════════════════════════════════════════════════════════════
// PROGRESS PERSISTENCE
// ═══════════════════════════════════════════════════════════════
function progressKey() {
  return 'ol-progress:' + (state.params?.src || '');
}
function saveProgress(chapter) {
  try { localStorage.setItem(progressKey(), String(chapter)); } catch {}
}
function loadProgress() {
  try { return parseInt(localStorage.getItem(progressKey()) || '0', 10) || 0; } catch { return 0; }
}

// ═══════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════
let _iframeClickBound = false;
let _chapterNavCooldown = false;
let _scrollToEnd = false; // when true, new chapter scrolls to bottom

function _triggerChapterNav(direction) {
  if (_chapterNavCooldown) return;
  _chapterNavCooldown = true;
  setTimeout(() => { _chapterNavCooldown = false; }, 800);
  if (direction === 'next' && state.chapter < state.spine.length - 1) {
    _scrollToEnd = false;
    goToChapter(state.chapter + 1, null);
  } else if (direction === 'prev' && state.chapter > 0) {
    _scrollToEnd = true;
    goToChapter(state.chapter - 1, null);
  }
}

async function goToChapter(idx, anchor) {
  if (idx < 0 || idx >= state.spine.length) return;
  state.chapter = idx;
  saveProgress(idx);
  updateNavBar();
  highlightTocItem(idx);

  const spine = state.spine[idx];
  const raw = state.files.get(spine.href);
  if (!raw) {
    setStatus('Chapter file not found: ' + spine.href, true);
    return;
  }

  const html = rewriteChapterHtml(
    new TextDecoder('utf-8').decode(raw),
    spine.href,
    state.blobUrls,
    state.settings
  );

  const frame = document.getElementById('epubFrame');

  // Use srcdoc — fires load event reliably
  frame.srcdoc = html;

  // After load, wire up link interception, scroll edge nav, and anchor scroll
  frame.onload = () => {
    try {
      const doc = frame.contentDocument;
      if (!doc) return;

      doc.addEventListener('click', handleIframeClick);

      // Scroll-edge chapter navigation
      doc.addEventListener('wheel', (e) => {
        const el = doc.scrollingElement || doc.documentElement;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
        const atTop    = el.scrollTop <= 0;
        if (e.deltaY > 0 && atBottom) _triggerChapterNav('next');
        if (e.deltaY < 0 && atTop)    _triggerChapterNav('prev');
      }, { passive: true });

      // Scroll to bottom when arriving via upward scroll-edge nav
      if (_scrollToEnd) {
        const el = doc.scrollingElement || doc.documentElement;
        el.scrollTop = el.scrollHeight;
        _scrollToEnd = false;
      }

      // Scroll to anchor if requested
      if (anchor) {
        const el = doc.getElementById(anchor) || doc.querySelector(`[name="${anchor}"]`);
        if (el) el.scrollIntoView({ block: 'start' });
      }
    } catch (e) { /* cross-origin guard (shouldn't happen with srcdoc) */ }
  };
}

function handleIframeClick(e) {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!href) return;

  // External link
  if (/^https?:\/\//i.test(href)) {
    e.preventDefault();
    window.open(href, '_blank', 'noopener,noreferrer');
    return;
  }

  // Pure in-page anchor (#id)
  if (href.startsWith('#')) {
    const el = a.ownerDocument.getElementById(href.slice(1));
    if (el) { e.preventDefault(); el.scrollIntoView({ behavior: 'smooth' }); }
    return;
  }

  // Internal relative link — might be another spine chapter
  e.preventDefault();
  const currentHref = state.spine[state.chapter]?.href || '';
  const base = currentHref.includes('/') ? currentHref.substring(0, currentHref.lastIndexOf('/') + 1) : '';
  const [pathPart, anchor] = href.split('#');
  const resolved = pathPart ? resolvePath(base, decodeURIComponent(pathPart)) : currentHref;

  // Find in spine
  const idx = state.spine.findIndex(s => s.href === resolved);
  if (idx >= 0) {
    goToChapter(idx, anchor || null);
  } else {
    // Might be pointing to a non-spine file (e.g. image page) — ignore gracefully
  }
}

function goNext() {
  if (state.chapter < state.spine.length - 1) goToChapter(state.chapter + 1, null);
}
function goPrev() {
  if (state.chapter > 0) goToChapter(state.chapter - 1, null);
}

function updateNavBar() {
  const total = state.spine.length;
  const cur   = state.chapter + 1;
  // Try to use TOC label for current chapter
  const tocItem = state.toc.find(t => t.href === state.spine[state.chapter]?.href);
  const label   = tocItem?.label || `Chapter ${cur}`;
  document.getElementById('chapterLabel').textContent = `${label}  (${cur} / ${total})`;
  document.getElementById('progressFill').style.width = (cur / total * 100) + '%';
  document.getElementById('btnPrev').disabled = state.chapter === 0;
  document.getElementById('btnNext').disabled = state.chapter === total - 1;
}

// ═══════════════════════════════════════════════════════════════
// TOC UI
// ═══════════════════════════════════════════════════════════════
function renderToc() {
  const list = document.getElementById('tocList');
  if (!state.toc.length) {
    list.innerHTML = '<div style="padding:16px;font-size:.82rem;color:var(--muted)">No table of contents found.</div>';
    return;
  }
  list.innerHTML = '';
  for (const item of state.toc) {
    const el = document.createElement('div');
    el.className = 'toc-item' + (item.depth > 0 ? ` depth-${Math.min(item.depth, 2)}` : '');
    el.textContent = item.label;
    el.setAttribute('data-href', item.href);
    el.setAttribute('data-anchor', item.anchor || '');
    el.addEventListener('click', () => {
      const idx = state.spine.findIndex(s => s.href === item.href);
      if (idx >= 0) goToChapter(idx, item.anchor);
      // Close TOC on mobile
      if (window.innerWidth < 900) closeToc();
    });
    list.appendChild(el);
  }
}

function highlightTocItem(chapterIdx) {
  const href = state.spine[chapterIdx]?.href;
  document.querySelectorAll('.toc-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-href') === href);
  });
  // Scroll active item into view
  const active = document.querySelector('.toc-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function isWide() { return window.innerWidth >= 900; }

function openToc() {
  if (isWide()) {
    document.getElementById('tocSidebar').classList.remove('collapsed');
  } else {
    document.getElementById('tocSidebar').classList.add('open');
    document.getElementById('tocBackdrop').classList.add('show');
  }
}
function closeToc() {
  if (isWide()) {
    document.getElementById('tocSidebar').classList.add('collapsed');
  } else {
    document.getElementById('tocSidebar').classList.remove('open');
    document.getElementById('tocBackdrop').classList.remove('show');
  }
}
function toggleToc() {
  // Preserve iframe scroll position across layout reflow
  let savedScroll = 0;
  try {
    const el = document.getElementById('epubFrame').contentDocument?.scrollingElement;
    if (el) savedScroll = el.scrollTop;
  } catch {}

  if (isWide()) {
    document.getElementById('tocSidebar').classList.toggle('collapsed');
  } else {
    document.getElementById('tocSidebar').classList.contains('open') ? closeToc() : openToc();
  }

  if (savedScroll > 0) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try {
        const el = document.getElementById('epubFrame').contentDocument?.scrollingElement;
        if (el) el.scrollTop = savedScroll;
      } catch {}
    }));
  }
}

// ═══════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════
function applySettings() {
  const { theme, size, font } = state.settings;
  // Theme: reuse the html[data-theme] system
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.size = size;
  document.documentElement.dataset.font = font;

  // Sync seg-btn active states
  document.querySelectorAll('[data-theme]').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
  document.querySelectorAll('[data-size]').forEach(b  => b.classList.toggle('active', b.dataset.size  === size));
  document.querySelectorAll('[data-font]').forEach(b  => b.classList.toggle('active', b.dataset.font  === font));

  // If a chapter is already loaded, re-render it to apply new overrides
  if (state.spine.length && state.files) goToChapter(state.chapter, null);
}

function saveSettings() {
  localStorage.setItem('ol-theme',       state.settings.theme);
  localStorage.setItem('ol-reader-size', state.settings.size);
  localStorage.setItem('ol-reader-font', state.settings.font);
}

// ═══════════════════════════════════════════════════════════════
// LOADING UI
// ═══════════════════════════════════════════════════════════════
function setStatus(msg, isError = false) {
  const overlay  = document.getElementById('readerStatus');
  const spinner  = document.getElementById('statusSpinner');
  const msgEl    = document.getElementById('statusMsg');
  overlay.classList.remove('hidden');
  spinner.classList.toggle('hidden', isError);
  msgEl.textContent = msg;
  msgEl.className = 'status-msg' + (isError ? ' error' : '');
}
function hideStatus() {
  document.getElementById('readerStatus').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════
// UPLOAD ZONE
// ═══════════════════════════════════════════════════════════════
function showUploadZone() {
  document.getElementById('readerStatus').classList.add('hidden');
  document.getElementById('uploadZone').classList.remove('hidden');
  document.getElementById('toolbarTitle').textContent = 'OpenLibrary Reader';
  document.title = 'OpenLibrary Reader';
  document.getElementById('navBar').style.visibility = 'hidden';
}

function hideUploadZone() {
  document.getElementById('uploadZone').classList.add('hidden');
  document.getElementById('navBar').style.visibility = '';
}

// Shared EPUB loading pipeline (used by both network and file paths)
async function loadEpub(buffer, hintTitle) {
  setStatus('Unpacking EPUB…');
  state.files = await parseZip(buffer);

  setStatus('Reading structure…');
  const opfPath = getOpfPath(state.files);
  const { title: bookTitle, author, spine, ncxPath, navPath } = parseOPF(state.files, opfPath);

  const baseTitle = hintTitle || bookTitle || 'Untitled';
  const fullTitle = baseTitle + (author ? ` — ${author}` : '');
  document.getElementById('toolbarTitle').textContent = fullTitle;
  document.title = fullTitle + ' — OpenLibrary Reader';

  state.spine = spine;
  if (!spine.length) throw new Error('EPUB has no readable spine items');

  let tocItems = [];
  if (navPath)  tocItems = parseNavDoc(state.files, navPath);
  if (!tocItems.length && ncxPath) tocItems = parseNCX(state.files, ncxPath, '');
  state.toc = flattenToc(tocItems);

  setStatus('Loading resources…');
  state.blobUrls = await buildBlobUrls(state.files);

  renderToc();

  const savedChapter = Math.min(loadProgress(), spine.length - 1);
  hideStatus();
  await goToChapter(savedChapter, null);
}

async function loadFromFile(file) {
  if (!file || !/\.epub$/i.test(file.name)) {
    setStatus('Please select a valid .epub file.', true);
    return;
  }
  hideUploadZone();
  setStatus('Reading file…');
  try {
    const buffer = await file.arrayBuffer();
    // Use filename (sans extension) as hint title; no progress key since no stable src URL
    state.params = { src: 'local:' + file.name, key: null, title: file.name.replace(/\.epub$/i, '') };
    await loadEpub(buffer, state.params.title);
  } catch (err) {
    console.error('[OpenLibrary Reader]', err);
    setStatus('Failed to load EPUB: ' + err.message, true);
  }
}

// ═══════════════════════════════════════════════════════════════
async function init() {
  // Apply saved settings before any rendering
  applySettings();

  const params = parseHash();
  if (!params || !params.src || !params.key) {
    showUploadZone();
    return;
  }
  state.params = params;

  // Wire back button to return to the library with sources intact
  if (params.libHash) {
    document.getElementById('btnBack').href = '../index.html' + params.libHash;
  }

  // Update page title
  const title = params.title || 'Book';
  document.getElementById('toolbarTitle').textContent = title;
  document.title = title + ' — OpenLibrary Reader';

  try {
    // 1. Fetch encrypted file
    setStatus('Fetching encrypted file…');
    const res = await fetch(params.src);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const enc = await res.arrayBuffer();

    // 2. Decrypt
    setStatus('Decrypting…');
    const keyBuf = CRYPTO.hexToBuffer(params.key);
    const plain  = await CRYPTO.decryptWithKey(enc, keyBuf);

    // 3–8. Shared loading pipeline
    await loadEpub(plain.buffer, params.title);

  } catch (err) {
    console.error('[OpenLibrary Reader]', err);
    setStatus('Failed to load book: ' + err.message, true);
  }
}

// ═══════════════════════════════════════════════════════════════
// EVENT WIRING
// ═══════════════════════════════════════════════════════════════
document.getElementById('btnToc').addEventListener('click', toggleToc);
document.getElementById('tocBackdrop').addEventListener('click', closeToc);
document.getElementById('btnPrev').addEventListener('click', goPrev);
document.getElementById('btnNext').addEventListener('click', goNext);

document.getElementById('btnSettings').addEventListener('click', e => {
  e.stopPropagation();
  document.getElementById('settingsPanel').classList.toggle('open');
});
document.addEventListener('click', e => {
  const panel = document.getElementById('settingsPanel');
  if (panel.classList.contains('open') && !panel.contains(e.target) && e.target.id !== 'btnSettings') {
    panel.classList.remove('open');
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown')  goNext();
  if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')    goPrev();
  if (e.key === 'Escape') {
    closeToc();
    document.getElementById('settingsPanel').classList.remove('open');
  }
});

// Settings buttons
document.querySelectorAll('[data-theme]').forEach(btn => {
  btn.addEventListener('click', () => {
    state.settings.theme = btn.dataset.theme;
    saveSettings(); applySettings();
  });
});
document.querySelectorAll('[data-size]').forEach(btn => {
  btn.addEventListener('click', () => {
    state.settings.size = btn.dataset.size;
    saveSettings(); applySettings();
  });
});
document.querySelectorAll('[data-font]').forEach(btn => {
  btn.addEventListener('click', () => {
    state.settings.font = btn.dataset.font;
    saveSettings(); applySettings();
  });
});

// Swipe navigation on the iframe wrapper
let _touchStartX = 0;
document.getElementById('readingPane').addEventListener('touchstart', e => {
  _touchStartX = e.touches[0].clientX;
}, { passive: true });
document.getElementById('readingPane').addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - _touchStartX;
  if (Math.abs(dx) > 60) dx < 0 ? goNext() : goPrev();
}, { passive: true });

// File upload zone
const _epubFileInput = document.getElementById('epubFileInput');
_epubFileInput.addEventListener('change', () => {
  if (_epubFileInput.files[0]) loadFromFile(_epubFileInput.files[0]);
});
const _uploadZone = document.getElementById('uploadZone');
_uploadZone.addEventListener('click', e => {
  if (!e.target.closest('label')) _epubFileInput.click();
});
_uploadZone.addEventListener('dragover', e => {
  e.preventDefault();
  _uploadZone.classList.add('drag-over');
});
_uploadZone.addEventListener('dragleave', () => _uploadZone.classList.remove('drag-over'));
_uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  _uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadFromFile(file);
});
// Also accept drops on the whole page
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && /\.epub$/i.test(file.name)) loadFromFile(file);
});

// On wide screens open TOC by default
if (window.innerWidth >= 900) openToc();

// Re-render when OS dark/light preference changes, but only when 'auto' is active.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.settings.theme === 'auto') applySettings();
});

init();
