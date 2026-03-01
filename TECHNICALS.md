# OpenLibrary — Technical Reference

This document explains the technical processes behind every component of OpenLibrary in detail.  
For a general overview see [README.md](README.md). For known public libraries see [INDEX.md](INDEX.md).

---

## Table of Contents

- [System Overview](#system-overview)
- [Encryption Model](#encryption-model)
  - [Index Encryption (PBKDF2 + AES-GCM)](#index-encryption-pbkdf2--aes-gcm)
  - [File Encryption (Per-Book Key + AES-GCM)](#file-encryption-per-book-key--aes-gcm)
  - [Wire Formats](#wire-formats)
  - [Why AES-256-GCM?](#why-aes-256-gcm)
- [The Library CLI (`library.go`)](#the-library-cli-librarygo)
  - [Two-Phase Scan](#two-phase-scan)
  - [Metadata Extraction](#metadata-extraction)
  - [Cover Extraction](#cover-extraction)
  - [Index Construction and Encryption](#index-construction-and-encryption)
- [The Web UI (`js/app.js`)](#the-web-ui-jsappjs)
  - [URL-Hash State](#url-hash-state)
  - [Library Loading Pipeline](#library-loading-pipeline)
  - [Book Deduplication and Merging](#book-deduplication-and-merging)
  - [Lazy Cover Loading](#lazy-cover-loading)
  - [Download Pipeline](#download-pipeline)
  - [Theme System](#theme-system)
- [The EPUB Reader (`reader/js/reader.js`)](#the-epub-reader-readerjsreaderjs)
  - [Reader URL Protocol](#reader-url-protocol)
  - [ZIP Parser](#zip-parser)
  - [EPUB Structure Parsing](#epub-structure-parsing)
  - [TOC Parsing (EPUB2 NCX and EPUB3 nav)](#toc-parsing-epub2-ncx-and-epub3-nav)
  - [Blob URL Builder](#blob-url-builder)
  - [HTML Rewriter](#html-rewriter)
  - [Iframe Sandboxing and Click Interception](#iframe-sandboxing-and-click-interception)
  - [Scroll-Edge Chapter Navigation](#scroll-edge-chapter-navigation)
  - [TOC Sidebar Toggle (Wide vs. Narrow)](#toc-sidebar-toggle-wide-vs-narrow)
  - [Progress Persistence](#progress-persistence)
  - [File Upload Mode](#file-upload-mode)
- [CORS and the Dev Server](#cors-and-the-dev-server)
- [The Single-File Build (`build_combined.sh`)](#the-single-file-build-build_combinedsh)
- [Browser API Requirements](#browser-api-requirements)

---

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│  library.go (CLI, runs once at build time)                  │
│                                                             │
│  Input folder of .epub/.mobi/.pdf/.azw3                     │
│       ↓  Two-phase scan + metadata extraction               │
│  Per-book:  random UUID · random 256-bit key                │
│       ↓  AES-256-GCM encrypt each file                      │
│  Individual .enc files                                      │
│       ↓  Build JSON index · PBKDF2-derive key · GCM encrypt │
│  lib.json  (encrypted index + metadata)                     │
└──────────────────────┬──────────────────────────────────────┘
                       │  pushed to a static file host
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Static file host  (GitHub raw, nginx, Caddy, …)           │
│  Serves lib.json and *.enc over HTTPS with CORS headers     │
└──────────────────────┬──────────────────────────────────────┘
                       │  fetch() over HTTPS
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Browser — Web UI (index.html + css/style.css + js/app.js)  │
│                                                             │
│  Fetch lib.json → PBKDF2-derive key → AES-GCM decrypt index│
│  Browse grid → click Download → fetch .enc → GCM decrypt   │
│  → Blob URL → <a download>                                  │
│                                                     │       │
│  click Read Online → reader/index.html              │       │
└─────────────────────────────────────────────────────┼───────┘
                                                       │
┌──────────────────────────────────────────────────────▼──────┐
│  EPUB Reader  (reader/index.html + reader.css + reader.js)  │
│                                                             │
│  Fetch .enc → AES-GCM decrypt → raw EPUB bytes             │
│  Manual ZIP parse → EPUB structure parse                    │
│  Blob URL replace all assets/CSS → rewrite chapter XHTML   │
│  → srcdoc into sandboxed <iframe>                           │
└─────────────────────────────────────────────────────────────┘
```

---

## Encryption Model

### Index Encryption (PBKDF2 + AES-GCM)

The book index is encrypted with a key derived from a password using PBKDF2:

```
password  →  PBKDF2-SHA256( salt=random 16 B, iterations=100 000, keyLen=32 B )
          →  32-byte AES key
          →  AES-256-GCM( nonce=random 12 B )
          →  ciphertext
```

The password for public libraries (`encryption_type 0`) is the literal string `"0"`. This is not security through obscurity — the value is publicly documented. Its purpose is solely to prevent automated content scanning by file hosts; anyone can decrypt with the published parameters.

The encrypted index is then base64-encoded and stored as the `index` field in `lib.json`.

### File Encryption (Per-Book Key + AES-GCM)

Each book (and its cover image) is encrypted with its own randomly generated 256-bit key:

```
random 32-byte key  →  AES-256-GCM( nonce=random 12 B )  →  ciphertext
```

The per-book key is stored (in hex) as `source_key` inside the encrypted index. An attacker cannot obtain the key without first decrypting the index.

### Wire Formats

| Artefact | Binary layout |
|----------|--------------|
| `lib.json → index` (base64 of) | `[Salt 16 B][Nonce 12 B][GCM Ciphertext + 16 B tag]` |
| `*.enc` book / cover files | `[Nonce 12 B][GCM Ciphertext + 16 B tag]` |

The GCM authentication tag (16 bytes) is appended by the Go `crypto/cipher` AEAD interface and verified automatically by the Web Crypto `subtle.decrypt` call. Tampered files are rejected before any bytes are returned.

### Why AES-256-GCM?

- **Authenticated encryption**: the tag detects any modification to the ciphertext, protecting against bit-flip attacks.
- **No padding needed**: GCM is a stream mode; ciphertext length equals plaintext length.
- **Native browser support**: AES-GCM is the only AEAD available in the Web Crypto API at this level of browser compatibility.
- **Go standard library**: `crypto/aes` + `cipher.NewGCM` — no third-party dependencies needed in the CLI.

---

## The Library CLI (`library.go`)

### Two-Phase Scan

The CLI processes the input folder in two passes to correctly group multi-format books:

**Phase 1 — EPUB inventory**  
All `.epub` files are indexed, keyed by their lowercased filename stem (the name without extension). For each EPUB, metadata is extracted, a UUID is assigned, and a 256-bit encryption key is generated.

**Phase 2 — Derivative attachment**  
`.mobi`, `.azw3`, and `.pdf` files are processed. Each is matched against the Phase 1 map by lowercase stem. If a matching EPUB exists, the derivative is added to that book's `FormatFiles` map under its format key. Derivatives without a matching EPUB are skipped with an informational log message.

This design means:
- Format variants are always grouped under the EPUB as the canonical entry.
- Standalone non-EPUB files are silently ignored, preventing orphaned entries.
- The stem match is case-insensitive to handle inconsistent naming from different tools.

### Metadata Extraction

For EPUB files, metadata is read from the OPF document inside the zip:

1. `META-INF/container.xml` → OPF path.
2. OPF `<dc:title>`, `<dc:creator>`, and the Calibre series extensions (`calibre:series`, `calibre:series_index`) are parsed to populate `title`, `author`, `series`, and `series_index`.
3. If the MOBI fallback is used (no EPUB for this entry), the MOBI header is read directly for the same fields.

### Cover Extraction

Cover extraction follows a priority chain:

1. OPF manifest item with `id="cover-image"` or `properties="cover-image"`.
2. OPF `<meta name="cover">` pointing to a manifest item.
3. First image in the OPF manifest with a recognised image MIME type.

The extracted cover bytes are encrypted separately (same AES-GCM, separate nonce and key) and stored as `<uuid>-cover.enc`. The symmetric key used is the same per-book `source_key` as the book file itself — the browser reuses it for cover decryption.

### Index Construction and Encryption

After both phases, a `map[uuid]IndexEntry` is serialised to JSON, then:

1. A fresh random 16-byte PBKDF2 salt is generated.
2. The password is derived to a 32-byte AES key via PBKDF2-SHA256 (100 000 iterations).
3. A fresh random 12-byte GCM nonce is generated.
4. The JSON bytes are encrypted with AES-256-GCM.
5. The result is laid out as `[salt][nonce][ciphertext]` and base64-encoded into `lib.json`.

---

## The Web UI (`js/app.js`)

### URL-Hash State

Sources are persisted in `location.hash` as a base64url-encoded JSON array:

```
#<base64url( JSON.stringify([ {url, name}, … ]) )>
```

`history.replaceState` is used so the address bar updates without adding browser history entries. On load, `location.hash` is decoded and all sources are fetched. This means:
- No server-side session, no cookies, no localStorage needed for sources.
- A URL can be bookmarked or shared and the recipient gets the same library configuration.
- The hash changes live as sources are added/removed.

### Library Loading Pipeline

```
addSource(url)
  → fetch(url + '/lib.json')
  → decryptIndex(libJson, password)          // PBKDF2 + AES-GCM
  → JSON.parse(plaintext)                    // book index Map
  → state.libs.set(url, { name, books })
  → rebuildBookList()
  → applyFilter()
  → renderAll()
```

All sources are loaded in parallel via `Promise.allSettled`. Failures are surfaced in a status banner without blocking successfully-loaded sources from rendering.

### Book Deduplication and Merging

`mergeBooks()` iterates the flat list of `(book, source)` pairs and merges by a composite key:

```
key = title.toLowerCase() + '\x00' + author.toLowerCase() + '\x00' + series.toLowerCase()
```

The first occurrence becomes the canonical record. Subsequent matches push their `FormatEntry` objects into the canonical record's `formatEntries` array and set `merged = true`. The modal uses `merged` to decide whether to suffix button labels with the source library name.

`buildFormatEntries(book)` expands a raw index entry into one descriptor per format:

```js
{ format, libUrl, libName, sourceFile, filesize, sourceKey, bookId }
```

This flat structure means the download and read buttons are each bound to a single self-contained descriptor — no secondary lookups needed at click time.

### Lazy Cover Loading

Covers are loaded lazily via `IntersectionObserver`:

1. Each card renders a placeholder `<div class="lazy-cover">`.
2. An `IntersectionObserver` with `rootMargin: '100px'` watches all placeholders.
3. When a placeholder scrolls into the viewport (with 100 px look-ahead), `loadCover(bookId)` is called.
4. The `.enc` cover is fetched, decrypted with the per-book key, and converted to a Blob URL.
5. The placeholder is replaced with an `<img>` element.
6. The Blob URL is cached in `state.coverCache` so re-renders reuse it without re-fetching.

### Download Pipeline

```
downloadBook(fe, entry, btn)
  → fetch(normaliseUrl(libUrl) + '/' + sourceFile)   // raw encrypted bytes
  → CRYPTO.decryptWithKey(arrayBuffer, hexToBuffer(sourceKey))
  → new Blob([plainBytes], { type: mimeForFormat })
  → URL.createObjectURL(blob)
  → <a download="Title - Author.format"> .click()
  → setTimeout: URL.revokeObjectURL + remove <a>
```

Nothing is sent to any server. The browser performs the fetch, the Web Crypto API performs the decryption entirely in the JS engine, and the result is handed to the browser's built-in download handler.

### Theme System

Themes are implemented with CSS custom properties on `html[data-theme]`:

- Dark (default, no attribute set)
- Light (`data-theme="light"`)
- Auto (no attribute; `@media (prefers-color-scheme: light)` activates the light variable set)

On load, an inline `<script>` in `<head>` applies the saved theme from `localStorage` *before* the first CSS paint, preventing a flash of the wrong theme. `applyTheme()` sets or removes `dataset.theme` and saves to `localStorage`.

---

## The EPUB Reader (`reader/js/reader.js`)

### Reader URL Protocol

The library encodes a JSON object into the reader URL's fragment using base64url:

```js
// Encode (app.js)
const params = JSON.stringify({ src, key, title, libHash });
const fragment = btoa(unescape(encodeURIComponent(params)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
// → reader/index.html#<fragment>

// Decode (reader.js)
function parseHash() {
  let s = location.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return JSON.parse(decodeURIComponent(escape(atob(s))));
}
```

Fields in the params object:

| Field | Type | Purpose |
|-------|------|---------|
| `src` | string | Full URL of the encrypted `.enc` file |
| `key` | string | 64-character hex per-book decryption key |
| `title` | string | Book title hint (shown while loading) |
| `libHash` | string | The library's `location.hash` — used to restore the back button destination |

### ZIP Parser

The EPUB container is a ZIP file. The reader implements a minimal hand-written ZIP parser rather than using any library:

**Step 1 — Find the End of Central Directory (EOCD)**  
Scan backwards from the end of the buffer looking for the 4-byte magic `0x06054b50`. This gives the count of central directory entries and the offset of the central directory.

**Step 2 — Walk the Central Directory**  
Each Central Directory record (`0x02014b50`) yields the filename, compression method, compressed size, and the offset of the matching Local File Header.

**Step 3 — Local File Headers**  
The data offset is computed as: LFH base offset + 30 + filename length + extra field length. The compressed data starts there.

**Step 4 — Decompression**  
- Method `0` (stored): data is already uncompressed.
- Method `8` (deflated): data is decompressed using `DecompressionStream('deflate-raw')` — the browser's native zlib decompressor, which handles raw DEFLATE (without zlib wrapper).

The result is a `Map<path, Uint8Array>` covering every file in the ZIP.

### EPUB Structure Parsing

**`container.xml`** is read from `META-INF/container.xml`. The `<rootfile full-path>` attribute gives the path to the OPF Package Document.

**OPF parsing** (`parseOPF`):
- Metadata: `<dc:title>`, `<dc:creator>` via CSS selector `metadata title` / `metadata creator` (handles both namespaced and non-namespaced variants).
- Manifest: all `<item>` elements → `Map<id, {href, mediaType, properties}>`. `href` is de-percent-encoded and resolved to an absolute path within the ZIP using `resolvePath(opfBase, href)`.
- Spine: `<itemref idref>` elements in document order, filtering out `linear="no"` items.
- NCX location: the `toc` attribute on `<spine>`, or a manifest item with `media-type="application/x-dtbncx+xml"`.
- Nav doc location: a manifest item with `properties="nav"`.

**`resolvePath(base, relative)`** handles `..` segments and leading `/` references (treated as relative to the ZIP root, not an absolute filesystem path).

### TOC Parsing (EPUB2 NCX and EPUB3 nav)

**EPUB3 nav.xhtml** (`parseNavDoc`):  
Finds `<nav epub:type="toc">` (or falls back to any `<nav>`). Recursively walks `<ol><li><a>` trees; depth is tracked for indentation in the UI. `href` attributes are resolved relative to the nav document's path in the ZIP.

**EPUB2 NCX** (`parseNCX`):  
Walks `<navMap><navPoint>` trees recursively. The chapter href comes from the `src` attribute of `<content>`, split on `#` to separate the path from the anchor fragment.

**Fallback chain**: EPUB3 nav is tried first; if it yields no items, EPUB2 NCX is tried. The result is flattened to a depth-annotated list for rendering.

### Blob URL Builder

Assets must be converted to Blob URLs before being embedded in srcdoc HTML, because relative file paths do not work inside a document set via `srcdoc`.

**Pass 1 — Binary assets**  
Images (`jpg/jpeg/png/gif/webp/svg`) and fonts (`ttf/otf/woff/woff2`) are converted to Blob URLs with their correct MIME type:

```js
URL.createObjectURL(new Blob([bytes], { type: mimeForExt }))
```

**Pass 2 — CSS files**  
Each CSS file's text is processed through `rewriteUrlRefs()`, which rewrites `url(...)` references to point to the already-created binary Blob URLs. Then the rewritten CSS string is turned into its own Blob URL. This two-pass order ensures CSS can reference image Blob URLs that were created in Pass 1.

### HTML Rewriter

Each chapter file (XHTML/HTML) is rewritten as a text string before being injected into the iframe. DOM parsing is deliberately avoided here because XHTML documents often have XML peculiarities that browsers handle inconsistently in the HTML parser.

**XML declaration stripping**  
`<?xml version="1.0" encoding="UTF-8"?>` preambles are stripped since they cause parse errors in some browsers when set via `srcdoc`.

**Attribute reference rewriting** (`rewriteAttrRefs`)  
A regex over `src=`, `href=`, and `poster=` attributes replaces relative paths with Blob URLs. HTTP/HTTPS URLs, data: URIs, `#` fragments, `mailto:`, and `javascript:` are passed through unchanged.

**`url()` rewriting** (`rewriteUrlRefs`)  
Applied to the content of `<style>` blocks and `style="..."` inline attributes.

**Override style injection**  
A `<style id="ol-reader-overrides">` block is injected just before `</head>` (or prepended if no `<head>` exists). It:
- Sets `max-width`, `margin`, `padding`, `line-height`, `font-family`, `font-size` on `html, body`.
- Sets `background` and `color` on `html, body` per the active theme.
- Sets `color` on `*,*::before,*::after` (overriding EPUB-specific colour rules that would otherwise make text invisible on dark themes).
- Sets `color` on `a, a *` to the theme's link colour.
- Constrains `img` and `svg` to `max-width: 100%`.

### Iframe Sandboxing and Click Interception

The `<iframe>` has `sandbox="allow-same-origin allow-scripts"`:

- `allow-same-origin`: required for the parent page to access `contentDocument` and add event listeners. Without it, cross-origin isolation would apply even to srcdoc.
- `allow-scripts`: required to let EPUB JS (e.g. flip animations in some books) run. Most EPUBs don't use JS but this ensures compatibility.
- Deliberately absent: `allow-top-navigation`, `allow-popups`, `allow-forms` — external navigation and form submissions are blocked.

After each `frame.onload`, a `click` event listener is added to `frame.contentDocument`. It:

1. Walks up to the nearest `<a href>` ancestor.
2. **External URLs** (`http://`, `https://`): `preventDefault()` + `window.open(..., '_blank', 'noopener,noreferrer')`.
3. **Pure anchors** (`#id`): `preventDefault()` + `scrollIntoView` on the target element.
4. **In-book relative paths**: resolved using `resolvePath` against the current chapter's base path, then matched against the spine array. If found, `goToChapter(spineIndex, anchor)` is called; if not found (e.g. a link to an image-only page), the click is silently swallowed.

### Scroll-Edge Chapter Navigation

A `wheel` event listener is added to `frame.contentDocument` on every chapter load:

```js
doc.addEventListener('wheel', (e) => {
  const el = doc.scrollingElement || doc.documentElement;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  const atTop    = el.scrollTop <= 0;
  if (e.deltaY > 0 && atBottom) _triggerChapterNav('next');
  if (e.deltaY < 0 && atTop)    _triggerChapterNav('prev');
}, { passive: true });
```

A 4-pixel tolerance on `atBottom` accounts for subpixel rendering. A cooldown of 800 ms prevents a single fast scroll from skipping multiple chapters.

When navigating backwards via scroll-up, `_scrollToEnd = true` is set. The next chapter's `onload` handler then sets `scrollTop = scrollHeight`, so the reader lands at the bottom and the transition reads as continuous.

### TOC Sidebar Toggle (Wide vs. Narrow)

The CSS uses two different mechanisms depending on screen width:

| Width | Mechanism |
|-------|-----------|
| `< 900 px` | `.toc-sidebar.open { transform: none; }` — slides in from the left as an overlay; `.toc-backdrop.show` blocks the reading pane. |
| `≥ 900 px` | `position: relative; transform: none` (media query) — sidebar is always inline; `.toc-sidebar.collapsed { transform: translateX(-100%); position: absolute; }` hides it. |

`toggleToc()` detects width with `window.innerWidth >= 900` and toggles the appropriate class. Before toggling, the iframe's `scrollTop` is saved; two `requestAnimationFrame` ticks after the toggle it is restored, preventing the layout reflow from resetting scroll position.

### Progress Persistence

Reading progress is saved to `localStorage` under a per-book key:

```
key:   'ol-progress:' + params.src
value: chapter index (integer, as string)
```

`saveProgress(chapter)` is called every time `goToChapter` runs. `loadProgress()` is called once during `init()`. For locally-uploaded files the URL is set to `'local:' + file.name`, providing per-filename progress isolation.

### File Upload Mode

When the reader is opened without a valid URL hash (no `src` + `key` parameters), it enters upload mode:

1. The loading status overlay is hidden; `#navBar` is hidden.
2. `#uploadZone` is shown — a centred drop zone with a file picker.
3. Three input paths all funnel into `loadFromFile(file)`:
   - `<input type="file">` change event.
   - Click on the drop zone (delegates to the input).
   - `dragover` / `drop` on the upload zone, or anywhere on the `window`.

`loadFromFile` reads the file as an `ArrayBuffer`, sets `state.params.src` to `'local:' + file.name` (for progress keying), then calls the shared `loadEpub(buffer, title)` pipeline — bypassing the fetch and decrypt steps entirely since the file is already plaintext.

---

## CORS and the Dev Server

Browsers enforce the Same-Origin Policy on `fetch()`. When the page is served from `localhost:8080` and fetches a library from `raw.githubusercontent.com`, the browser checks that the response includes:

```
Access-Control-Allow-Origin: *
```

GitHub's raw CDN sends this header automatically. For local testing, `serve.py` adds it manually:

```python
self.send_header('Access-Control-Allow-Origin', '*')
```

`python3 -m http.server` does not add this header, which is why it cannot be used as a substitute.

---

## The Single-File Build (`build_combined.sh`)

`build_combined.sh` produces `index_combined.html` by inlining `css/style.css` and `js/app.js` directly into `index.html`:

1. The `<link rel="stylesheet" href="css/style.css">` tag is replaced with `<style>` containing the file's contents.
2. The `<script src="js/app.js">` tag is replaced with `<script>` containing the file's contents.
3. The result is written to `index_combined.html`.

The reader (`reader/`) is **not** inlined into the combined file — it remains a separate directory. The combined build is intended for the main library browser only; the reader is always multi-file.

The combined file can be opened directly from disk (`file://`) without a web server. Fetch calls to library sources (external URLs) still work from `file://` as long as the source sends CORS headers.

---

## Browser API Requirements

| API | Used for | Available since |
|-----|----------|----------------|
| `crypto.subtle.decrypt` (AES-GCM) | Decrypting index and book files | Chrome 37, Firefox 34, Safari 11 |
| `crypto.subtle.deriveBits` (PBKDF2) | Deriving the index decryption key from password | Chrome 37, Firefox 34, Safari 11 |
| `DecompressionStream('deflate-raw')` | Decompressing DEFLATE entries in EPUB ZIPs | Chrome 80, Firefox 113, Safari 16.4 |
| `IntersectionObserver` | Lazy cover image loading | Chrome 51, Firefox 55, Safari 12.1 |
| `URL.createObjectURL` | Turning decrypted bytes into loadable URLs | Universal |
| `history.replaceState` | Updating the URL hash without a page reload | Universal |
| `localStorage` | Persisting theme and reading progress | Universal |
| `fetch` | Loading library files and encrypted books | Universal |
| `DOMParser` | Parsing EPUB XML/HTML structures | Universal |
| `TextDecoder` | Decoding UTF-8 / Latin-1 bytes from ZIP | Chrome 38, Firefox 19, Safari 10.1 |

The binding constraint is `DecompressionStream('deflate-raw')`, which requires Chrome 80+, Firefox 113+, or Safari 16.4+. All other APIs are available in any browser that supports DecompressionStream.
