#!/usr/bin/env bash
# build_combined.sh
# Concatenates all split CSS and JS files, then inlines them into index.html
# to produce index_combined.html — a single portable file with no external deps.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python3 - "$SCRIPT_DIR" <<'PYEOF'
import sys, pathlib

root = pathlib.Path(sys.argv[1])

html = (root / "index.html").read_text()

# ── CSS: concatenate in load order ──
css_files = [
    root / "css" / "themes.css",
    root / "css" / "layout.css",
    root / "css" / "sources.css",
    root / "css" / "modals.css",
]
css = "\n".join(f.read_text() for f in css_files)

# ── JS: concatenate in dependency order ──
js_files = [
    root / "js" / "crypto.js",
    root / "js" / "state.js",
    root / "js" / "library.js",
    root / "js" / "render.js",
    root / "js" / "modal.js",
    root / "js" / "sources.js",
    root / "js" / "main.js",
]
js = "\n".join(f.read_text() for f in js_files)

# ── Inline CSS: replace the four <link> tags with a single <style> block ──
css_links = (
    '  <link rel="stylesheet" href="css/themes.css">\n'
    '  <link rel="stylesheet" href="css/layout.css">\n'
    '  <link rel="stylesheet" href="css/sources.css">\n'
    '  <link rel="stylesheet" href="css/modals.css">'
)
html = html.replace(css_links, f'  <style>\n{css}\n  </style>')

# ── Inline JS: replace the seven <script> tags with a single <script> block ──
js_tags = (
    '<script src="js/crypto.js"></script>\n'
    '<script src="js/state.js"></script>\n'
    '<script src="js/library.js"></script>\n'
    '<script src="js/render.js"></script>\n'
    '<script src="js/modal.js"></script>\n'
    '<script src="js/sources.js"></script>\n'
    '<script src="js/main.js"></script>'
)
html = html.replace(js_tags, f'<script>\n{js}\n</script>')

out = root / "index_combined.html"
out.write_text(html)
print(f"Built {out}  ({len(html):,} chars)")
PYEOF
