# OpenLibrary — Community Library Index

This is the official index of publicly available OpenLibrary-compatible libraries.  
Add any of these sources to the web UI by copying the URL from the table below and pasting it into **📚 Sources → + Add New Source**.

---

## Contributing a Library

### How to Submit

Follow these steps to get your library listed here:

**1. Build and host your library**

Use the `library` CLI to produce an encrypted library from your EPUB/MOBI/PDF files:

```sh
go run library.go <input-folder> <output-folder>
```

Push the output folder to a public GitHub repository (or any HTTPS host with CORS enabled). Your library URL will look like:

```
https://raw.githubusercontent.com/<your-username>/<your-repo>/refs/heads/main
```

Verify it loads in the web UI before submitting.

**2. Open a GitHub issue**

Create a new issue in this repository with the title format:

```
[Library] Your Library Name
```

Include the following block in the issue body — copy-paste it and fill in your details:

```
Name:        My Library
URL:         https://raw.githubusercontent.com/your-username/your-repo/refs/heads/main
Description: A brief description of the library's contents and theme.
Formats:     epub, mobi, pdf   (list whichever formats your library provides)
Encryption:  0   (0 = public / no password, 1 = key required — describe key distribution if 1)
```

**3. Wait for review**

A maintainer will verify the library loads correctly, check compliance with the content policy below, and add it to the table — or ask for clarification.

### Content Policy

Libraries listed in this index must contain only works the contributor has the legal right to distribute. Acceptable content includes:

- **Public domain** works (e.g. Project Gutenberg titles, pre-1928 publications in most jurisdictions).
- **Creative Commons** licensed works where the licence permits redistribution.
- Works distributed with **explicit written permission** from the copyright holder.
- **Self-authored** works you own the copyright to.

The maintainers reserve the right to decline or remove any listing at their discretion, without requiring justification.  
Listing in this index does not imply endorsement of the content by the OpenLibrary project or its maintainers.

---

## Public Libraries

| Name | Maintainer | Formats | Description | URL |
|------|-----------|---------|-------------|-----|
| Auchrio's Library | [@Auchrio](https://github.com/Auchrio) | EPUB · MOBI · PDF | A personal collection of books curated by Auchrio — the creator of this project. Titles Auchrio enjoys, spanning a range of genres. | `https://raw.githubusercontent.com/Auchrio/.library/refs/heads/main` |
