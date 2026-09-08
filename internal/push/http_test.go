package push

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Blankeos/herdr-serve/internal/herdr"
	webpush "github.com/SherClockHolmes/webpush-go"
)

// Valid Web Push keys (65-byte P-256 point + 16-byte auth) borrowed from
// webpush-go's own fixtures — browsers always produce these exact sizes.
const (
	testP256dh = "BNNL5ZaTfK81qhXOx23-wewhigUeFb632jN6LvRWCFH1ubQr77FE_9qV1FuojuRmHP42zmf34rXgW80OvUVDgTk"
	testAuth   = "zqbxT6JKstKSY9JKibZLSQ"
)

const (
	testEndpointFCM    = "https://fcm.googleapis.com/fcm/send/test-endpoint-1"
	testEndpointMozilla = "https://updates.push.services.mozilla.com/wpush/v2/test-endpoint-1"
	testEndpointApple  = "https://web.push.apple.com/test-endpoint-1"
)

func newTestService(t *testing.T) *Service {
	t.Helper()
	s, err := NewServiceWithPath("")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestVAPIDKeyGenerated(t *testing.T) {
	s := newTestService(t)
	if s.PublicKey() == "" {
		t.Fatal("public key must be generated")
	}
}

func TestPersistedKeysPrivateFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "push.json")
	s, err := NewServiceWithPath(path)
	if err != nil {
		t.Fatal(err)
	}
	pub1 := s.PublicKey()
	if pub1 == "" {
		t.Fatal("no public key")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("push file perm = %o, want 600", info.Mode().Perm())
	}
	// Reload: keys must persist, not regenerate.
	s2, err := NewServiceWithPath(path)
	if err != nil {
		t.Fatal(err)
	}
	if s2.PublicKey() != pub1 {
		t.Error("VAPID keys did not persist across reloads")
	}
}

func TestSubscribeValidation(t *testing.T) {
	s := newTestService(t)
	valid := func() error {
		return s.AddSubscription(testEndpointFCM, testP256dh, testAuth, "test-agent")
	}
	if err := valid(); err != nil {
		t.Fatalf("valid subscription rejected: %v", err)
	}
	if s.Count() != 1 {
		t.Fatalf("count=%d want 1", s.Count())
	}
	// Re-subscribe same endpoint refreshes (no dup).
	if err := valid(); err != nil {
		t.Fatal(err)
	}
	if s.Count() != 1 {
		t.Fatalf("re-subscribe duplicated, count=%d", s.Count())
	}
	bad := []struct {
		name             string
		ep, p256dh, auth string
	}{
		{"empty", "", "", ""},
		{"http endpoint", "http://fcm.googleapis.com/x", testP256dh, testAuth},
		{"short keys", testEndpointFCM, "short", "short"},
		{"arbitrary https host", "https://evil.example.com/push/123", testP256dh, testAuth},
		{"intranet host", "https://internal.example.com/push", testP256dh, testAuth},
		{"metadata IP", "https://169.254.169.254/latest/meta-data/", testP256dh, testAuth},
		{"loopback IP", "https://127.0.0.1/push", testP256dh, testAuth},
		{"userinfo", "https://user:pass@fcm.googleapis.com/fcm/send/x", testP256dh, testAuth},
		{"non-443 port on vendor host", "https://fcm.googleapis.com:8443/fcm/send/x", testP256dh, testAuth},
		{"wrong p256dh length", testEndpointFCM, strings.Repeat("k", 87), testAuth},
		{"wrong auth length", testEndpointFCM, testP256dh, strings.Repeat("a", 87)},
		{"bad base64 p256dh", testEndpointFCM, "!!!not-base64!!!", testAuth},
		{"bad base64 auth", testEndpointFCM, testP256dh, "!!!not-base64!!!"},
	}
	for _, c := range bad {
		if err := s.AddSubscription(c.ep, c.p256dh, c.auth, ""); err == nil {
			t.Errorf("%s: expected error, got nil", c.name)
		}
	}
	if !s.RemoveSubscription(testEndpointFCM) {
		t.Error("RemoveSubscription should return true")
	}
	if s.RemoveSubscription(testEndpointFCM) {
		t.Error("second remove should return false")
	}
}

func TestSubscribeAllVendorHosts(t *testing.T) {
	for _, ep := range []string{testEndpointFCM, testEndpointMozilla, testEndpointApple} {
		s := newTestService(t)
		if err := s.AddSubscription(ep, testP256dh, testAuth, ""); err != nil {
			t.Errorf("vendor endpoint %s rejected: %v", ep, err)
		}
	}
	// Vendor subdomains are accepted (future regional endpoints).
	s := newTestService(t)
	if err := s.AddSubscription("https://foo.push.services.mozilla.com/wpush/v1/x", testP256dh, testAuth, ""); err != nil {
		t.Errorf("mozilla subdomain rejected: %v", err)
	}
	if err := s.AddSubscription("https://foo.push.apple.com/x", testP256dh, testAuth, ""); err != nil {
		t.Errorf("apple subdomain rejected: %v", err)
	}
	// Lookalike suffix attack must fail.
	if err := s.AddSubscription("https://push.services.mozilla.com.evil.com/x", testP256dh, testAuth, ""); err == nil {
		t.Error("suffix-spoof host should be rejected")
	}
	if err := s.AddSubscription("https://fcm.googleapis.com.evil.com/x", testP256dh, testAuth, ""); err == nil {
		t.Error("suffix-spoof FCM host should be rejected")
	}
}

func TestSubscribeExtraHosts(t *testing.T) {
	t.Setenv("HERDR_SERVE_PUSH_EXTRA_HOSTS", "push.example.com")
	s := newTestService(t)
	if err := s.AddSubscription("https://push.example.com/ep1", testP256dh, testAuth, ""); err != nil {
		t.Fatalf("extra host should be allowed: %v", err)
	}
	// Subdomains of the extra host are allowed too.
	if err := s.AddSubscription("https://sub.push.example.com/ep2", testP256dh, testAuth, ""); err != nil {
		t.Fatalf("extra subdomain should be allowed: %v", err)
	}
	// Without the env, the same host is rejected.
	t.Setenv("HERDR_SERVE_PUSH_EXTRA_HOSTS", "")
	s2 := newTestService(t)
	if err := s2.AddSubscription("https://push.example.com/ep1", testP256dh, testAuth, ""); err == nil {
		t.Error("push.example.com without extra-hosts should be rejected")
	}
}

func TestValidatePushKeyLengths(t *testing.T) {
	if err := validatePushKeys(testP256dh, testAuth); err != nil {
		t.Fatalf("valid keys rejected: %v", err)
	}
	// 66-byte p256dh (old placeholder Repeat("k",87)) must fail.
	if err := validatePushKeys(strings.Repeat("k", 87), testAuth); err == nil {
		t.Error("66-byte p256dh should be rejected")
	}
	// 18-byte auth (24-char base64) must fail.
	if err := validatePushKeys(testP256dh, strings.Repeat("a", 24)); err == nil {
		t.Error("18-byte auth should be rejected")
	}
	for _, tc := range []struct{ name, p, a string }{
		{"empty", "", ""},
		{"short", "short", "short"},
		{"bad b64", "!!!", "???"},
	} {
		if err := validatePushKeys(tc.p, tc.a); err == nil {
			t.Errorf("%s: expected error", tc.name)
		}
	}
}

func TestIsAllowedPushHost(t *testing.T) {
	allowed := []string{
		"fcm.googleapis.com",
		"FCM.GOOGLEAPIS.COM",
		"updates.push.services.mozilla.com",
		"web.push.apple.com",
		"foo.push.services.mozilla.com",
		"foo.push.apple.com",
	}
	for _, h := range allowed {
		if !isAllowedPushHost(h) {
			t.Errorf("host %q should be allowed", h)
		}
	}
	denied := []string{
		"",
		"evil.example.com",
		"push.example.com",
		"127.0.0.1",
		"::1",
		"10.0.0.1",
		"fcm.googleapis.com.evil.com",
		"evil-fcm.googleapis.com",
		"notpush.services.mozilla.com",
	}
	for _, h := range denied {
		if isAllowedPushHost(h) {
			t.Errorf("host %q should be denied", h)
		}
	}
}

func TestIsPublicIP(t *testing.T) {
	public := []string{"8.8.8.8", "1.1.1.1", "142.250.72.14"}
	for _, s := range public {
		if !isPublicIP(net.ParseIP(s)) {
			t.Errorf("public IP %s should pass", s)
		}
	}
	private := []string{
		"127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1",
		"169.254.169.254", "0.0.0.0", "100.64.0.1", "198.18.0.1",
		"192.0.2.1", "203.0.113.1", "::1", "::",
		"fc00::1", "fe80::1", "ff02::1",
	}
	for _, s := range private {
		if isPublicIP(net.ParseIP(s)) {
			t.Errorf("private/reserved IP %s should be blocked", s)
		}
	}
}

func TestSecureClientNoRedirect(t *testing.T) {
	c := securePushClient()
	if c == nil {
		t.Fatal("nil secure client")
	}
	if c.CheckRedirect == nil {
		t.Fatal("CheckRedirect must be set")
	}
	req, _ := http.NewRequest(http.MethodPost, testEndpointFCM, nil)
	if err := c.CheckRedirect(req, nil); err != http.ErrUseLastResponse {
		t.Errorf("redirects must be blocked, got %v", err)
	}
}

func TestSubscribeEndpoint(t *testing.T) {
	s := newTestService(t)
	body := `{"endpoint":"` + testEndpointFCM + `","keys":{"p256dh":"` + testP256dh + `","auth":"` + testAuth + `"}}`
	req := httptest.NewRequest(http.MethodPost, "/api/push/subscribe", strings.NewReader(body))
	req.Header.Set("User-Agent", "test")
	rec := httptest.NewRecorder()
	s.HandleSubscribe(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("subscribe status=%d body=%s", rec.Code, rec.Body.String())
	}
	if s.Count() != 1 {
		t.Fatalf("count=%d want 1", s.Count())
	}
	// Bad body -> 400.
	req = httptest.NewRequest(http.MethodPost, "/api/push/subscribe", strings.NewReader(`{"endpoint":"http://x"}`))
	rec = httptest.NewRecorder()
	s.HandleSubscribe(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("bad subscribe status=%d want 400", rec.Code)
	}
	// Arbitrary https endpoint -> 400 (SSRF guard at HTTP layer).
	req = httptest.NewRequest(http.MethodPost, "/api/push/subscribe", strings.NewReader(`{"endpoint":"https://evil.example.com/x","keys":{"p256dh":"`+testP256dh+`","auth":"`+testAuth+`"}}`))
	rec = httptest.NewRecorder()
	s.HandleSubscribe(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("SSRF endpoint status=%d want 400", rec.Code)
	}
	// Unsubscribe is idempotent (no allowlist on remove so stale entries
	// can always be cleaned up).
	unsub := `{"endpoint":"` + testEndpointFCM + `"}`
	req = httptest.NewRequest(http.MethodPost, "/api/push/unsubscribe", strings.NewReader(unsub))
	rec = httptest.NewRecorder()
	s.HandleUnsubscribe(rec, req)
	if rec.Code != http.StatusOK || s.Count() != 0 {
		t.Errorf("unsubscribe failed: status=%d count=%d", rec.Code, s.Count())
	}
	req = httptest.NewRequest(http.MethodPost, "/api/push/unsubscribe", strings.NewReader(unsub))
	rec = httptest.NewRecorder()
	s.HandleUnsubscribe(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("idempotent unsubscribe status=%d want 200", rec.Code)
	}
}

func TestPublicKeyEndpoint(t *testing.T) {
	s := newTestService(t)
	req := httptest.NewRequest(http.MethodGet, "/api/push/public-key", nil)
	rec := httptest.NewRecorder()
	s.HandlePublicKey(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
	var out struct {
		PublicKey string `json:"publicKey"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.PublicKey == "" || out.PublicKey != s.PublicKey() {
		t.Errorf("publicKey mismatch: %+v", out)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/push/public-key", nil)
	rec = httptest.NewRecorder()
	s.HandlePublicKey(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST public-key status=%d want 405", rec.Code)
	}
}

// fakeSnapshotter feeds scripted snapshots to checkAndNotify.
type fakeSnapshotter struct {
	steps []struct {
		agents []herdr.Agent
		err    error
	}
	i int
}

func (f *fakeSnapshotter) Snapshot() ([]herdr.Agent, []herdr.Workspace, error) {
	if f.i >= len(f.steps) {
		st := f.steps[len(f.steps)-1]
		return st.agents, nil, st.err
	}
	st := f.steps[f.i]
	f.i++
	return st.agents, nil, st.err
}

func okResp() *http.Response {
	return &http.Response{StatusCode: 201, Body: io.NopCloser(bytes.NewReader(nil))}
}

func TestCheckAndNotifyNoInitialFlood(t *testing.T) {
	s := newTestService(t)
	var sent int
	s.SetSender(func(ctx context.Context, msg []byte, sub webpush.Subscription) (*http.Response, error) {
		sent++
		return okResp(), nil
	})
	if err := s.AddSubscription(testEndpointFCM, testP256dh, testAuth, "test"); err != nil {
		t.Fatal(err)
	}
	snap := &fakeSnapshotter{steps: []struct {
		agents []herdr.Agent
		err    error
	}{
		{agents: []herdr.Agent{mkAgent("w1:p1", "term1", "done")}},
		{agents: []herdr.Agent{mkAgent("w1:p1", "term1", "done")}},
	}}
	var prev map[string]string
	next, err := s.checkAndNotify(snap, prev)
	if err != nil {
		t.Fatal(err)
	}
	prev = next
	if sent != 0 {
		t.Errorf("first poll must not send, sent=%d", sent)
	}
	if _, err := s.checkAndNotify(snap, prev); err != nil {
		t.Fatal(err)
	}
	if sent != 0 {
		t.Errorf("stable done must not send, sent=%d", sent)
	}
}

func TestCheckAndNotifyWorkingToDoneSends(t *testing.T) {
	s := newTestService(t)
	var bodies [][]byte
	s.SetSender(func(ctx context.Context, msg []byte, sub webpush.Subscription) (*http.Response, error) {
		bodies = append(bodies, append([]byte(nil), msg...))
		return okResp(), nil
	})
	if err := s.AddSubscription(testEndpointFCM, testP256dh, testAuth, "test"); err != nil {
		t.Fatal(err)
	}
	snap := &fakeSnapshotter{steps: []struct {
		agents []herdr.Agent
		err    error
	}{
		{agents: []herdr.Agent{mkAgent("w1:p1", "term1", "working")}},
		{agents: []herdr.Agent{{
			PaneID: "w1:p1", TerminalID: "term1", WorkspaceID: "w1",
			Agent: "crabcode", AgentStatus: "done", TerminalTitleStripped: "demo",
		}}},
	}}
	prev, err := s.checkAndNotify(snap, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(bodies) != 0 {
		t.Fatalf("baseline poll sent %d", len(bodies))
	}
	if _, err := s.checkAndNotify(snap, prev); err != nil {
		t.Fatal(err)
	}
	if len(bodies) != 1 {
		t.Fatalf("working->done should send once, sent=%d", len(bodies))
	}
	var payload PushPayload
	if err := json.Unmarshal(bodies[0], &payload); err != nil {
		t.Fatal(err)
	}
	if payload.AgentID != "term1" || payload.Status != "done" || payload.URL != "/?agent=term1" {
		t.Errorf("unexpected payload %+v", payload)
	}
}

func TestExpiredSubscriptionsRemoved(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "push.json")
	s, err := NewServiceWithPath(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AddSubscription("https://fcm.googleapis.com/fcm/send/gone", testP256dh, testAuth, ""); err != nil {
		t.Fatal(err)
	}
	if err := s.AddSubscription("https://fcm.googleapis.com/fcm/send/live", testP256dh, testAuth, ""); err != nil {
		t.Fatal(err)
	}
	s.SetSender(func(ctx context.Context, msg []byte, sub webpush.Subscription) (*http.Response, error) {
		if strings.Contains(sub.Endpoint, "gone") {
			return &http.Response{StatusCode: 410, Body: io.NopCloser(bytes.NewReader(nil))}, nil
		}
		return okResp(), nil
	})
	snap := &fakeSnapshotter{steps: []struct {
		agents []herdr.Agent
		err    error
	}{
		{agents: []herdr.Agent{mkAgent("w1:p1", "term1", "working")}},
		{agents: []herdr.Agent{mkAgent("w1:p1", "term1", "done")}},
	}}
	prev, err := s.checkAndNotify(snap, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.checkAndNotify(snap, prev); err != nil {
		t.Fatal(err)
	}
	if s.Count() != 1 {
		t.Fatalf("expired sub should be removed, count=%d", s.Count())
	}
	if got := s.List()[0].Endpoint; got != "https://fcm.googleapis.com/fcm/send/live" {
		t.Errorf("wrong sub survived: %s", got)
	}
}

func TestFanoutSkipsDisallowedWithoutDial(t *testing.T) {
	s := newTestService(t)
	if err := s.AddSubscription(testEndpointFCM, testP256dh, testAuth, ""); err != nil {
		t.Fatal(err)
	}
	// Inject a pre-hardening arbitrary endpoint directly (bypasses
	// AddSubscription validation) to simulate persisted attacker state.
	s.mu.Lock()
	s.subs["https://evil.example.com/steal"] = StoredSubscription{
		Endpoint: "https://evil.example.com/steal",
		P256dh:   testP256dh,
		Auth:     testAuth,
	}
	s.mu.Unlock()
	var called []string
	s.SetSender(func(ctx context.Context, msg []byte, sub webpush.Subscription) (*http.Response, error) {
		called = append(called, sub.Endpoint)
		return okResp(), nil
	})
	s.fanout([]byte(`{"title":"t"}`))
	for _, ep := range called {
		if strings.Contains(ep, "evil.example.com") {
			t.Fatalf("sender must not be called for disallowed host: %v", called)
		}
	}
	if len(called) != 1 || called[0] != testEndpointFCM {
		t.Fatalf("expected one call to allowed host, got %v", called)
	}
	// Disallowed endpoint is pruned without any network I/O.
	if s.Count() != 1 {
		t.Fatalf("disallowed sub should be pruned, count=%d", s.Count())
	}
}

func TestFanoutPrunesInvalidKeys(t *testing.T) {
	s := newTestService(t)
	if err := s.AddSubscription(testEndpointFCM, testP256dh, testAuth, ""); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.subs["https://fcm.googleapis.com/fcm/send/badkeys"] = StoredSubscription{
		Endpoint: "https://fcm.googleapis.com/fcm/send/badkeys",
		P256dh:   "short",
		Auth:     "short",
	}
	s.mu.Unlock()
	called := 0
	s.SetSender(func(ctx context.Context, msg []byte, sub webpush.Subscription) (*http.Response, error) {
		called++
		return okResp(), nil
	})
	s.fanout([]byte(`{"title":"t"}`))
	if called != 1 {
		t.Fatalf("invalid-key sub must be skipped, calls=%d", called)
	}
	if s.Count() != 1 {
		t.Fatalf("invalid-key sub should be pruned, count=%d", s.Count())
	}
}

func TestFanoutBoundedTimeout(t *testing.T) {
	s := newTestService(t)
	if err := s.AddSubscription("https://fcm.googleapis.com/fcm/send/slow", testP256dh, testAuth, ""); err != nil {
		t.Fatal(err)
	}
	s.SetSender(func(ctx context.Context, msg []byte, sub webpush.Subscription) (*http.Response, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	})
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.fanout([]byte(`{"title":"t"}`))
	}()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("fanout did not respect delivery timeout")
	}
	// Slow (non-expired) failure keeps the subscription for retry.
	if s.Count() != 1 {
		t.Errorf("transient failure should keep sub, count=%d", s.Count())
	}
}

func TestLoadPrunesInvalidPersisted(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "push.json")
	s, err := NewServiceWithPath(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AddSubscription(testEndpointFCM, testP256dh, testAuth, ""); err != nil {
		t.Fatal(err)
	}
	// Corrupt the file on disk with a pre-hardening arbitrary endpoint.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var pf persistedFile
	if err := json.Unmarshal(raw, &pf); err != nil {
		t.Fatal(err)
	}
	pf.Subscriptions = append(pf.Subscriptions, StoredSubscription{
		Endpoint: "https://evil.example.com/steal",
		P256dh:   testP256dh,
		Auth:     testAuth,
	})
	pf.Subscriptions = append(pf.Subscriptions, StoredSubscription{
		Endpoint: "https://fcm.googleapis.com/fcm/send/badkeys",
		P256dh:   "short",
		Auth:     "short",
	})
	out, _ := json.MarshalIndent(pf, "", "  ")
	if err := os.WriteFile(path, out, 0o600); err != nil {
		t.Fatal(err)
	}
	s2, err := NewServiceWithPath(path)
	if err != nil {
		t.Fatal(err)
	}
	if s2.Count() != 1 {
		t.Fatalf("load should prune invalid entries, count=%d subs=%+v", s2.Count(), s2.List())
	}
	if got := s2.List()[0].Endpoint; got != testEndpointFCM {
		t.Errorf("wrong sub survived reload: %s", got)
	}
}

// countingSnapshotter tracks how often the monitor actually polls herdr.
type countingSnapshotter struct {
	calls int64
	agents []herdr.Agent
}

func (c *countingSnapshotter) Snapshot() ([]herdr.Agent, []herdr.Workspace, error) {
	atomic.AddInt64(&c.calls, 1)
	return c.agents, nil, nil
}

func (c *countingSnapshotter) n() int64 { return atomic.LoadInt64(&c.calls) }

func TestMonitorSkipsWhenNoSubscriptions(t *testing.T) {
	s := newTestService(t)
	snap := &countingSnapshotter{}
	s.StartMonitor(snap, 20*time.Millisecond)
	defer s.Stop()
	// With zero subscriptions the monitor must not exec herdr at all.
	time.Sleep(120 * time.Millisecond)
	if n := snap.n(); n != 0 {
		t.Fatalf("monitor polled %d times with zero subs, want 0", n)
	}
	// After subscribing, polling resumes.
	if err := s.AddSubscription(testEndpointFCM, testP256dh, testAuth, ""); err != nil {
		t.Fatal(err)
	}
	time.Sleep(120 * time.Millisecond)
	if n := snap.n(); n == 0 {
		t.Fatal("monitor did not poll after subscription arrived")
	}
}

type hangingSnapshotter struct{}

func (hangingSnapshotter) Snapshot() ([]herdr.Agent, []herdr.Workspace, error) {
	select {} // block forever
}

func TestSnapshotTimeout(t *testing.T) {
	start := time.Now()
	_, _, err := snapshotWithTimeout(hangingSnapshotter{}, 50*time.Millisecond)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("snapshot timeout took too long: %v", elapsed)
	}
	if !strings.Contains(err.Error(), "timeout") {
		t.Errorf("error should mention timeout, got %v", err)
	}
}

type ctxSnapshotter struct {
	seenDeadline bool
}

func (c *ctxSnapshotter) Snapshot() ([]herdr.Agent, []herdr.Workspace, error) {
	return nil, nil, nil
}

func (c *ctxSnapshotter) SnapshotWithContext(ctx context.Context) ([]herdr.Agent, []herdr.Workspace, error) {
	if _, ok := ctx.Deadline(); ok {
		c.seenDeadline = true
	}
	return nil, nil, nil
}

func TestSnapshotWithContextPreferred(t *testing.T) {
	c := &ctxSnapshotter{}
	if _, _, err := snapshotWithTimeout(c, 50*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if !c.seenDeadline {
		t.Error("context snapshotter should receive a deadline")
	}
}
