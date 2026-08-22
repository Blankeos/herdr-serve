// Package favicon resolves project favicon files from a working directory.
package favicon

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var faviconCandidates = []string{
	"favicon.svg",
	"favicon.png",
	"favicon.ico",
	"icon.svg",
	"icon.png",
	"logo.svg",
	"logo.png",
	"public/favicon.svg",
	"public/favicon.png",
	"public/favicon.ico",
	"public/icon.svg",
	"public/icon.png",
	"public/logo.svg",
	"public/logo.png",
	"app/favicon.ico",
	"static/favicon.ico",
	"assets/favicon.ico",
	"src/favicon.ico",
	"src/app/favicon.ico",
}

var iconSourceFiles = []string{
	"index.html",
	"public/index.html",
	"app.html",
	"src/index.html",
	"src/app.html",
	"app/layout.tsx",
	"src/app/layout.tsx",
	"app/root.tsx",
	"src/app/root.tsx",
	"app/routes/__root.tsx",
	"src/routes/__root.tsx",
}

var (
	htmlIconHref = regexp.MustCompile(`(?is)<link\b[^>]*\brel\s*=\s*["'](?:[^"']*\s)?icon(?:\s[^"']*)?["'][^>]*\bhref\s*=\s*["']([^"']+)["']|<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\brel\s*=\s*["'](?:[^"']*\s)?icon(?:\s[^"']*)?["']`)
	jsxIconHref  = regexp.MustCompile(`(?is)rel\s*:\s*["']icon["']\s*,\s*href\s*:\s*["']([^"']+)["']|href\s*:\s*["']([^"']+)["']\s*,\s*rel\s*:\s*["']icon["']`)
)

// Resolve finds a favicon for the project at cwd.
// Returns the absolute path, content-type, and whether one was found.
func Resolve(cwd string) (path string, contentType string, ok bool) {
	cwd = strings.TrimSpace(cwd)
	if cwd == "" {
		return "", "", false
	}
	root, err := filepath.Abs(cwd)
	if err != nil {
		return "", "", false
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return "", "", false
	}

	for _, candidate := range faviconCandidates {
		if p, ok := existingWithinRoot(root, filepath.Join(root, filepath.FromSlash(candidate))); ok {
			return p, contentTypeFor(p), true
		}
	}

	for _, sourceFile := range iconSourceFiles {
		sourcePath := filepath.Join(root, filepath.FromSlash(sourceFile))
		data, err := os.ReadFile(sourcePath)
		if err != nil {
			continue
		}
		href, found := extractIconHref(string(data))
		if !found {
			continue
		}
		for _, candidate := range resolveIconHref(root, href) {
			if p, ok := existingWithinRoot(root, candidate); ok {
				return p, contentTypeFor(p), true
			}
		}
	}

	return "", "", false
}

// Serve handles GET /api/project-favicon?cwd=...
// Responds 400 if cwd is missing, 404 if not found, otherwise the favicon bytes.
func Serve(w http.ResponseWriter, r *http.Request) {
	cwd := strings.TrimSpace(r.URL.Query().Get("cwd"))
	if cwd == "" {
		http.Error(w, "cwd is required", http.StatusBadRequest)
		return
	}
	path, contentType, ok := Resolve(cwd)
	if !ok {
		http.Error(w, "project favicon not found", http.StatusNotFound)
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "project favicon not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func extractIconHref(source string) (string, bool) {
	if m := htmlIconHref.FindStringSubmatch(source); m != nil {
		for _, g := range m[1:] {
			if g != "" {
				return strings.TrimSpace(g), true
			}
		}
	}
	if m := jsxIconHref.FindStringSubmatch(source); m != nil {
		for _, g := range m[1:] {
			if g != "" {
				return strings.TrimSpace(g), true
			}
		}
	}
	return "", false
}

func resolveIconHref(projectRoot, href string) []string {
	href = strings.TrimSpace(href)
	if href == "" || strings.HasPrefix(href, "data:") {
		return nil
	}
	if u, err := url.Parse(href); err == nil && u.Scheme != "" {
		// Absolute URL (http/https/...) — not a local project file.
		return nil
	}

	cleaned := strings.TrimPrefix(href, "/")
	cleaned = strings.TrimPrefix(cleaned, "./")
	for strings.HasPrefix(cleaned, "../") {
		cleaned = strings.TrimPrefix(cleaned, "../")
	}
	cleaned = filepath.FromSlash(cleaned)
	if cleaned == "" || cleaned == "." {
		return nil
	}

	return []string{
		filepath.Join(projectRoot, "public", cleaned),
		filepath.Join(projectRoot, cleaned),
	}
}

func existingWithinRoot(root, candidate string) (string, bool) {
	abs, err := filepath.Abs(candidate)
	if err != nil {
		return "", false
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", false
	}
	info, err := os.Stat(abs)
	if err != nil || info.IsDir() {
		return "", false
	}
	return abs, true
}

func contentTypeFor(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".svg":
		return "image/svg+xml"
	case ".ico":
		return "image/x-icon"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	default:
		return "application/octet-stream"
	}
}
