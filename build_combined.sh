#!/usr/bin/env bash
# build_combined.sh
# Inlines css/style.css and js/app.js back into index.html to produce
# index_combined.html — a single portable file with no external dependencies.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python3 - "$SCRIPT_DIR" <<'PYEOF'
import sys, pathlib

root = pathlib.Path(sys.argv[1])

html = (root / "index.html").read_text()
css  = (root / "css" / "style.css").read_text()
js   = (root / "js"  / "app.js").read_text()

# Inline the stylesheet
html = html.replace(
    '  <link rel="stylesheet" href="css/style.css">',
    f'  <style>{css}  </style>'
)

# Inline the script
html = html.replace(
    '<script src="js/app.js"></script>',
    f'<script>{js}</script>'
)

out = root / "index_combined.html"
out.write_text(html)
print(f"Built {out}  ({len(html):,} chars)")
PYEOF
