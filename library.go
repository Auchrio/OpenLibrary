package main

import (
	"archive/zip"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/crypto/pbkdf2"
)

// Crypto constants matching the JS CRYPTO module exactly.
const (
	saltSize   = 16
	nonceSize  = 12
	iterations = 100000
	keySize    = 32
)

// ────────────────────────────────────────────────────────────────────────────
// Encryption helpers
// ────────────────────────────────────────────────────────────────────────────

// encryptWithPassword encrypts plaintext with a PBKDF2-derived key.
// Output format: [Salt(16)][Nonce(12)][Ciphertext] — matches JS decryptWithPassword.
func encryptWithPassword(plaintext []byte, password string) ([]byte, error) {
	salt := make([]byte, saltSize)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	key := pbkdf2.Key([]byte(password), salt, iterations, keySize, sha256.New)
	enc, err := encryptWithKey(plaintext, key)
	if err != nil {
		return nil, err
	}
	return append(salt, enc...), nil
}

// encryptWithKey encrypts plaintext with a raw 32-byte key.
// Output format: [Nonce(12)][Ciphertext] — matches JS decryptWithKey.
func encryptWithKey(plaintext []byte, key []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, nonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

func generateID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// generateKey returns a random 32-byte key and its hex encoding.
func generateKey() ([]byte, string) {
	k := make([]byte, keySize)
	rand.Read(k)
	return k, hex.EncodeToString(k)
}

// ────────────────────────────────────────────────────────────────────────────
// EPUB XML structs
// ────────────────────────────────────────────────────────────────────────────

// Container represents META-INF/container.xml
type Container struct {
	Rootfiles []struct {
		FullPath string `xml:"full-path,attr"`
	} `xml:"rootfiles>rootfile"`
}

// OPFPackage is the root of the .opf package document.
type OPFPackage struct {
	Metadata OPFMetadata `xml:"metadata"`
	Manifest struct {
		Items []ManifestItem `xml:"item"`
	} `xml:"manifest"`
}

// OPFMetadata holds metadata elements. Dublin Core elements require namespace.
type OPFMetadata struct {
	Title    string    `xml:"http://purl.org/dc/elements/1.1/ title"`
	Creators []string  `xml:"http://purl.org/dc/elements/1.1/ creator"`
	Metas    []OPFMeta `xml:"meta"`
}

// OPFMeta covers both EPUB2 (name/content) and EPUB3 (property/refines) meta elements.
type OPFMeta struct {
	Name     string `xml:"name,attr"`
	Content  string `xml:"content,attr"`
	Property string `xml:"property,attr"`
	Refines  string `xml:"refines,attr"`
	ID       string `xml:"id,attr"`
	Value    string `xml:",chardata"`
}

// ManifestItem is a single <item> in the OPF manifest.
type ManifestItem struct {
	ID         string `xml:"id,attr"`
	Href       string `xml:"href,attr"`
	MediaType  string `xml:"media-type,attr"`
	Properties string `xml:"properties,attr"`
}

// ────────────────────────────────────────────────────────────────────────────
// Book data structures
// ────────────────────────────────────────────────────────────────────────────

// BookMeta holds extracted metadata for a single book.
type BookMeta struct {
	Title       string
	Author      string
	Series      string
	SeriesIndex float64
	CoverBytes  []byte
	CoverType   string // "image/jpeg" or "image/png"
}

// BookGroup collects all format variants of the same title.
type BookGroup struct {
	Meta        BookMeta
	FormatFiles map[string]string // format ("epub","mobi") -> filepath
	FileSizes   map[string]int64
}

// ────────────────────────────────────────────────────────────────────────────
// EPUB parsing
// ────────────────────────────────────────────────────────────────────────────

func readZipEntry(r *zip.Reader, name string) ([]byte, error) {
	for _, f := range r.File {
		if f.Name == name {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			return io.ReadAll(rc)
		}
	}
	return nil, fmt.Errorf("not found in epub: %s", name)
}

func parseEPUB(filePath string) (*BookMeta, error) {
	r, err := zip.OpenReader(filePath)
	if err != nil {
		return nil, fmt.Errorf("open epub: %w", err)
	}
	defer r.Close()

	// 1. Read container.xml → get OPF path
	containerData, err := readZipEntry(&r.Reader, "META-INF/container.xml")
	if err != nil {
		return nil, fmt.Errorf("container.xml: %w", err)
	}
	var container Container
	if err := xml.Unmarshal(containerData, &container); err != nil {
		return nil, fmt.Errorf("parse container.xml: %w", err)
	}
	if len(container.Rootfiles) == 0 {
		return nil, fmt.Errorf("no rootfile found in container.xml")
	}
	opfPath := container.Rootfiles[0].FullPath

	// 2. Read and parse OPF
	opfData, err := readZipEntry(&r.Reader, opfPath)
	if err != nil {
		return nil, fmt.Errorf("read OPF %s: %w", opfPath, err)
	}
	var pkg OPFPackage
	if err := xml.Unmarshal(opfData, &pkg); err != nil {
		return nil, fmt.Errorf("parse OPF: %w", err)
	}

	meta := &BookMeta{}
	meta.Title = strings.TrimSpace(pkg.Metadata.Title)
	if len(pkg.Metadata.Creators) > 0 {
		meta.Author = strings.TrimSpace(pkg.Metadata.Creators[0])
	}

	// 3. Series — Calibre EPUB2 meta style
	for _, m := range pkg.Metadata.Metas {
		switch m.Name {
		case "calibre:series":
			meta.Series = strings.TrimSpace(m.Content)
		case "calibre:series_index":
			meta.SeriesIndex, _ = strconv.ParseFloat(strings.TrimSpace(m.Content), 64)
		}
	}

	// 4. Series — EPUB3 belongs-to-collection
	if meta.Series == "" {
		collections := map[string]string{}
		positions := map[string]float64{}
		for _, m := range pkg.Metadata.Metas {
			switch m.Property {
			case "belongs-to-collection":
				if m.ID != "" {
					collections[m.ID] = strings.TrimSpace(m.Value)
				}
			case "group-position":
				if m.Refines != "" {
					id := strings.TrimPrefix(m.Refines, "#")
					positions[id], _ = strconv.ParseFloat(strings.TrimSpace(m.Value), 64)
				}
			}
		}
		for id, name := range collections {
			meta.Series = name
			meta.SeriesIndex = positions[id]
			break
		}
	}

	// 5. Cover image
	opfBase := ""
	if idx := strings.LastIndex(opfPath, "/"); idx >= 0 {
		opfBase = opfPath[:idx+1]
	}

	var coverHref, coverMediaType string

	// EPUB2: <meta name="cover" content="item-id">
	for _, m := range pkg.Metadata.Metas {
		if m.Name == "cover" && m.Content != "" {
			for _, item := range pkg.Manifest.Items {
				if item.ID == m.Content && strings.HasPrefix(item.MediaType, "image/") {
					coverHref = item.Href
					coverMediaType = item.MediaType
				}
			}
			break
		}
	}

	// EPUB3: manifest item with properties="cover-image"
	if coverHref == "" {
		for _, item := range pkg.Manifest.Items {
			if strings.Contains(item.Properties, "cover-image") && strings.HasPrefix(item.MediaType, "image/") {
				coverHref = item.Href
				coverMediaType = item.MediaType
				break
			}
		}
	}

	// Fallback: any image item with "cover" in its id or href
	if coverHref == "" {
		for _, item := range pkg.Manifest.Items {
			if !strings.HasPrefix(item.MediaType, "image/") {
				continue
			}
			if strings.Contains(strings.ToLower(item.ID), "cover") ||
				strings.Contains(strings.ToLower(item.Href), "cover") {
				coverHref = item.Href
				coverMediaType = item.MediaType
				break
			}
		}
	}

	if coverHref != "" {
		coverData, err := readZipEntry(&r.Reader, opfBase+coverHref)
		if err == nil {
			meta.CoverBytes = coverData
			if strings.Contains(coverMediaType, "png") {
				meta.CoverType = "image/png"
			} else {
				meta.CoverType = "image/jpeg"
			}
		}
	}

	// 6. Fallback title/author from filename
	if meta.Title == "" {
		base := strings.TrimSuffix(filepath.Base(filePath), filepath.Ext(filePath))
		parts := strings.SplitN(base, " - ", 2)
		meta.Title = strings.TrimSpace(parts[0])
		if len(parts) == 2 {
			meta.Author = strings.TrimSpace(parts[1])
		}
	}

	return meta, nil
}

// ────────────────────────────────────────────────────────────────────────────
// lib.json output structures
// ────────────────────────────────────────────────────────────────────────────

// LibJSON is the unencrypted outer shell of lib.json.
type LibJSON struct {
	Name           string                 `json:"name"`
	EncryptionType int                    `json:"encryption_type"`
	Links          map[string]interface{} `json:"links"`
	Index          string                 `json:"index"` // base64(salt+nonce+ciphertext)
}

// IndexEntry is the per-book record stored in the encrypted index.
type IndexEntry struct {
	Title       string      `json:"title"`
	Author      string      `json:"author"`
	Series      string      `json:"series,omitempty"`
	SeriesIndex float64     `json:"series_index,omitempty"`
	Source      interface{} `json:"source"`      // string (single) or map[string]string (multi)
	SourceCover string      `json:"source_cover,omitempty"`
	SourceKey   string      `json:"source_key"` // hex-encoded 32 random bytes
	FileSize    interface{} `json:"filesize"`   // int64 (single) or map[string]int64 (multi)
	Formats     []string    `json:"formats"`
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "Usage: library <input-dir> <output-dir> [encryption-key]")
		fmt.Fprintln(os.Stderr, "  encryption-key defaults to \"0\" (encryption_type 0)")
		os.Exit(1)
	}

	inputDir := os.Args[1]
	outputDir := os.Args[2]
	password := "0"
	if len(os.Args) >= 4 && os.Args[3] != "" {
		password = os.Args[3]
	}
	encType := 0
	if password != "0" {
		encType = 1
	}

	if err := os.MkdirAll(outputDir, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "mkdir: %v\n", err)
		os.Exit(1)
	}

	// Scan input, group by normalised title (merges multi-format books)
	groups := map[string]*BookGroup{}

	err := filepath.WalkDir(inputDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		ext := strings.ToLower(filepath.Ext(path))
		if ext != ".epub" && ext != ".mobi" {
			return nil
		}
		format := ext[1:]

		var meta *BookMeta
		if ext == ".epub" {
			m, err := parseEPUB(path)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Warning: skipping %s: %v\n", filepath.Base(path), err)
				return nil
			}
			meta = m
		} else {
			// MOBI: derive title/author from filename
			base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
			parts := strings.SplitN(base, " - ", 2)
			meta = &BookMeta{Title: strings.TrimSpace(parts[0])}
			if len(parts) == 2 {
				meta.Author = strings.TrimSpace(parts[1])
			}
		}

		groupKey := strings.ToLower(strings.TrimSpace(meta.Title))
		if _, ok := groups[groupKey]; !ok {
			groups[groupKey] = &BookGroup{
				Meta:        *meta,
				FormatFiles: map[string]string{},
				FileSizes:   map[string]int64{},
			}
		}
		g := groups[groupKey]
		g.FormatFiles[format] = path
		if info, err := os.Stat(path); err == nil {
			g.FileSizes[format] = info.Size()
		}
		// Prefer EPUB metadata (richer: cover, series)
		if format == "epub" {
			g.Meta = *meta
		}
		return nil
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Scan error: %v\n", err)
		os.Exit(1)
	}
	if len(groups) == 0 {
		fmt.Println("No books (.epub/.mobi) found in input directory.")
		return
	}

	fmt.Printf("Building library (encryption_type %d) from %d books...\n\n", encType, len(groups))

	index := map[string]IndexEntry{}

	for _, g := range groups {
		id := generateID()
		fileKey, fileKeyHex := generateKey()

		formats := make([]string, 0, len(g.FormatFiles))
		for f := range g.FormatFiles {
			formats = append(formats, f)
		}

		entry := IndexEntry{
			Title:       g.Meta.Title,
			Author:      g.Meta.Author,
			Series:      g.Meta.Series,
			SeriesIndex: g.Meta.SeriesIndex,
			SourceKey:   fileKeyHex,
			Formats:     formats,
		}

		// Encrypt cover
		if len(g.Meta.CoverBytes) > 0 {
			if encCover, err := encryptWithKey(g.Meta.CoverBytes, fileKey); err == nil {
				coverFile := id + "-cover.enc"
				if os.WriteFile(filepath.Join(outputDir, coverFile), encCover, 0644) == nil {
					entry.SourceCover = coverFile
				}
			}
		}

		// Encrypt book file(s)
		if len(g.FormatFiles) == 1 {
			var fmtName string
			for f := range g.FormatFiles {
				fmtName = f
			}
			data, err := os.ReadFile(g.FormatFiles[fmtName])
			if err != nil {
				fmt.Fprintf(os.Stderr, "Warning: read %q: %v\n", g.Meta.Title, err)
				continue
			}
			encData, err := encryptWithKey(data, fileKey)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Warning: encrypt %q: %v\n", g.Meta.Title, err)
				continue
			}
			encFile := id + ".enc"
			if err := os.WriteFile(filepath.Join(outputDir, encFile), encData, 0644); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: write %s: %v\n", encFile, err)
				continue
			}
			entry.Source = encFile
			entry.FileSize = g.FileSizes[fmtName]
		} else {
			srcMap := map[string]string{}
			sizeMap := map[string]int64{}
			for fmtName, path := range g.FormatFiles {
				data, err := os.ReadFile(path)
				if err != nil {
					continue
				}
				encData, err := encryptWithKey(data, fileKey)
				if err != nil {
					continue
				}
				encFile := id + "-" + fmtName + ".enc"
				if os.WriteFile(filepath.Join(outputDir, encFile), encData, 0644) == nil {
					srcMap[fmtName] = encFile
					sizeMap[fmtName] = g.FileSizes[fmtName]
				}
			}
			entry.Source = srcMap
			entry.FileSize = sizeMap
		}

		index[id] = entry
		series := ""
		if entry.Series != "" {
			series = fmt.Sprintf(" [%s #%.4g]", entry.Series, entry.SeriesIndex)
		}
		fmt.Printf("  ✓ %s%s — %s\n", entry.Title, series, entry.Author)
	}

	// Encrypt the index
	indexJSON, err := json.MarshalIndent(index, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "JSON marshal: %v\n", err)
		os.Exit(1)
	}
	encIndex, err := encryptWithPassword(indexJSON, password)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Encrypt index: %v\n", err)
		os.Exit(1)
	}

	lib := LibJSON{
		Name:           "OpenLibrary Datastore",
		EncryptionType: encType,
		Links:          map[string]interface{}{},
		Index:          base64.StdEncoding.EncodeToString(encIndex),
	}
	libData, _ := json.MarshalIndent(lib, "", "  ")
	if err := os.WriteFile(filepath.Join(outputDir, "lib.json"), libData, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Write lib.json: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("\nDone! Library '%s' — %d books written to: %s\n", lib.Name, len(index), outputDir)
}
