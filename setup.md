# Setting Up Your Own OpenLibrary

A quick guide to create and host your own encrypted ebook library.

## Prerequisites

- Download the prebuilt `library` binary for your platform from [Releases](https://github.com/Auchrio/OpenLibrary/releases)
- Or, clone the repository to build from source (see [Building from Source](#building-from-source))

```sh
git clone https://github.com/Auchrio/OpenLibrary
cd OpenLibrary
```

## Step 1: Prepare Your Books

1. Create a folder with your ebook files — supported formats: **EPUB, MOBI, AZW3, PDF**
2. The CLI will automatically:
   - Extract title, author, and series info from EPUB/MOBI/AZW3 metadata
   - Use PDF Info metadata (title, author) for standalone PDFs, falling back to the filename
   - Render the first page of a standalone PDF as a cover image (requires `pdftoppm`, `mutool`, or `convert` — see [PDF cover generation](#pdf-cover-generation))
   - Detect multi-format variants of the same book (e.g. an EPUB and PDF with the same filename)
   - Assign unique encryption keys per book

> **Tip:** For the best results, always include an EPUB version where available — EPUB metadata and cover extraction is the most reliable.

```
~/my-books/
├── book1.epub         ← full metadata + cover from EPUB
├── book2.epub
├── book2.pdf          ← attached as a second format alongside the EPUB
├── standalone.pdf     ← PDF-only: title from metadata/filename, cover from first page
└── book3.mobi         ← only included if a matching book3.epub exists
```

## Step 2: Build Your Library

Run the `library` binary to generate encrypted library files:

```sh
./library <input-folder> <output-folder> [encryption-key]
```

Or on Windows:
```sh
library.exe <input-folder> <output-folder> [encryption-key]
```

### Examples

**Public library (no password):**
```sh
./library ~/my-books ~/my-library-output
```

**Password-protected library:**
```sh
./library ~/my-books ~/my-library-output "my-secret-password"
```

This produces:
- `lib.json` — encrypted index + metadata
- `<uuid>.enc` — encrypted book files
- `<uuid>-cover.enc` — encrypted cover images

## Step 3: Host Your Library
**If you wish to contribute your library to the public index, please ensure that it is not password protected, and you select yes when asked if you wish to include the netowork index in your library.**

### Option A: GitHub (Recommended)

1. Create a **public** GitHub repository (e.g., `my-library`)
2. Copy all files from your output folder to the repository root
3. Commit and push to `main`
4. Your library URL:
   ```
   github:<Username>/my-library
   ```

### Option B: Any Static File Host

Any host works (Cloudflare R2, nginx, Caddy, etc.) as long as:
- The URL resolves to the folder containing `lib.json`
- The host sends CORS headers: `Access-Control-Allow-Origin: *`

## Step 4: Add to OpenLibrary

1. Open [index.html](./index.html) in your browser
2. Click **📚 Sources** (top-right)
3. Click **+ Add New Source**
4. Paste your library URL
5. Click **Preview** → **Import**

Done! Your books are now accessible through OpenLibrary.

## Optional: Contribute to the Community Index

Share your library publicly:

1. Open a GitHub issue titled: `[Library] Your Library Name`
2. Include:
   - Library name
   - Full URL
   - Brief description
   - Formats included (epub, mobi, pdf)
   - Encryption type (0 = public, 1 = password)

See [INDEX.md](INDEX.md) for details and existing libraries.

## PDF Cover Generation

For standalone PDF files, the CLI attempts to render the first page as a cover image using one of the following tools. Install whichever is most convenient for your system:

| Tool | Install (Linux) | Install (Windows) |
|------|----------------|-------------------|
| **pdftoppm** (Poppler) | `sudo apt install poppler-utils` | [Poppler for Windows](https://github.com/oschwartz10612/poppler-windows/releases) |
| **mutool** (MuPDF) | `sudo apt install mupdf-tools` | [MuPDF Downloads](https://mupdf.com/downloads/) |
| **convert** (ImageMagick) | `sudo apt install imagemagick` | [ImageMagick Download](https://imagemagick.org/script/download.php) |

If none of these tools are installed, the PDF will still be indexed and downloadable — it just won't have a cover image.

## Troubleshooting

- **"CORS error"** — Your host must send `Access-Control-Allow-Origin: *` headers
- **"Failed to decrypt"** — Ensure the correct password (if any) is entered when adding the source
- **Missing covers on PDFs** — Install `pdftoppm`, `mutool`, or `convert` (see [PDF cover generation](#pdf-cover-generation))
- **PDF shows "Unknown" author** — The PDF's Info dictionary doesn't contain author metadata; rename the file or edit the PDF metadata

For more details, see [TECHNICALS.md](TECHNICALS.md).

---

## Building from Source (Optional)

If you prefer to build the `library` binary yourself instead of downloading a prebuilt release:

### Prerequisites

- **Go 1.21 or later** — [Download](https://go.dev/dl)
- This repository cloned locally

### Build for Your Platform

```sh
# For your current OS/architecture
go build -o library library.go
```

Then use `./library` (or `library.exe` on Windows) as above.
