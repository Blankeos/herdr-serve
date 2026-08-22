package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGateDisabled(t *testing.T) {
	g := New("")
	if g.Required() {
		t.Fatal("expected auth disabled")
	}
	req := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
	if !g.Authorized(req) {
		t.Fatal("expected open access when password unset")
	}
}

func TestGateRequiresToken(t *testing.T) {
	g := New("secret")
	if !g.Required() {
		t.Fatal("expected auth required")
	}
	if g.AcceptsPassword("wrong") {
		t.Fatal("wrong password accepted")
	}
	if !g.AcceptsPassword("secret") {
		t.Fatal("correct password rejected")
	}

	bare := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
	if g.Authorized(bare) {
		t.Fatal("bare request should be unauthorized")
	}

	bearer := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
	bearer.Header.Set("Authorization", "Bearer "+g.Token())
	if !g.Authorized(bearer) {
		t.Fatal("bearer token should authorize")
	}

	query := httptest.NewRequest(http.MethodGet, "/ws/term?token="+g.Token(), nil)
	if !g.Authorized(query) {
		t.Fatal("query token should authorize")
	}

	bad := httptest.NewRequest(http.MethodGet, "/ws/term?token=nope", nil)
	if g.Authorized(bad) {
		t.Fatal("bad token should not authorize")
	}
}
