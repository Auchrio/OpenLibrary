package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/crypto/pbkdf2"
	"golang.org/x/image/draw"
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

// decryptWithPassword decrypts data produced by encryptWithPassword.
// Expected format: [Salt(16)][Nonce(12)][Ciphertext].
func decryptWithPassword(data []byte, password string) ([]byte, error) {
	if len(data) < saltSize+nonceSize {
		return nil, fmt.Errorf("ciphertext too short")
	}
	salt := data[:saltSize]
	nonce := data[saltSize : saltSize+nonceSize]
	ct := data[saltSize+nonceSize:]
	key := pbkdf2.Key([]byte(password), salt, iterations, keySize, sha256.New)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, ct, nil)
}

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

// compressCover resizes a cover image to at most maxDim pixels on its longest
// edge, then re-encodes it as JPEG at the given quality.
// If anything fails the original bytes are returned unchanged.
func compressCover(data []byte, mimeType string, maxDim, quality int) []byte {
	var src image.Image
	var err error
	if strings.Contains(mimeType, "png") {
		src, err = png.Decode(bytes.NewReader(data))
	} else {
		src, err = jpeg.Decode(bytes.NewReader(data))
	}
	if err != nil {
		return data
	}

	bounds := src.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if w <= maxDim && h <= maxDim {
		// Already small enough — still re-encode to JPEG to normalise format/quality.
		var out bytes.Buffer
		if err := jpeg.Encode(&out, src, &jpeg.Options{Quality: quality}); err != nil {
			return data
		}
		return out.Bytes()
	}

	// Scale proportionally so the longest edge == maxDim.
	var nw, nh int
	if w >= h {
		nw = maxDim
		nh = int(float64(h) * float64(maxDim) / float64(w))
	} else {
		nh = maxDim
		nw = int(float64(w) * float64(maxDim) / float64(h))
	}
	if nw < 1 {
		nw = 1
	}
	if nh < 1 {
		nh = 1
	}

	dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, bounds, draw.Over, nil)

	var out bytes.Buffer
	if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: quality}); err != nil {
		return data
	}
	return out.Bytes()
}

// promptLine prints a prompt and returns trimmed user input from stdin.
func promptLine(prompt string) string {
	fmt.Print(prompt)
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Scan()
	return strings.TrimSpace(scanner.Text())
}

// fetchLibraryIndexLinks fetches a lib.json from rawURL and returns its links slice.
func fetchLibraryIndexLinks(rawURL string) ([]string, error) {
	resp, err := http.Get(rawURL + "/lib.json")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var lib LibJSON
	if err := json.NewDecoder(resp.Body).Decode(&lib); err != nil {
		return nil, err
	}
	return lib.Links, nil
}

// generateID returns a random UUID v4.
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
// PDF helpers
// ────────────────────────────────────────────────────────────────────────────

// pdfLiteralString decodes a PDF literal string (between parentheses).
// Handles octal escapes (\ddd), common backslash sequences, and UTF-16BE BOM.
func pdfLiteralString(s string) string {
	var out []byte
	i := 0
	for i < len(s) {
		if s[i] == '\\' && i+1 < len(s) {
			i++
			switch s[i] {
			case 'n':
				out = append(out, '\n')
			case 'r':
				out = append(out, '\r')
			case 't':
				out = append(out, '\t')
			case 'b':
				out = append(out, '\b')
			case 'f':
				out = append(out, '\f')
			case '(', ')', '\\':
				out = append(out, s[i])
			default:
				// Try octal: \ddd
				if s[i] >= '0' && s[i] <= '7' {
					octal := string(s[i])
					for j := 1; j <= 2 && i+j < len(s) && s[i+j] >= '0' && s[i+j] <= '7'; j++ {
						octal += string(s[i+j])
						i++
					}
					var v int
					fmt.Sscanf(octal, "%o", &v)
					out = append(out, byte(v))
				} else {
					out = append(out, s[i])
				}
			}
		} else {
			out = append(out, s[i])
		}
		i++
	}
	// Handle UTF-16BE BOM (\xFE\xFF)
	if len(out) >= 2 && out[0] == 0xFE && out[1] == 0xFF {
		// Decode UTF-16BE pairs
		var runes []rune
		for j := 2; j+1 < len(out); j += 2 {
			runes = append(runes, rune(uint16(out[j])<<8|uint16(out[j+1])))
		}
		return string(runes)
	}
	return string(out)
}

// parsePDFMeta attempts to extract title and author from the PDF Info
// dictionary. Many PDFs (especially those under 100 MB) store the Info dict
// in plain text; compressed object streams will return empty strings.
func parsePDFMeta(filePath string) (title, author string) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return
	}
	// Match literal string values: /Key (value)
	literal := regexp.MustCompile(`/(?:Title|Author)\s*\(([^\\)]*(?:\\.[^\\)]*)*)\)`)
	// Match hex-encoded string values: /Key <hexstring>
	hex := regexp.MustCompile(`/(?:Title|Author)\s*<([0-9A-Fa-f]+)>`)

	for _, m := range literal.FindAllSubmatch(data, -1) {
		key := string(m[0])
		val := strings.TrimSpace(pdfLiteralString(string(m[1])))
		if strings.Contains(key, "/Title") && title == "" {
			title = val
		} else if strings.Contains(key, "/Author") && author == "" {
			author = val
		}
	}
	for _, m := range hex.FindAllSubmatch(data, -1) {
		key := string(m[0])
		hexStr := string(m[1])
		var decoded []byte
		for i := 0; i+1 < len(hexStr); i += 2 {
			var b byte
			fmt.Sscanf(hexStr[i:i+2], "%02x", &b)
			decoded = append(decoded, b)
		}
		var val string
		if len(decoded) >= 2 && decoded[0] == 0xFE && decoded[1] == 0xFF {
			// UTF-16BE
			var runes []rune
			for j := 2; j+1 < len(decoded); j += 2 {
				runes = append(runes, rune(uint16(decoded[j])<<8|uint16(decoded[j+1])))
			}
			val = strings.TrimSpace(string(runes))
		} else {
			val = strings.TrimSpace(string(decoded))
		}
		if strings.Contains(key, "/Title") && title == "" {
			title = val
		} else if strings.Contains(key, "/Author") && author == "" {
			author = val
		}
	}
	return
}

// extractPDFCover renders the first page of a PDF to a JPEG using whatever
// external rasteriser is available on PATH (pdftoppm, mutool, convert).
// Returns nil if no tool is found or rendering fails.
func extractPDFCover(filePath string) ([]byte, string) {
	tmpDir, err := os.MkdirTemp("", "pdfcover*")
	if err != nil {
		return nil, ""
	}
	defer os.RemoveAll(tmpDir)

	outPrefix := filepath.Join(tmpDir, "cover")

	// ── pdftoppm (poppler) ──────────────────────────────────────────────────
	if _, err := exec.LookPath("pdftoppm"); err == nil {
		cmd := exec.Command("pdftoppm", "-r", "150", "-jpeg", "-f", "1", "-l", "1", filePath, outPrefix)
		if cmd.Run() == nil {
			matches, _ := filepath.Glob(outPrefix + "*.jpg")
			if len(matches) > 0 {
				if data, err := os.ReadFile(matches[0]); err == nil {
					return data, "image/jpeg"
				}
			}
		}
	}

	// ── mutool (MuPDF) ──────────────────────────────────────────────────────
	if _, err := exec.LookPath("mutool"); err == nil {
		outFile := outPrefix + ".jpg"
		cmd := exec.Command("mutool", "rasterize", "-r", "150", "-o", outFile, filePath, "1")
		if cmd.Run() == nil {
			if data, err := os.ReadFile(outFile); err == nil {
				return data, "image/jpeg"
			}
		}
	}

	// ── ImageMagick convert ──────────────────────────────────────────────────
	if _, err := exec.LookPath("convert"); err == nil {
		outFile := outPrefix + ".jpg"
		cmd := exec.Command("convert", "-density", "150", "-quality", "85", filePath+"[0]", outFile)
		if cmd.Run() == nil {
			if data, err := os.ReadFile(outFile); err == nil {
				return data, "image/jpeg"
			}
		}
	}

	return nil, ""
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
	Name           string   `json:"name"`
	EncryptionType int      `json:"encryption_type"`
	Links          []string `json:"links"`
	Index          string   `json:"index"` // base64(salt+nonce+ciphertext)
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
	Stem        string      `json:"stem,omitempty"` // lowercase filename stem used during indexing; dedup key
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

	// ── Load existing lib.json if present (incremental build).
	// We decrypt the existing index, carry all previous entries forward, and
	// skip any input group whose stem is already recorded — so files that
	// were encrypted on a previous run are never re-processed.
	libPath := filepath.Join(outputDir, "lib.json")
	existingIndex := map[string]IndexEntry{}
	existingStems := map[string]bool{}
	existingLibName := "OpenLibrary Datastore"
	existingLinks := []string{}

	if raw, err := os.ReadFile(libPath); err == nil {
		var oldLib LibJSON
		if json.Unmarshal(raw, &oldLib) == nil {
			decoded, err := base64.StdEncoding.DecodeString(oldLib.Index)
			if err == nil {
				if plain, err := decryptWithPassword(decoded, password); err == nil {
					if json.Unmarshal(plain, &existingIndex) == nil {
						for _, e := range existingIndex {
							if e.Stem != "" {
								existingStems[e.Stem] = true
							}
						}
						fmt.Printf("Loaded existing index: %d books already indexed.\n", len(existingIndex))
					}
				} else {
					fmt.Fprintln(os.Stderr, "Warning: could not decrypt existing lib.json (wrong password?). Starting fresh.")
					existingIndex = map[string]IndexEntry{}
				}
			}
			if oldLib.Name != "" {
				existingLibName = oldLib.Name
			}
			if len(oldLib.Links) > 0 {
				existingLinks = oldLib.Links
			}
		}
	}

	// ── Interactive setup questions ──
	// Library name
	nameAnswer := promptLine(fmt.Sprintf("Library name [%s]: ", existingLibName))
	if nameAnswer != "" {
		existingLibName = nameAnswer
	}

	// Offer Library Index network inclusion (only if not already linked)
	const libIndexShorthand = "github:Auchrio/OpenLibrary"
	const libIndexRawURL = "https://raw.githubusercontent.com/Auchrio/OpenLibrary/refs/heads/main"
	alreadyLinked := false
	for _, l := range existingLinks {
		if l == libIndexShorthand || strings.Contains(l, "Auchrio/OpenLibrary") {
			alreadyLinked = true
			break
		}
	}
	if !alreadyLinked {
		indexAnswer := promptLine("Include the Library Index network (github:Auchrio/OpenLibrary)? [y/N]: ")
		if strings.ToLower(indexAnswer) == "y" || strings.ToLower(indexAnswer) == "yes" {
			existingLinks = append(existingLinks, libIndexShorthand)
			fmt.Println("Fetching Library Index links…")
			fetchedLinks, fetchErr := fetchLibraryIndexLinks(libIndexRawURL)
			if fetchErr != nil {
				fmt.Fprintf(os.Stderr, "Warning: could not fetch Library Index links: %v\n", fetchErr)
			} else {
				// Build a dedup set from current links
				linkSet := map[string]bool{}
				for _, l := range existingLinks {
					linkSet[l] = true
				}
				added := 0
				for _, l := range fetchedLinks {
					if !linkSet[l] {
						linkSet[l] = true
						existingLinks = append(existingLinks, l)
						added++
					}
				}
				fmt.Printf("Added %d link(s) from the Library Index.\n", added)
			}
		}
	}

	// ── Phase 1: collect EPUB files first, keyed by lowercase filename stem.
	// Derivative formats (mobi, azw3) are only accepted when a matching EPUB
	// stem exists. PDFs are attached if a matching EPUB exists, otherwise they
	// become standalone entries.
	groups := map[string]*BookGroup{} // stem → group

	// Collect paths by stem for the second pass.
	type pendingFile struct {
		path   string
		format string
	}
	derivatives := []pendingFile{} // mobi, azw3
	pendingPDFs := []pendingFile{} // pdf — may be standalone

	err := filepath.WalkDir(inputDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		ext := strings.ToLower(filepath.Ext(path))
		stem := strings.ToLower(strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)))

		switch ext {
		case ".epub":
			meta, err := parseEPUB(path)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Warning: skipping %s: %v\n", filepath.Base(path), err)
				return nil
			}
			if _, ok := groups[stem]; !ok {
				groups[stem] = &BookGroup{
					Meta:        *meta,
					FormatFiles: map[string]string{},
					FileSizes:   map[string]int64{},
				}
			}
			g := groups[stem]
			g.Meta = *meta // always use EPUB for metadata & cover
			g.FormatFiles["epub"] = path
			if info, err := os.Stat(path); err == nil {
				g.FileSizes["epub"] = info.Size()
			}
		case ".mobi", ".azw3":
			derivatives = append(derivatives, pendingFile{path: path, format: ext[1:]})
		case ".pdf":
			pendingPDFs = append(pendingPDFs, pendingFile{path: path, format: "pdf"})
		}
		return nil
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Scan error: %v\n", err)
		os.Exit(1)
	}

	// ── Phase 2: attach mobi/azw3 derivatives to their paired EPUB group.
	// Files with no matching EPUB stem are skipped.
	for _, pf := range derivatives {
		stem := strings.ToLower(strings.TrimSuffix(filepath.Base(pf.path), filepath.Ext(pf.path)))
		g, ok := groups[stem]
		if !ok {
			fmt.Fprintf(os.Stderr, "Info: skipping %s — no matching .epub with the same filename\n", filepath.Base(pf.path))
			continue
		}
		g.FormatFiles[pf.format] = pf.path
		if info, err := os.Stat(pf.path); err == nil {
			g.FileSizes[pf.format] = info.Size()
		}
	}

	// ── Phase 3: process PDFs — attach to existing EPUB group if one exists,
	// otherwise create a standalone group for the PDF.
	for _, pf := range pendingPDFs {
		stem := strings.ToLower(strings.TrimSuffix(filepath.Base(pf.path), filepath.Ext(pf.path)))
		if g, ok := groups[stem]; ok {
			// PDF companion to an EPUB — just attach it.
			g.FormatFiles["pdf"] = pf.path
			if info, err := os.Stat(pf.path); err == nil {
				g.FileSizes["pdf"] = info.Size()
			}
			continue
		}

		// Standalone PDF — extract what metadata we can.
		pdfTitle, pdfAuthor := parsePDFMeta(pf.path)
		if pdfTitle == "" {
			// Clean up the filename: replace underscores/hyphens with spaces.
			base := strings.TrimSuffix(filepath.Base(pf.path), filepath.Ext(pf.path))
			base = strings.ReplaceAll(base, "_", " ")
			base = strings.ReplaceAll(base, "-", " ")
			pdfTitle = strings.TrimSpace(base)
		}
		if pdfAuthor == "" {
			pdfAuthor = "Unknown"
		}

		fmt.Printf("  PDF (standalone): %s — %s\n", pdfTitle, pdfAuthor)

		// Try to render the first page as a cover image.
		coverBytes, coverType := extractPDFCover(pf.path)
		if coverBytes == nil {
			fmt.Fprintf(os.Stderr, "  Info: no cover extracted for %s (install pdftoppm, mutool, or convert)\n", filepath.Base(pf.path))
		}

		meta := BookMeta{
			Title:      pdfTitle,
			Author:     pdfAuthor,
			CoverBytes: coverBytes,
			CoverType:  coverType,
		}
		groups[stem] = &BookGroup{
			Meta:        meta,
			FormatFiles: map[string]string{"pdf": pf.path},
			FileSizes:   map[string]int64{},
		}
		if info, err := os.Stat(pf.path); err == nil {
			groups[stem].FileSizes["pdf"] = info.Size()
		}
	}

	if len(groups) == 0 {
		fmt.Println("No EPUB or standalone PDF books found in input directory. Writing metadata only.")
		// Still write lib.json so name/links changes are persisted
		indexJSON, _ := json.MarshalIndent(existingIndex, "", "  ")
		encIndex, encErr := encryptWithPassword(indexJSON, password)
		if encErr == nil {
			lib := LibJSON{
				Name:           existingLibName,
				EncryptionType: encType,
				Links:          existingLinks,
				Index:          base64.StdEncoding.EncodeToString(encIndex),
			}
			if libData, err := json.MarshalIndent(lib, "", "  "); err == nil {
				os.WriteFile(filepath.Join(outputDir, "lib.json"), libData, 0644)
			}
		}
		return
	}

	// Count genuinely new books (not already indexed).
	newCount := 0
	for stem := range groups {
		if !existingStems[stem] {
			newCount++
		}
	}
	if newCount == 0 {
		fmt.Println("All books are already indexed. Writing updated metadata.")
		// Still write lib.json so name/links changes are persisted
		indexJSON, _ := json.MarshalIndent(existingIndex, "", "  ")
		encIndex, encErr := encryptWithPassword(indexJSON, password)
		if encErr == nil {
			lib := LibJSON{
				Name:           existingLibName,
				EncryptionType: encType,
				Links:          existingLinks,
				Index:          base64.StdEncoding.EncodeToString(encIndex),
			}
			if libData, err := json.MarshalIndent(lib, "", "  "); err == nil {
				os.WriteFile(filepath.Join(outputDir, "lib.json"), libData, 0644)
				fmt.Printf("Library '%s' metadata updated.\n", lib.Name)
			}
		}
		return
	}
	fmt.Printf("Building library (encryption_type %d): %d new book(s), %d already indexed.\n\n",
		encType, newCount, len(existingIndex))

	// Start index from the existing entries; new books are merged in below.
	index := existingIndex

	for stem, g := range groups {
		// Skip books already in the index.
		if existingStems[stem] {
			continue
		}

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

		// Compress and encrypt cover
		if len(g.Meta.CoverBytes) > 0 {
			compressed := compressCover(g.Meta.CoverBytes, g.Meta.CoverType, 300, 75)
			if encCover, err := encryptWithKey(compressed, fileKey); err == nil {
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
			entry.Stem = stem
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
			entry.Stem = stem
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
		Name:           existingLibName,
		EncryptionType: encType,
		Links:          existingLinks,
		Index:          base64.StdEncoding.EncodeToString(encIndex),
	}
	libData, _ := json.MarshalIndent(lib, "", "  ")
	if err := os.WriteFile(filepath.Join(outputDir, "lib.json"), libData, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Write lib.json: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("\nDone! Library '%s' — %d books written to: %s\n", lib.Name, len(index), outputDir)
}
