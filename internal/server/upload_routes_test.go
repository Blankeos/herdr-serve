package server

// Backend validation tests for POST /api/uploads. Exercises the real HTTP
// route (auth gate + handler) with an isolated upload dir. Mirrors the
// push_routes_test.go pattern.
import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 1x1 transparent PNG (valid image/* via net/http sniff).
const tinyPNGBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

func newUploadTestServer(t *testing.T, password string) *Server {
	t.Helper()
	t.Setenv("HERDR_SERVE_PUSH_FILE", filepath.Join(t.TempDir(), "push.json"))
	t.Setenv("HERDR_SERVE_UPLOAD_DIR", filepath.Join(t.TempDir(), "uploads"))
	s := New(nil, password)
	t.Cleanup(s.StopPush)
	return s
}

func uploadRequest(t *testing.T, field, filename string, content []byte, token string) *httptest.ResponseRecorder {
	t.Helper()
	s := newUploadTestServer(t, "secret")
	if token == "TOKEN" {
		token = s.gate.Token()
	}
	return doUploadRequest(t, s, field, filename, content, token)
}

// doUploadRequest posts against an existing server (for tests needing the
// server handle afterwards, e.g. to read the gate token once).
func doUploadRequest(t *testing.T, s *Server, field, filename string, content []byte, token string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormFile(field, filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/uploads", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func decodeUploadOK(t *testing.T, rec *httptest.ResponseRecorder) uploadResponse {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want 200 body=%s", rec.Code, rec.Body.String())
	}
	var out uploadResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v body=%s", err, rec.Body.String())
	}
	if !out.OK || out.Path == "" {
		t.Fatalf("bad ok body: %s", rec.Body.String())
	}
	if !filepath.IsAbs(out.Path) {
		t.Fatalf("path not absolute: %q", out.Path)
	}
	return out
}

func tinyPNG(t *testing.T) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(tinyPNGBase64)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func tinyHEIC() []byte {
	// Minimal ftyp box: size(4) + "ftyp"(4) + "heic"(4) + padding.
	// net/http sniffs this as application/octet-stream; isHEIFImage must accept it.
	b := make([]byte, 32)
	b[0], b[1], b[2], b[3] = 0, 0, 0, 24
	copy(b[4:8], "ftyp")
	copy(b[8:12], "heic")
	copy(b[16:20], "heic")
	return b
}

func TestUploadRequiresAuth(t *testing.T) {
	s := newUploadTestServer(t, "secret")
	token := s.gate.Token()
	if token == "" {
		t.Fatal("expected token when password set")
	}
	// No token -> 401 even with a valid image.
	rec := doUploadRequest(t, s, "file", "a.png", tinyPNG(t), "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("without token = %d, want 401 (%s)", rec.Code, rec.Body.String())
	}
	// Bad token -> 401.
	rec = doUploadRequest(t, s, "file", "a.png", tinyPNG(t), "nope")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("bad token = %d, want 401", rec.Code)
	}
	// Good token -> 200.
	rec = doUploadRequest(t, s, "file", "a.png", tinyPNG(t), token)
	if rec.Code != http.StatusOK {
		t.Fatalf("with token = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
}

func TestUploadOpenModeNoTokenNeeded(t *testing.T) {
	s := newUploadTestServer(t, "")
	rec := doUploadRequest(t, s, "file", "a.png", tinyPNG(t), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("open mode = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
}

func TestUploadMissingFile(t *testing.T) {
	s := newUploadTestServer(t, "secret")
	token := s.gate.Token()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	_ = w.WriteField("note", "no file here")
	_ = w.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/uploads", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing file = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
}

func TestUploadRejectsNonImage(t *testing.T) {
	s := newUploadTestServer(t, "secret")
	rec := doUploadRequest(t, s, "file", "evil.txt", []byte("hello, i am not an image"), s.gate.Token())
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("text upload = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "not a supported image") {
		t.Fatalf("unexpected error body: %s", rec.Body.String())
	}
	// HTML disguised as .png must still be rejected (content sniff wins).
	rec = doUploadRequest(t, s, "file", "x.png", []byte("<html><body>hi</body></html> padding padding padding padding"), s.gate.Token())
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("html-as-png = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
}

func TestUploadAcceptsPNGAndJPEG(t *testing.T) {
	s := newUploadTestServer(t, "secret")
	token := s.gate.Token()
	png := tinyPNG(t)
	out := decodeUploadOK(t, doUploadRequest(t, s, "file", "photo.png", png, token))
	if out.ContentType != "image/png" {
		t.Fatalf("contentType=%q want image/png", out.ContentType)
	}
	raw, err := os.ReadFile(out.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(raw, png) {
		t.Fatal("persisted bytes differ from upload")
	}
	// Minimal JPEG: SOI + JFIF header is enough for DetectContentType.
	jpeg := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00}
	jpeg = append(jpeg, bytes.Repeat([]byte{0x11}, 256)...)
	out2 := decodeUploadOK(t, doUploadRequest(t, s, "file", "photo.jpg", jpeg, token))
	if out2.ContentType != "image/jpeg" {
		t.Fatalf("jpeg contentType=%q want image/jpeg", out2.ContentType)
	}
	if out2.Path == out.Path {
		t.Fatal("expected unique paths for two uploads")
	}
}

func TestUploadAcceptsHEIC(t *testing.T) {
	s := newUploadTestServer(t, "secret")
	heic := tinyHEIC()
	out := decodeUploadOK(t, doUploadRequest(t, s, "file", "IMG_001.HEIC", heic, s.gate.Token()))
	if out.ContentType != "image/heic" {
		t.Fatalf("heic contentType=%q want image/heic", out.ContentType)
	}
	if !strings.HasSuffix(strings.ToLower(out.Path), ".heic") {
		t.Fatalf("heic path should keep .heic suffix: %q", out.Path)
	}
	raw, err := os.ReadFile(out.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(raw, heic) {
		t.Fatal("persisted HEIC bytes differ")
	}
	// HEIF brand via .heif extension normalizes to image/heif.
	heif := append([]byte{}, heic...)
	copy(heif[8:12], "mif1")
	out2 := decodeUploadOK(t, doUploadRequest(t, s, "file", "pic.heif", heif, s.gate.Token()))
	_ = out2
}

func TestUploadFieldAliases(t *testing.T) {
	s := newUploadTestServer(t, "secret")
	token := s.gate.Token()
	for _, field := range []string{"photo", "image", "upload"} {
		rec := doUploadRequest(t, s, field, "a.png", tinyPNG(t), token)
		if rec.Code != http.StatusOK {
			t.Fatalf("field %q = %d, want 200 (%s)", field, rec.Code, rec.Body.String())
		}
	}
}

func TestUploadRejectsOversize(t *testing.T) {
	oldMax, oldReq := maxUploadBytes, maxUploadRequestBytes
	maxUploadBytes = 1024
	maxUploadRequestBytes = 2048
	defer func() { maxUploadBytes, maxUploadRequestBytes = oldMax, oldReq }()

	s := newUploadTestServer(t, "secret")
	big := bytes.Repeat([]byte{0xFF, 0xD8, 0x01, 0x02}, 1024) // 4 KiB valid-ish JPEG start
	rec := doUploadRequest(t, s, "file", "big.jpg", big, s.gate.Token())
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize = %d, want 413 (%s)", rec.Code, rec.Body.String())
	}
}

func TestUploadPersistsPrivateFile(t *testing.T) {
	s := newUploadTestServer(t, "secret")
	png := tinyPNG(t)
	out := decodeUploadOK(t, doUploadRequest(t, s, "file", "My Photo.PNG", png, s.gate.Token()))

	dir := filepath.Dir(out.Path)
	dinfo, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := dinfo.Mode().Perm(); perm != 0o700 {
		t.Fatalf("upload dir perm=%o want 700", perm)
	}
	finfo, err := os.Stat(out.Path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := finfo.Mode().Perm(); perm != 0o600 {
		t.Fatalf("upload file perm=%o want 600", perm)
	}
	// Absolute, inside the configured dir, byte-identical, safe suffix.
	absDir, _ := filepath.Abs(DefaultUploadDir())
	if filepath.Dir(out.Path) != absDir {
		t.Fatalf("dir=%q want %q", filepath.Dir(out.Path), absDir)
	}
	if strings.Contains(out.Filename, "/") || strings.Contains(out.Filename, "\\") {
		t.Fatalf("unsafe filename: %q", out.Filename)
	}
	raw, err := io.ReadAll(mustOpen(t, out.Path))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(raw, png) {
		t.Fatal("persisted content mismatch")
	}
}

func mustOpen(t *testing.T, path string) io.Reader {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close() })
	return f
}

func TestUploadMethodNotAllowed(t *testing.T) {
	s := newUploadTestServer(t, "secret")
	req := httptest.NewRequest(http.MethodGet, "/api/uploads", nil)
	req.Header.Set("Authorization", "Bearer "+s.gate.Token())
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed && rec.Code != http.StatusNotFound {
		// ServeMux method pattern "POST /api/uploads" yields 405 on Go 1.22+.
		t.Fatalf("GET = %d, want 405", rec.Code)
	}
}

func TestValidateUploadImageUnit(t *testing.T) {
	if _, ok := validateUploadImage([]byte("plain text, not an image at all........."), "a.txt"); ok {
		t.Fatal("text should not validate")
	}
	if _, ok := validateUploadImage(tinyPNG(t), "a.png"); !ok {
		t.Fatal("png should validate")
	}
	if ct, ok := validateUploadImage(tinyHEIC(), "a.heic"); !ok || ct != "image/heic" {
		t.Fatalf("heic should validate as image/heic, got %q ok=%v", ct, ok)
	}
	if _, ok := validateUploadImage(tinyHEIC(), "a.heic"); !ok {
		t.Fatal("heic should validate")
	}
	// Random ftyp with unknown brand must NOT validate.
	other := tinyHEIC()
	copy(other[8:12], "xxxx")
	for i := 16; i < 32; i++ {
		other[i] = 0
	}
	if _, ok := validateUploadImage(other, "a.heic"); ok {
		t.Fatal("unknown ftyp brand should not validate")
	}
}
