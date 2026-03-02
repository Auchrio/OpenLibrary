'use strict';

// ═══════════════════════════════════════════════════════════════
// Source management — add/remove sources, add-source dialog,
// sources manager overlay, key/password prompt
// Depends on: state.js, library.js, render.js
// ═══════════════════════════════════════════════════════════════

function removeSource(rawUrl) {
  const url = normaliseUrl(rawUrl);
  // Clean up localStorage metadata
  state.sources.filter(s => normaliseUrl(s.url) === url).forEach(s => _delMeta(s.url));
  state.sources = state.sources.filter(s => normaliseUrl(s.url) !== url);
  const lib = state.libs.get(url);
  if (lib) {
    for (const [id] of lib.books) {
      const cached = state.coverCache.get(id);
      if (cached) { URL.revokeObjectURL(cached); state.coverCache.delete(id); }
    }
  }
  state.libs.delete(url);
  saveSources(state.sources);
  rebuildBookList();
  renderAll();
}

async function addSource(rawUrl, name, password) {
  // normaliseUrl only for network/dedup; rawUrl is what gets stored
  const url = normaliseUrl(rawUrl);
  if (!state.sources.find(s => normaliseUrl(s.url) === url)) {
    const src = { url: rawUrl, name: name || rawUrl };
    if (password != null) src.password = password;
    state.sources.push(src);
    saveSources(state.sources);
    renderChips();
  }
  try {
    const { name: realName } = await loadLibrary(url);
    const src = state.sources.find(s => normaliseUrl(s.url) === url);
    if (src) { src.name = realName || src.name; saveSources(state.sources); }
    renderAll();
  } catch(err) {
    showStatus('Error loading ' + rawUrl + ': ' + err.message, 'error');
    renderChips();
  }
}

// ═══════════════════════════════════════════════════════════════
// Refresh & link discovery
// ═══════════════════════════════════════════════════════════════

// Scan all loaded libs for links not yet in state.sources.
// Returns a Map<normalisedUrl, rawUrl> of newly discovered libraries.
// Cycle-safe: a URL already in state.sources is never returned.
function _collectNewLinks() {
  const existingNorm = new Set(state.sources.map(s => normaliseUrl(s.url)));
  const discovered = new Map(); // normUrl → rawUrl (first seen wins)
  for (const [, lib] of state.libs) {
    for (const rawLink of (lib.links || [])) {
      const normLink = normaliseUrl(String(rawLink));
      if (!existingNorm.has(normLink) && !discovered.has(normLink)) {
        discovered.set(normLink, String(rawLink));
      }
    }
  }
  return discovered;
}

async function refreshAllSources() {
  if (state.sources.length === 0) {
    showStatus('No sources to refresh.', 'info');
    return;
  }
  const btn = document.getElementById('srcRefreshBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Refreshing…';

  // Hide any previous discovery panel
  document.getElementById('srcDiscoverPanel').classList.remove('show');

  showStatus(`Refreshing ${state.sources.length} source${state.sources.length > 1 ? 's' : ''}…`, 'info', 0);

  const results = await Promise.allSettled(
    state.sources.map(s => loadLibrary(normaliseUrl(s.url)))
  );

  const errors = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
  if (errors.length) {
    showStatus(`Refresh done — ${errors.length} error(s): ${errors.join('; ')}`, 'error');
  } else {
    showStatus('All sources refreshed.', 'info', 3000);
  }

  renderAll();

  // Discover any new linked libraries (loop-safe: only shows URL not already loaded)
  const newLinks = _collectNewLinks();
  if (newLinks.size > 0) {
    _showDiscoverPanel(newLinks);
  }

  btn.disabled = false;
  btn.innerHTML = '↺ Refresh';
}

function _showDiscoverPanel(newLinks) {
  const panel = document.getElementById('srcDiscoverPanel');
  const list = document.getElementById('srcDiscoverList');
  list.innerHTML = '';

  for (const [normUrl, rawUrl] of newLinks) {
    const item = document.createElement('div');
    item.className = 'linked-item';
    item.innerHTML = `
      <input type="checkbox" id="disc-${esc(normUrl)}" value="${esc(rawUrl)}" checked>
      <div style="min-width:0">
        <div class="linked-name">${esc(rawUrl)}</div>
        <div class="linked-url">${esc(normUrl !== rawUrl ? normUrl : '')}</div>
      </div>
    `;
    list.appendChild(item);
  }

  panel.classList.add('show');
  // Scroll the list body so the panel is visible
  const srcList = document.getElementById('srcList');
  setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
}
function openSourcesManager() {
  document.getElementById('sourcesOverlay').classList.add('open');
}
function closeSourcesManager() {
  document.getElementById('sourcesOverlay').classList.remove('open');
  document.getElementById('srcImportPanel').classList.remove('show');
  document.getElementById('srcDiscoverPanel').classList.remove('show');
  document.getElementById('srcImportTa').value = '';
  document.getElementById('srcImportError').classList.remove('show');
}

document.getElementById('btnSources').addEventListener('click', openSourcesManager);
document.getElementById('srcMgrClose').addEventListener('click', closeSourcesManager);
document.getElementById('srcRefreshBtn').addEventListener('click', refreshAllSources);

document.getElementById('srcDiscoverDismiss').addEventListener('click', () => {
  document.getElementById('srcDiscoverPanel').classList.remove('show');
});

document.getElementById('srcDiscoverAddBtn').addEventListener('click', () => {
  const panel = document.getElementById('srcDiscoverPanel');
  const checked = panel.querySelectorAll('input[type=checkbox]:checked');
  if (checked.length === 0) { panel.classList.remove('show'); return; }
  panel.classList.remove('show');
  checked.forEach(cb => {
    addSource(cb.value);
  });
});

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
    const rawItemUrl = item.url;
    const normUrl = normaliseUrl(rawItemUrl);
    if (!state.sources.find(s => normaliseUrl(s.url) === normUrl)) {
      state.sources.push({ url: rawItemUrl, name: item.name || rawItemUrl });
      newSources.push({ url: rawItemUrl, name: item.name || rawItemUrl });
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

// ═══════════════════════════════════════════════════════════════
// Add-source dialog
// ═══════════════════════════════════════════════════════════════
let _pendingLib = null; // { url, name, links, encryptionType, libJson }

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
    const encryptionType = libJson.encryption_type;
    let bookCount = 0;
    if (!libJson.index) {
      bookCount = 0;
    } else if (encryptionType === 0) {
      try {
        const idx = await decryptIndex(libJson, '0');
        bookCount = Object.keys(idx).length;
      } catch { bookCount = '?'; }
    } else {
      bookCount = '🔐';
    }
    const links = libJson.links || [];
    // Support both new array format ["url"] and legacy {name: {link/url}} object format
    let linkEntries; // [{rawUrl, label}]
    if (Array.isArray(links)) {
      linkEntries = links.map(u => ({ rawUrl: String(u), label: String(u) }));
    } else {
      linkEntries = Object.entries(links)
        .filter(([,v]) => v && (v.link||v.url))
        .map(([name, v]) => ({ rawUrl: v.link || v.url, label: name }));
    }
    linkEntries = linkEntries.filter(e => e.rawUrl);

    document.getElementById('prevName').textContent = libJson.name || url;
    document.getElementById('prevCount').textContent = encryptionType !== 0 && libJson.index
      ? `🔐 Password required · type ${encryptionType}`
      : `${bookCount} book${bookCount!==1?'s':''}${linkEntries.length ? ` · ${linkEntries.length} link${linkEntries.length!==1?'s':''}` : ''}`;

    const lc = document.getElementById('linkedContainer');
    const ll = document.getElementById('linkedList');
    ll.innerHTML = '';
    if (linkEntries.length > 0) {
      lc.style.display = 'block';
      for (const { rawUrl, label } of linkEntries) {
        const linkUrl = normaliseUrl(rawUrl);
        const already = !!state.sources.find(s => normaliseUrl(s.url) === linkUrl);
        const item = document.createElement('div');
        item.className = 'linked-item';
        item.innerHTML = `
          <input type="checkbox" id="lnk-${esc(linkUrl)}" value="${esc(rawUrl)}" ${already ? 'disabled checked' : 'checked'}>
          <div>
            <div class="linked-name">${esc(label)}</div>
            <div class="linked-url">${esc(rawUrl)}</div>
          </div>
          ${already ? '<span class="linked-already">✓ already added</span>' : ''}
        `;
        ll.appendChild(item);
      }
    } else { lc.style.display = 'none'; }

    document.getElementById('addPreview').classList.add('show');
    document.getElementById('addConfirmBtn').style.display = '';
    document.getElementById('addPreviewBtn').style.display = 'none';
    _pendingLib = { url: raw, name: libJson.name||raw, links: linkEntries, encryptionType, libJson };
  } catch(err) {
    showAddError('Could not load library: '+err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Preview';
  }
}

async function confirmImport() {
  if (!_pendingLib) return;
  if (_pendingLib.encryptionType !== 0) {
    closeAddDialog();
    openKeyPrompt();
    return;
  }
  closeAddDialog();
  await addSource(_pendingLib.url, _pendingLib.name);
  document.querySelectorAll('#linkedList input[type=checkbox]:checked:not(:disabled)').forEach(cb => {
    const linkUrl = cb.value;
    const name = cb.closest('.linked-item').querySelector('.linked-name').textContent;
    addSource(linkUrl, name);
  });
}

// ── Key prompt (for password-protected libraries) ──────────────────────────
function openKeyPrompt() {
  document.getElementById('keyDlgDesc').textContent =
    `"${_pendingLib.name}" is password-protected. Enter the decryption password to unlock it.`;
  document.getElementById('keyInput').value = '';
  document.getElementById('keyError').classList.remove('show');
  document.getElementById('keyOverlay').classList.add('open');
  setTimeout(() => document.getElementById('keyInput').focus(), 80);
}

function closeKeyPrompt() {
  document.getElementById('keyOverlay').classList.remove('open');
}

async function tryUnlockKey() {
  if (!_pendingLib) return;
  const password = document.getElementById('keyInput').value;
  if (!password) { showKeyError('Please enter a password.'); return; }

  const btn = document.getElementById('keyUnlockBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Checking…';
  document.getElementById('keyError').classList.remove('show');
  try {
    const idx = await decryptIndex(_pendingLib.libJson, password);
    const bookCount = Object.keys(idx).length;
    closeKeyPrompt();
    await addSource(_pendingLib.url, _pendingLib.name, password);
    document.querySelectorAll('#linkedList input[type=checkbox]:checked:not(:disabled)').forEach(cb => {
      const linkUrl = cb.value;
      const name = cb.closest('.linked-item').querySelector('.linked-name').textContent;
      addSource(linkUrl, name);
    });
    showStatus(`"${_pendingLib.name}" unlocked — ${bookCount} book${bookCount!==1?'s':''} loaded.`, 'info');
  } catch {
    showKeyError('Incorrect password — decryption failed. Please try again.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Unlock';
  }
}

function showKeyError(msg) {
  const el = document.getElementById('keyError');
  el.textContent = msg;
  el.classList.add('show');
}

function showAddError(msg) {
  const el = document.getElementById('addError');
  el.textContent = msg; el.classList.add('show');
}
