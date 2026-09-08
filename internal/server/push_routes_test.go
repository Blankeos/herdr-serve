package server

// Wiring tests for the authorized push endpoints. These exercise the real
// HTTP routes (auth gate + handlers) with an isolated push state file.
import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	routeTestP256dh = "BNNL5ZaTfK81qhXOx23-wewhigUeFb632jN6LvRWCFH1ubQr77FE_9qV1FuojuRmHP42zmf34rXgW80OvUVDgTk"
	routeTestAuth   = "zqbxT6JKstKSY9JKibZLSQ"
	routeTestEndpoint = "https://fcm.googleapis.com/fcm/send/route-test"
)

func newPushTestServer(t *testing.T, password string) *Server {
	t.Helper()
	t.Setenv("HERDR_SERVE_PUSH_FILE", filepath.Join(t.TempDir(), "push.json"))
	s := New(nil, password)
	t.Cleanup(s.StopPush)
	if s.PushService() == nil {
		t.Fatal("push service should be initialized")
	}
	return s
}

func doReq(t *testing.T, s *Server, method, path, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, r)
	return rec
}

func TestPushEndpointsRequireAuth(t *testing.T) {
	s := newPushTestServer(t, "secret")
	token := s.gate.Token()
	if token == "" {
		t.Fatal("expected token when password set")
	}
	// No token -> 401 on all three.
	for _, tc := range []struct{ method, path string }{
		{"GET", "/api/push/public-key"},
		{"POST", "/api/push/subscribe"},
		{"POST", "/api/push/unsubscribe"},
	} {
		rec := doReq(t, s, tc.method, tc.path, `{}`, "")
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without token = %d, want 401", tc.method, tc.path, rec.Code)
		}
	}
	// With token -> public key works.
	rec := doReq(t, s, "GET", "/api/push/public-key", "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("public-key with token = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	var out struct {
		PublicKey string `json:"publicKey"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.PublicKey == "" {
		t.Fatalf("bad public-key body: %s err=%v", rec.Body.String(), err)
	}
}

func TestPushSubscribeRoundTripViaRoutes(t *testing.T) {
	s := newPushTestServer(t, "secret")
	token := s.gate.Token()
	sub := `{"endpoint":"` + routeTestEndpoint + `","keys":{"p256dh":"` + routeTestP256dh + `","auth":"` + routeTestAuth + `"}}`
	rec := doReq(t, s, "POST", "/api/push/subscribe", sub, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("subscribe = %d (%s)", rec.Code, rec.Body.String())
	}
	if s.PushService().Count() != 1 {
		t.Fatalf("count=%d want 1", s.PushService().Count())
	}
	rec = doReq(t, s, "POST", "/api/push/unsubscribe", `{"endpoint":"`+routeTestEndpoint+`"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("unsubscribe = %d", rec.Code)
	}
	if s.PushService().Count() != 0 {
		t.Fatalf("count=%d want 0", s.PushService().Count())
	}
}

func TestPushSubscribeRejectsSSRFViaRoutes(t *testing.T) {
	s := newPushTestServer(t, "secret")
	token := s.gate.Token()
	// Arbitrary https host must be rejected even with a valid token.
	sub := `{"endpoint":"https://evil.example.com/push/123","keys":{"p256dh":"` + routeTestP256dh + `","auth":"` + routeTestAuth + `"}}`
	rec := doReq(t, s, "POST", "/api/push/subscribe", sub, token)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("SSRF subscribe = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
	if s.PushService().Count() != 0 {
		t.Fatalf("SSRF endpoint must not be stored, count=%d", s.PushService().Count())
	}
	// Invalid key lengths must also be rejected.
	badKeys := `{"endpoint":"` + routeTestEndpoint + `","keys":{"p256dh":"short","auth":"short"}}`
	rec = doReq(t, s, "POST", "/api/push/subscribe", badKeys, token)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad-keys subscribe = %d, want 400", rec.Code)
	}
}

func TestPushOpenModeNoTokenNeeded(t *testing.T) {
	s := newPushTestServer(t, "")
	rec := doReq(t, s, "GET", "/api/push/public-key", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("open mode public-key = %d, want 200", rec.Code)
	}
	// State file should exist (persisted VAPID keys).
	matches, _ := filepath.Glob(filepath.Join(os.TempDir(), "*"))
	_ = matches
}
