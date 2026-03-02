'use strict';

// ═══════════════════════════════════════════════════════════════
// main.js — utilities, theme, event wiring, app init
// Depends on: all other js/ modules
// ═══════════════════════════════════════════════════════════════

// ── Utilities ──
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

let _statusTimer = null;
function showStatus(msg, type='info', duration=5000) {
  const el = document.getElementById('statusBanner');
  el.textContent = msg;
  el.className = 'status-banner show ' + type;
  clearTimeout(_statusTimer);
  if (duration > 0) _statusTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ── Theme management ──
function applyTheme(val) {
  if (val === 'light' || val === 'dark' || val === 'sepia') {
    document.documentElement.dataset.theme = val;
  } else {
    delete document.documentElement.dataset.theme;
  }
  const sel = document.getElementById('themeSelect');
  if (sel) sel.value = val;
  try { localStorage.setItem('ol-theme', val); } catch {}
}
// Apply saved theme before first paint to avoid flash
(function() {
  let saved = 'auto';
  try { saved = localStorage.getItem('ol-theme') || 'auto'; } catch {}
  applyTheme(saved);
})();

// ═══════════════════════════════════════════════════════════════
// Event wiring
// ═══════════════════════════════════════════════════════════════
document.getElementById('themeSelect').addEventListener('change', e => applyTheme(e.target.value));

document.getElementById('btnAdd').addEventListener('click', () => {
  closeSourcesManager();
  openAddDialog();
});
document.getElementById('addCancel').addEventListener('click', closeAddDialog);
document.querySelector('.hint-fill-btn')?.addEventListener('click', e => {
  e.preventDefault();
  document.getElementById('addUrl').value = 'github:Auchrio/OpenLibrary';
  document.getElementById('addUrl').focus();
});
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

// Key prompt overlay
document.getElementById('keyCancel').addEventListener('click', closeKeyPrompt);
document.getElementById('keyUnlockBtn').addEventListener('click', tryUnlockKey);
document.getElementById('keyInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') tryUnlockKey();
});

document.getElementById('searchInput').addEventListener('input', e => {
  state.search = e.target.value;
  applyFilter();
});

document.getElementById('sortSelect').addEventListener('change', e => {
  state.sort = e.target.value;
  applyFilter();
});

// Re-paginate when the window is resized and the column count changes
;(function() {
  let _cols = 0, _raf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(_raf);
    _raf = requestAnimationFrame(() => {
      const cols = getGridColumns();
      if (cols !== _cols) {
        _cols = cols;
        state.page = 1;
        renderGrid();
        renderPagination();
      }
    });
  });
})();

// ═══════════════════════════════════════════════════════════════
// Initialise — load all sources from URL hash
// ═══════════════════════════════════════════════════════════════
(async function init() {
  renderAll(); // show empty state / chips immediately
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
