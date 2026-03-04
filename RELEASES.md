# Library Tool Releases

## v1.0.0

**Fast, secure ebook library builder.**

### Features
- Encrypt & build libraries from EPUB, MOBI, PDF, AZW3 files
- Auto-extract metadata from EPUB/MOBI (title, author, series)
- Standalone PDF support — title from PDF metadata or filename, author falls back to "Unknown"
- PDF cover from first page via `pdftoppm`, `mutool`, or `convert` (optional, no cover if unavailable)
- PDF + EPUB pairs automatically merged into a single book entry
- Per-book encryption with random keys
- Cover extraction & encryption
- Single binary — no external runtime dependencies

### Download
Get the binary for your OS from [Releases](https://github.com/Auchrio/OpenLibrary/releases).

### Quick Start
```sh
./library <input-books-folder> <output-folder> [password]
```

[See full setup guide →](setup.md)
