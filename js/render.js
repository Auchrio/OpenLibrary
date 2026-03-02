'use strict';

// ═══════════════════════════════════════════════════════════════
// Rendering — DOM updates for the book grid, source chips,
// pagination, and lazy cover loading
// Depends on: crypto.js, state.js, library.js
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
    es.querySelector('.empty-title').textContent = 'No library sources loaded';
    es.querySelector('.empty-sub').innerHTML =
      'Click <strong>+ Add Source</strong> and enter a library URL to get started, or <a class="src-index-link empty-index-link" href="#">click here to add the library index immediately</a>.';
    es.querySelector('.empty-index-link').addEventListener('click', e => {
      e.preventDefault();
      openAddDialog(true);
      document.getElementById('addUrl').value = 'github:Auchrio/OpenLibrary';
      document.getElementById('addUrl').focus();
    });
  } else if (total===0 && state.sources.length>0) {
    es.classList.add('show');
    es.querySelector('.empty-title').textContent = 'No books found';
    es.querySelector('.empty-sub').innerHTML =
      'Your sources loaded but returned no books. Try clicking <strong>↺ Refresh</strong> in the Sources manager, or check that your library URLs are correct.';
  } else {
    es.classList.remove('show');
  }
}

function renderChips() {
  const list = document.getElementById('srcList');
  list.innerHTML = '';

  if (state.sources.length === 0) {
    list.innerHTML = '<div class="src-empty">No sources added yet, <a class="src-index-link" href="#">click here to add the library index.</a></div>';
    list.querySelector('.src-index-link').addEventListener('click', e => {
      e.preventDefault();
      closeSourcesManager();
      openAddDialog(true);
      document.getElementById('addUrl').value = 'github:Auchrio/OpenLibrary';
      document.getElementById('addUrl').focus();
    });
  } else {
    for (const src of state.sources) {
      const url = normaliseUrl(src.url);
      const lib = state.libs.get(url);
      const name = lib ? lib.name : src.name || src.url;

      let countHtml;
      if (lib) {
        const bc = lib.books.size;
        const lc = (lib.links || []).length;
        const bPart = `<span class="src-count-badge">${bc} book${bc!==1?'s':''}</span>`;
        const lPart = lc ? `<span class="src-count-badge">${lc} link${lc!==1?'s':''}</span>` : '';
        countHtml = bPart + lPart;
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

  // Update header button label
  const n = state.sources.length;
  const srcBtn = document.getElementById('btnSources');
  document.getElementById('srcBtnLabel').textContent =
    n === 0 ? '+ Add Source' : `📚 Sources (${n})`;
  srcBtn.classList.toggle('btn-sources--cta', n === 0);

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

// ── Returns the number of columns currently rendered in the book grid ──
function getGridColumns() {
  const grid = document.getElementById('bookGrid');
  if (!grid) return 4;
  const tpl = getComputedStyle(grid).gridTemplateColumns;
  if (tpl && tpl !== 'none' && /\d/.test(tpl)) {
    const cols = tpl.trim().split(/\s+/).length;
    if (cols > 0) return cols;
  }
  // Fallback: estimate from content width (24px padding each side, 18px gap, 160px min card)
  const w = (grid.clientWidth || window.innerWidth) - 48;
  return Math.max(1, Math.floor((w + 18) / (160 + 18)));
}

function renderGrid() {
  const grid = document.getElementById('bookGrid');
  // Always show 5 complete rows regardless of column count
  state.perPage = getGridColumns() * 5;
  grid.innerHTML = '';
  const start = (state.page-1)*state.perPage;
  const page = state.filtered.slice(start, start+state.perPage);
  for (const book of page) {
    const card = makeCard(book);
    grid.appendChild(card);
  }
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
  if (state.coverCache.has(book.id)) {
    replaceCoverPlaceholder(card, state.coverCache.get(book.id));
  }
  card.addEventListener('click', () => openBookModal(book));
  return card;
}

// ── Lazy cover loading via IntersectionObserver ──
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
    // Update card placeholder on current page
    const ph = document.getElementById('cp-'+bookId);
    if (ph) {
      const card = ph.closest('.book-card');
      if (card) replaceCoverPlaceholder(card, url);
    }
    // Update book modal if it's showing this book
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

  // Always show first, last, and up to 2 pages on either side of current
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
