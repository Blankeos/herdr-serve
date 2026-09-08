package server

import (
	"encoding/json"
	"fmt"
	"image/png"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Blankeos/herdr-serve/web"
)

func TestEmbeddedBranding(t *testing.T) {
	static, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		t.Fatal(err)
	}
	handler := spa(http.FileServer(http.FS(static)))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/manifest.webmanifest", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("manifest status: %d", response.Code)
	}
	if got := response.Header().Get("Content-Type"); got != "application/manifest+json" {
		t.Fatalf("manifest Content-Type: %q", got)
	}
	var manifest struct {
		Icons []struct {
			Src   string
			Sizes string
		}
	}
	if err := json.Unmarshal(response.Body.Bytes(), &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Icons) < 3 {
		t.Fatal("expected standard and maskable icons")
	}
	for _, icon := range manifest.Icons {
		t.Run(icon.Src, func(t *testing.T) {
			file, err := static.Open(strings.TrimPrefix(icon.Src, "/"))
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			config, err := png.DecodeConfig(file)
			if err != nil {
				t.Fatal(err)
			}
			if got := fmt.Sprintf("%dx%d", config.Width, config.Height); got != icon.Sizes {
				t.Fatalf("image size %s, manifest says %s", got, icon.Sizes)
			}
		})
	}
	for _, path := range []string{"/favicon.ico", "/favicon-32.png", "/apple-touch-icon.png"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Errorf("%s status: %d", path, response.Code)
		}
	}
}
