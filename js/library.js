'use strict';

// ═══════════════════════════════════════════════════════════════
// Library loader — fetches, decrypts and indexes lib.json files
// Depends on: crypto.js, state.js
// ═══════════════════════════════════════════════════════════════

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
  const src = state.sources.find(s => normaliseUrl(s.url) === url);
  const libJson = await fetchLib(url);
  let bookMap = new Map();
  // An index-less lib (links-only) has no `index` field — skip decryption entirely.
  if (libJson.index) {
    let password;
    if (libJson.encryption_type === 0) {
      password = '0';
    } else if (src?.password) {
      password = src.password;
    } else {
      throw new Error('Library requires a password — remove and re-add the source to enter one.');
    }
    const books = await decryptIndex(libJson, password);
    bookMap = new Map(Object.entries(books));
  }
  state.libs.set(url, {
    name: libJson.name || url,
    encryption_type: libJson.encryption_type,
    links: libJson.links || [],
    books: bookMap
  });
  rebuildBookList();
  return { name: libJson.name, links: libJson.links || [], bookCount: bookMap.size };
}

// ── Build a flat array of per-format download descriptors for one raw book ──
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

// ── Merge raw books that share (title, author, series) into a single UI record ──
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
