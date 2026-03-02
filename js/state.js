'use strict';

// ═══════════════════════════════════════════════════════════════
// URL hash state  —  persists library source list client-side
//
// Hash format: pipe-separated raw source URLs, e.g.
//   #github:owner/repo|https://example.com/lib
// Names and passwords are stored in localStorage, keyed by raw URL.
// Legacy base64-JSON hashes are transparently migrated on first load.
// ═══════════════════════════════════════════════════════════════
function b64dec(str) {
  str = str.replace(/-/g,'+').replace(/_/g,'/');
  while (str.length%4) str+='=';
  return decodeURIComponent(escape(atob(str)));
}

// ── Per-source metadata (name, password) stored in localStorage ──
function _srcMetaKey(rawUrl) { return 'ol-src:' + rawUrl; }
function _getMeta(rawUrl) {
  try { return JSON.parse(localStorage.getItem(_srcMetaKey(rawUrl)) || 'null') || {}; } catch { return {}; }
}
function _setMeta(rawUrl, obj) {
  try {
    if (obj && (obj.name || obj.password))
      localStorage.setItem(_srcMetaKey(rawUrl), JSON.stringify(obj));
    else
      localStorage.removeItem(_srcMetaKey(rawUrl));
  } catch {}
}
function _delMeta(rawUrl) {
  try { localStorage.removeItem(_srcMetaKey(rawUrl)); } catch {}
}

function loadSources() {
  const h = location.hash.slice(1);
  if (!h) return [];
  // ── Legacy: base64-JSON format (auto-migrate) ──
  try {
    const arr = JSON.parse(b64dec(h));
    if (Array.isArray(arr)) {
      setTimeout(() => saveSources(arr), 0);
      return arr;
    }
  } catch {}
  // ── New format: pipe-separated raw URLs ──
  // A literal '|' inside a URL must be encoded as %7C
  return h.split('|').filter(Boolean).map(seg => {
    const rawUrl = seg.replace(/%7C/gi, '|');
    const meta = _getMeta(rawUrl);
    return { url: rawUrl, name: meta.name || rawUrl,
             ...(meta.password ? { password: meta.password } : {}) };
  });
}

function saveSources(arr) {
  // Write human-readable pipe-separated raw URLs to the hash
  const hash = arr.map(s => s.url.replace(/\|/g, '%7C')).join('|');
  history.replaceState(null, '', '#' + hash);
  // Persist names and passwords in localStorage
  arr.forEach(s => _setMeta(s.url, { name: s.name, password: s.password }));
}

// ── Normalise URL — expand shorthands for network use only ──
// The raw/shorthand form is always what gets stored.
function normaliseUrl(url) {
  url = url.trim();
  // github:owner/repo            →  …/owner/repo/refs/heads/main
  // github:owner/repo/some/path  →  …/owner/repo/refs/heads/main/some/path
  const ghMatch = url.match(/^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.\-]+)(\/.*)?$/i);
  if (ghMatch) {
    const subpath = (ghMatch[2] || '').replace(/\/+$/, '');
    url = `https://raw.githubusercontent.com/${ghMatch[1]}/refs/heads/main${subpath}`;
  }
  return url.replace(/\/+$/, '');
}

// ── Application state ──
// sources  = [{url, name, password?}]
// libs     = Map<normalisedUrl, {name, encryption_type, links, books: Map<id, entry>}>
// books    = [] (flat merged view)
// filtered = [] (after search + sort)
const state = {
  sources: loadSources(),
  libs: new Map(),
  books: [],
  filtered: [],
  page: 1,
  perPage: 4, // recalculated dynamically as getGridColumns() * 5
  search: '',
  sort: 'series',
  coverCache: new Map() // bookId → objectURL
};
