package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
)

// Gate protects HTTP API + WebSocket when a password is configured.
type Gate struct {
	mu       sync.RWMutex
	password string
	token    string
}

func New(password string) *Gate {
	password = strings.TrimSpace(password)
	g := &Gate{password: password}
	if password != "" {
		g.token = randomToken()
	}
	return g
}

func (g *Gate) Required() bool {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.password != ""
}

func (g *Gate) AcceptsPassword(password string) bool {
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.password == "" {
		return true
	}
	return subtle.ConstantTimeCompare([]byte(password), []byte(g.password)) == 1
}

func (g *Gate) Token() string {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.token
}

func (g *Gate) AcceptsToken(token string) bool {
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.password == "" {
		return true
	}
	token = strings.TrimSpace(token)
	if token == "" || g.token == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(g.token)) == 1
}

func (g *Gate) TokenFromRequest(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		if t, ok := strings.CutPrefix(h, "Bearer "); ok {
			return strings.TrimSpace(t)
		}
	}
	return strings.TrimSpace(r.URL.Query().Get("token"))
}

func (g *Gate) Authorized(r *http.Request) bool {
	if !g.Required() {
		return true
	}
	return g.AcceptsToken(g.TokenFromRequest(r))
}

func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("auth: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}
