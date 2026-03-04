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

1. Create a folder with your ebook files (EPUB, MOBI, PDF, AZWZ3 formats supported) *please ensure any books have an epub version, as this version is used to get the book metadata.*
2. The CLI will automatically:
   - Extract title, author, and series info from metadata
   - Detect multi-format variants of the same book
   - Extract and encrypt cover images
   - Assign unique encryption keys to each book

```
~/my-books/
├── book1.epub
├── book2.pdf
└── book3.mobi
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

## Troubleshooting

- **"CORS error"** — Your host must send `Access-Control-Allow-Origin: *` headers
- **"Failed to decrypt"** — Ensure the correct password (if any) is entered when adding the source
- **Missing covers** — The CLI extracts covers from EPUB (preferred) or MOBI files

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
