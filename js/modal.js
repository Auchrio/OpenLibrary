'use strict';

// ═══════════════════════════════════════════════════════════════
// Book detail modal — display, cover, download, reader link
// Depends on: crypto.js, state.js, render.js
// ═══════════════════════════════════════════════════════════════

function openBookModal(book) {
  const e = book.entry;
  // Guard: if the modal elements are missing (e.g. stale cached HTML),
  // bail out rather than throwing an unhandled error.
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

  const uniqueFormats = [...new Set(book.formatEntries.map(fe => fe.format))];
  document.getElementById('bmFormats').textContent = uniqueFormats.join(', ') || '—';

  const srcNames = [...new Set(book.formatEntries.map(fe => fe.libName))];
  document.getElementById('bmSource').textContent = srcNames.join(' · ');

  // Cover
  const bmCoverEl = document.getElementById('bmCover');
  const ph = document.getElementById('bmCoverPh');
  ph.textContent = (e.title||'?')[0].toUpperCase();
  ph.style.display = 'flex';
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
    loadCover(book.id); // async, updates when ready
  }

  // Download buttons — deduplicate across sources by format+filesize
  const btns = document.getElementById('bmDlButtons');
  const seen = new Map(); // "format:filesize" → true
  const dedupedEntries = book.formatEntries.filter(fe => {
    if (!fe.filesize) return true; // can't tell — keep all
    const key = `${fe.format}:${fe.filesize}`;
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });

  btns.innerHTML = '';
  if (dedupedEntries.length === 0) {
    btns.innerHTML = '<span style="color:var(--muted);font-size:.82rem">No downloadable formats found.</span>';
  } else {
    // Read Online first
    for (const fe of dedupedEntries) {
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
    for (const fe of dedupedEntries) {
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
        const pct = Math.round((received / contentLength) * 88);
        setProgress(pct, `${CRYPTO.formatBytes(received)} / ${CRYPTO.formatBytes(contentLength)}`);
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
