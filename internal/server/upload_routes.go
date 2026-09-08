package server

// Photo upload routes (separate file to avoid conflicts with concurrent
// route work — e.g. the push agent — in server.go).
//
// Endpoint (behind requireAuth, i.e. Bearer token or ?token=):
//
//	POST /api/uploads  multipart/form-data, field "file" (aliases "photo",
//	                   "image", "upload" accepted) -> {ok, path, ...}
//
// Contract:
//   - Authorized multipart with bounded size (maxUploadBytes, default 15 MiB).
//   - Validates the payload is an image, including HEIC/HEIF via ftyp-brand
//     sniffing (Go's image/* + net/http sniffers don't recognize HEIC).
//   - Persists to a private local dir (0700) as a 0600 file so only the
//     server user can read it; the file is kept (not temp-deleted).
//   - Returns the absolute filesystem path; the web client inserts the
//     shell-quoted path into the selected terminal WITHOUT pressing enter
//     (terminal WebSocket "terminal.input" text path — NOT agent send-keys,
//     which only accepts logical key names like "esc"/"ctrl+c").
import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var (
	// maxUploadBytes bounds the decoded image payload. Var (not const) so
	// tests can shrink it without allocating 15 MiB.
	maxUploadBytes int64 = 15 << 20 // 15 MiB — iPhone HEIC/JPEG are 1–5 MiB
	// maxUploadRequestBytes bounds the whole multipart body (payload +
	// headers/boundaries) so http.MaxBytesReader stops abuse early.
	maxUploadRequestBytes int64 = (15 << 20) + (1 << 20) // 16 MiB
)

// uploadFieldNames lists accepted multipart field names in priority order.
// Canonical is "file"; the rest are leniency for hand-rolled clients.
var uploadFieldNames = []string{"file", "photo", "image", "upload"}

// uploadAllowedExts gates the persisted suffix. Content sniffing is
// authoritative; the extension only picks a safe suffix.
var uploadAllowedExts = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true,
	".webp": true, ".heic": true, ".heif": true, ".avif": true,
	".bmp": true, ".tif": true, ".tiff": true,
}

// heifBrands accepted inside the ftyp box. Covers HEIC/HEIF stills
// (heic/heix/hevc/hevx/heim/heis/hevm/hevs/mif1/msf1) and AVIF
// (avif/avis, also image/* but sniffed here for completeness).
var heifBrands = []string{
	"heic", "heix", "hevc", "hevx",
	"heim", "heis", "hevm", "hevs",
	"mif1", "msf1",
	"avif", "avis",
}

// DefaultUploadDir resolves the private persisted upload directory.
func DefaultUploadDir() string {
	if p := strings.TrimSpace(os.Getenv("HERDR_SERVE_UPLOAD_DIR")); p != "" {
		return p
	}
	if dir, err := os.UserConfigDir(); err == nil && strings.TrimSpace(dir) != "" {
		return filepath.Join(dir, "herdr-serve", "uploads")
	}
	home, _ := os.UserHomeDir()
	if strings.TrimSpace(home) == "" {
		home = "."
	}
	return filepath.Join(home, ".config", "herdr-serve", "uploads")
}

func (s *Server) mountUploadRoutes() {
	s.mux.Handle("POST /api/uploads", s.requireAuth(http.HandlerFunc(s.handleUpload)))
}

type uploadResponse struct {
	OK          bool   `json:"ok"`
	Path        string `json:"path"`
	Filename    string `json:"filename"`
	Bytes       int64  `json:"bytes"`
	ContentType string `json:"contentType"`
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	// Bound the whole body before parsing multipart (abuse guard).
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadRequestBytes)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		// ParseMultipartForm surfaces MaxBytesReader overflow as
		// "http: request body too large" — report 413, not 400.
		msg := err.Error()
		if strings.Contains(msg, "request body too large") {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": fmt.Sprintf("upload too large (max %d bytes)", maxUploadBytes)})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid multipart body: " + msg})
		return
	}
	if r.MultipartForm == nil || len(r.MultipartForm.File) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file required (multipart field \"file\")"})
		return
	}
	// Find the first present field in priority order, else any first file.
	header := pickUploadFile(r)
	if header == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file required (multipart field \"file\")"})
		return
	}
	src, err := header.Open()
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot read upload: " + err.Error()})
		return
	}
	defer src.Close()
	// Read with +1 to detect overflow even when the multipart header lied
	// about size (don't trust Content-Length / FileHeader.Size alone).
	limited := io.LimitReader(src, maxUploadBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		// MaxBytesReader errors surface here on truncated bodies.
		if strings.Contains(err.Error(), "request body too large") {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": fmt.Sprintf("upload too large (max %d bytes)", maxUploadBytes)})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot read upload: " + err.Error()})
		return
	}
	if int64(len(data)) > maxUploadBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": fmt.Sprintf("upload too large (max %d bytes)", maxUploadBytes)})
		return
	}
	if len(data) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "empty file"})
		return
	}
	// Header-declared size is advisory; enforce it too when present and sane.
	if header.Size > maxUploadBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": fmt.Sprintf("upload too large (max %d bytes)", maxUploadBytes)})
		return
	}

	contentType, ok := validateUploadImage(data, header.Filename)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not a supported image (jpeg/png/gif/webp/heic/heif/avif/bmp/tiff)"})
		return
	}

	ext := uploadExtFor(header.Filename, contentType, data)
	dir := DefaultUploadDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cannot create upload dir: " + err.Error()})
		return
	}
	// Harden dir perms on pre-existing dirs (MkdirAll is a no-op there).
	_ = os.Chmod(dir, 0o700)

	name := uploadFileName(ext)
	absDir, err := filepath.Abs(dir)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cannot resolve upload dir: " + err.Error()})
		return
	}
	full := filepath.Join(absDir, name)
	// O_EXCL + random suffix makes collisions vanishingly unlikely; retry
	// a few times just in case.
	var f *os.File
	for i := 0; i < 5; i++ {
		f, err = os.OpenFile(full, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			break
		}
		if !os.IsExist(err) {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cannot store upload: " + err.Error()})
			return
		}
		name = uploadFileName(ext)
		full = filepath.Join(absDir, name)
	}
	if f == nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cannot store upload: name collision"})
		return
	}
	// Ensure 0600 even if the file somehow pre-existed with wider perms.
	_ = f.Chmod(0o600)
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(full)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cannot store upload: " + err.Error()})
		return
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(full)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cannot store upload: " + err.Error()})
		return
	}
	_ = os.Chmod(full, 0o600)

	writeJSON(w, http.StatusOK, uploadResponse{
		OK:          true,
		Path:        full, // already absolute
		Filename:    name,
		Bytes:       int64(len(data)),
		ContentType: contentType,
	})
}

// --- helpers (pure, unit-testable) ---------------------------------------

func pickUploadFile(r *http.Request) *multipart.FileHeader {
	if r.MultipartForm == nil {
		return nil
	}
	for _, key := range uploadFieldNames {
		if hs := r.MultipartForm.File[key]; len(hs) > 0 && hs[0] != nil {
			return hs[0]
		}
	}
	// Leniency: any first file if the client used a custom field name.
	for _, hs := range r.MultipartForm.File {
		if len(hs) > 0 && hs[0] != nil {
			return hs[0]
		}
	}
	return nil
}

func validateUploadImage(data []byte, filename string) (string, bool) {
	if len(data) == 0 {
		return "", false
	}
	// HEIC/HEIF first: net/http has no HEIC signature and reports
	// application/octet-stream, so check ftyp brands before sniffing.
	if isHEIFImage(data) {
		// Normalize to image/heic unless the brand is clearly avif.
		lower := strings.ToLower(string(data[:minInt(len(data), 64)]))
		if strings.Contains(lower, "avif") || strings.Contains(lower, "avis") {
			return "image/avif", true
		}
		// Distinguish heif vs heic by extension when possible; default heic.
		ext := strings.ToLower(strings.TrimSpace(filepath.Ext(filename)))
		if ext == ".heif" {
			return "image/heif", true
		}
		return "image/heic", true
	}
	ct := http.DetectContentType(data)
	if strings.HasPrefix(ct, "image/") {
		return ct, true
	}
	return "", false
}

// isHEIFImage reports whether data looks like HEIC/HEIF/AVIF via the ftyp
// box: bytes[4:8] == "ftyp" and a known brand within the first 64 bytes.
func isHEIFImage(data []byte) bool {
	if len(data) < 12 {
		return false
	}
	if string(data[4:8]) != "ftyp" {
		return false
	}
	window := data[:minInt(len(data), 64)]
	for _, b := range heifBrands {
		if bytes.Contains(window, []byte(b)) {
			return true
		}
	}
	return false
}

func uploadExtFor(filename, contentType string, data []byte) string {
	ext := strings.ToLower(strings.TrimSpace(filepath.Ext(filename)))
	if uploadAllowedExts[ext] {
		// Normalize .jpeg -> .jpg? Keep as-is; both are fine. Lowercase only.
		return ext
	}
	// Derive from sniffed content type.
	switch {
	case contentType == "image/heic":
		return ".heic"
	case contentType == "image/heif":
		return ".heif"
	case contentType == "image/avif":
		return ".avif"
	case contentType == "image/jpeg":
		return ".jpg"
	case contentType == "image/png":
		return ".png"
	case contentType == "image/gif":
		return ".gif"
	case contentType == "image/webp":
		return ".webp"
	case contentType == "image/bmp":
		return ".bmp"
	case strings.HasPrefix(contentType, "image/"):
		// tiff reports as image/tiff; fall back to extension or jpg.
		if strings.Contains(contentType, "tiff") {
			return ".tiff"
		}
		return ".jpg"
	}
	// Should be unreachable (callers only invoke after validation), but
	// never persist an attacker-controlled suffix.
	_ = data
	return ".jpg"
}

func uploadFileName(ext string) string {
	var rnd [8]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		// crypto/rand essentially never fails; fall back to timestamp-only.
		return fmt.Sprintf("photo-%s%s", time.Now().UTC().Format("20060102-150405"), ext)
	}
	return fmt.Sprintf("photo-%s-%s%s",
		time.Now().UTC().Format("20060102-150405"),
		hex.EncodeToString(rnd[:]), ext)
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// uploadJSONError is a tiny helper for tests that want the error shape.
func uploadJSONError(msg string) []byte {
	b, _ := json.Marshal(map[string]string{"error": msg})
	return b
}
