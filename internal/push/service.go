package push

// Service owns VAPID keys, push subscriptions, delivery, and the
// background transition monitor.
//
// Storage: a single JSON file under the OS user-config dir
// (e.g. ~/Library/Application Support/herdr-serve/push.json on macOS,
// ~/.config/herdr-serve/push.json on Linux), overridable via
// HERDR_SERVE_PUSH_FILE. Directory is 0700, file is 0600 — both hold
// private key material and push endpoint secrets.
//
// Delivery: bounded per-subscription timeout (DeliveryTimeout), TTL of one
// day so offline phones still get completions, and automatic removal of
// expired subscriptions (HTTP 404/410 from the push service).
//
// Security: endpoints are constrained to legitimate browser push service
// hosts (FCM / Mozilla autopush / Apple push) plus operator-configured
// HERDR_SERVE_PUSH_EXTRA_HOSTS. Delivery uses an SSRF-safe HTTP client
// (no redirects, private/link-local/multicast IP dial guard). p256dh/auth
// are validated as 65-byte uncompressed P-256 points / 16-byte secrets.
//
// Monitor: the web App intentionally avoids herdr polling (terminal
// hitching), so this monitor is the only background poller. It polls only
// while subscriptions exist, runs iterations sequentially (no overlap),
// and bounds each Snapshot() with SnapshotTimeout.
import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Blankeos/herdr-serve/internal/herdr"
	webpush "github.com/SherClockHolmes/webpush-go"
)

const (
	// DefaultPollInterval is the background snapshot cadence. Snapshot() is
	// one cheap daemon round-trip; 10s keeps completion latency acceptable
	// without disturbing the terminal takeover stream.
	DefaultPollInterval = 10 * time.Second
	// DeliveryTimeout bounds each push-service POST.
	DeliveryTimeout = 10 * time.Second
	// SnapshotTimeout bounds each herdr Snapshot() inside the monitor.
	// It must stay below DefaultPollInterval so a hung daemon cannot wedge
	// the monitor or cause overlapping polls. *herdr.Client has no context
	// support, so the timeout is enforced with a goroutine + select (see
	// snapshotWithTimeout); snapppers that implement SnapshotWithContext
	// get a real cancellable context instead.
	SnapshotTimeout = 8 * time.Second
	// pushTTL lets an offline phone still receive a completion within a day.
	pushTTL = 60 * 60 * 24
	// vapidSubscriber becomes the VAPID `sub` claim (mailto: prefix added
	// by the webpush library when the value is not an https: URL).
	vapidSubscriber = "herdr-serve@localhost"
	// MaxSubscriptions caps stored push endpoints (abuse / leak guard).
	MaxSubscriptions = 100
	// maxUserAgentLen caps stored User-Agent (header-controlled bloat guard).
	maxUserAgentLen = 512
	// filePerm keeps VAPID private key + endpoint secrets private.
	filePerm = 0o600
	dirPerm  = 0o700
)

// Snapshotter is the minimal herdr read the monitor needs.
// *herdr.Client satisfies it; tests use a fake.
type Snapshotter interface {
	Snapshot() ([]herdr.Agent, []herdr.Workspace, error)
}

// contextSnapshotter is implemented by snappers that support cancellation.
// When present, snapshotWithTimeout uses it instead of the goroutine shim.
type contextSnapshotter interface {
	SnapshotWithContext(context.Context) ([]herdr.Agent, []herdr.Workspace, error)
}

// SenderFunc sends one encrypted push. Swappable in tests.
type SenderFunc func(ctx context.Context, msg []byte, sub webpush.Subscription) (*http.Response, error)

// StoredSubscription is a persisted Web Push subscription.
type StoredSubscription struct {
	Endpoint  string    `json:"endpoint"`
	P256dh    string    `json:"keys_p256dh"`
	Auth      string    `json:"keys_auth"`
	CreatedAt time.Time `json:"created_at"`
	UserAgent string    `json:"user_agent,omitempty"`
}

func (s StoredSubscription) toWebpush() webpush.Subscription {
	return webpush.Subscription{
		Endpoint: s.Endpoint,
		Keys: webpush.Keys{
			P256dh: s.P256dh,
			Auth:   s.Auth,
		},
	}
}

type persistedFile struct {
	VAPIDPublic   string               `json:"vapid_public"`
	VAPIDPrivate  string               `json:"vapid_private"`
	Subscriptions []StoredSubscription `json:"subscriptions"`
}

// Service is safe for concurrent use.
type Service struct {
	mu          sync.Mutex
	path        string
	vapidPublic string
	vapidPriv   string
	subs        map[string]StoredSubscription

	sender SenderFunc

	monitorMu     sync.Mutex
	monitorCancel context.CancelFunc
	monitorDone   chan struct{}
}

// ---------------------------------------------------------------------------
// Push-service host allowlist (SSRF hardening)
// ---------------------------------------------------------------------------

// allowedPushHosts are the exact public hosts operated by browser vendors.
// Chrome/Edge/Opera/Brave/Samsung Internet all use FCM; Firefox uses
// Mozilla autopush; Safari (macOS/iOS) uses Apple push.
var allowedPushHosts = map[string]struct{}{
	"fcm.googleapis.com":               {},
	"updates.push.services.mozilla.com": {},
	"web.push.apple.com":               {},
}

// allowedPushSuffixes covers future subdomains under vendor push domains
// (e.g. a new region endpoint). The leading dot prevents
// "evilpush.services.mozilla.com.evil.com" style bypasses — the match
// requires the trusted domain as a true parent.
var allowedPushSuffixes = []string{
	".push.services.mozilla.com",
	".push.apple.com",
}

// pushExtraHosts returns operator-configured additional allowed hosts from
// HERDR_SERVE_PUSH_EXTRA_HOSTS (comma-separated bare hostnames, e.g.
// "push.example.com,autopush.internal.example"). Each entry allows the exact
// host plus its subdomains. IP literals are ignored (never allowlisted —
// the dial guard would block private IPs anyway). This exists for
// self-hosted autopush deployments and for tests; production defaults to
// the vendor list only.
func pushExtraHosts() []string {
	raw := strings.TrimSpace(os.Getenv("HERDR_SERVE_PUSH_EXTRA_HOSTS"))
	if raw == "" {
		return nil
	}
	var out []string
	for _, part := range strings.Split(raw, ",") {
		h := strings.ToLower(strings.TrimSpace(part))
		h = strings.TrimSuffix(h, ".")
		h = strings.TrimPrefix(h, ".")
		h = strings.TrimSpace(h)
		if h == "" {
			continue
		}
		// Tolerate "host:port" entries by stripping the port.
		if host, _, err := net.SplitHostPort(h); err == nil {
			h = strings.ToLower(strings.TrimSpace(host))
			h = strings.TrimSuffix(h, ".")
			if h == "" {
				continue
			}
		}
		// Never allowlist IP literals (v4, v6, or bracketed).
		if ip := net.ParseIP(strings.Trim(h, "[]")); ip != nil {
			continue
		}
		// Bare hostnames only — reject URLs, userinfo, paths, queries.
		if strings.ContainsAny(h, " /@:?#") {
			continue
		}
		out = append(out, h)
	}
	return out
}

// isAllowedPushHost reports whether host (bare DNS name, any case) is a
// legitimate push-service host.
func isAllowedPushHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	host = strings.TrimSuffix(host, ".")
	if host == "" {
		return false
	}
	if net.ParseIP(strings.Trim(host, "[]")) != nil {
		return false
	}
	if _, ok := allowedPushHosts[host]; ok {
		return true
	}
	for _, suf := range allowedPushSuffixes {
		if len(host) > len(suf) && strings.HasSuffix(host, suf) {
			return true
		}
	}
	for _, extra := range pushExtraHosts() {
		if host == extra || (len(host) > len(extra)+1 && strings.HasSuffix(host, "."+extra)) {
			return true
		}
	}
	return false
}

// isAllowedPushEndpoint parses endpoint and enforces https + allowlisted
// host + no credentials + no IP literal. Custom ports are allowed only for
// explicitly configured extra hosts (self-hosted autopush); vendor hosts
// must use the default 443 (explicit :443 is tolerated).
func isAllowedPushEndpoint(endpoint string) bool {
	u, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil {
		return false
	}
	if !strings.EqualFold(u.Scheme, "https") {
		return false
	}
	if u.User != nil {
		return false
	}
	host := strings.ToLower(strings.TrimSpace(u.Hostname()))
	host = strings.TrimSuffix(host, ".")
	if host == "" {
		return false
	}
	if net.ParseIP(strings.Trim(host, "[]")) != nil {
		return false
	}
	if p := u.Port(); p != "" && p != "443" {
		extra := false
		for _, e := range pushExtraHosts() {
			if host == e || (len(host) > len(e)+1 && strings.HasSuffix(host, "."+e)) {
				extra = true
				break
			}
		}
		if !extra {
			return false
		}
	}
	return isAllowedPushHost(host)
}

// ---------------------------------------------------------------------------
// Key validation (RFC 8291 / RFC 8188 lengths)
// ---------------------------------------------------------------------------

// decodePushKey decodes a Web Push subscription key (p256dh/auth), accepting
// standard or URL-safe base64 with or without padding (mirrors webpush-go).
func decodePushKey(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, fmt.Errorf("empty key")
	}
	if strings.ContainsAny(s, " \t\n\r") {
		return nil, fmt.Errorf("invalid base64")
	}
	padded := s
	if rem := len(padded) % 4; rem != 0 {
		// len%4==1 is never valid base64; the decodes below will fail.
		padded += strings.Repeat("=", 4-rem)
	}
	if b, err := base64.StdEncoding.DecodeString(padded); err == nil {
		return b, nil
	}
	if b, err := base64.URLEncoding.DecodeString(padded); err == nil {
		return b, nil
	}
	return nil, fmt.Errorf("invalid base64")
}

// validatePushKeys enforces decoded lengths: p256dh is a 65-byte uncompressed
// P-256 point (0x04 || X || Y), auth is a 16-byte secret. Browsers always
// produce exactly these sizes; anything else is either corrupt or an SSRF
// probe using placeholder keys.
func validatePushKeys(p256dh, auth string) error {
	rawP, err := decodePushKey(p256dh)
	if err != nil {
		return fmt.Errorf("invalid p256dh")
	}
	if len(rawP) != 65 {
		return fmt.Errorf("invalid p256dh length")
	}
	if rawP[0] != 0x04 {
		return fmt.Errorf("invalid p256dh")
	}
	rawA, err := decodePushKey(auth)
	if err != nil {
		return fmt.Errorf("invalid auth")
	}
	if len(rawA) != 16 {
		return fmt.Errorf("invalid auth length")
	}
	return nil
}

// ---------------------------------------------------------------------------
// SSRF-safe HTTP client (defense in depth behind the host allowlist)
// ---------------------------------------------------------------------------

var blockedPushCIDRs []*net.IPNet

func init() {
	for _, c := range []string{
		"0.0.0.0/8",
		"100.64.0.0/10", // CGNAT / shared address space
		"192.0.2.0/24",  // TEST-NET-1
		"198.51.100.0/24",
		"203.0.113.0/24",
		"192.88.99.0/24", // 6to4 relay (deprecated)
		"198.18.0.0/15",  // benchmarking
		"240.0.0.0/4",    // reserved
		"::/128",
		"64:ff9b::/96", // NAT64
		"100::/64",     // discard
		"2001:db8::/32", // documentation
		"fc00::/7",      // unique local
		"fe80::/10",     // link local
		"ff00::/8",      // multicast
	} {
		if _, n, err := net.ParseCIDR(c); err == nil {
			blockedPushCIDRs = append(blockedPushCIDRs, n)
		}
	}
}

// isPublicIP reports whether ip is a routable public address safe to dial
// for push delivery. Anything loopback/private/link-local/multicast/
// unspecified/reserved is rejected — this blocks cloud-metadata
// (169.254.169.254), intranet, and localhost even if DNS were poisoned.
func isPublicIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() {
		return false
	}
	if ip.IsPrivate() {
		return false
	}
	for _, n := range blockedPushCIDRs {
		if n.Contains(ip) {
			return false
		}
	}
	if !ip.IsGlobalUnicast() {
		return false
	}
	return true
}

// ssrfDialContext resolves host, fails closed if ANY resolved IP is
// non-public, then dials a validated IP directly (avoids re-resolution
// TOCTOU). TLS SNI is preserved by http.Transport (derived from the request
// URL, not the dial address).
func ssrfDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	// IP literal: check directly.
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
		if !isPublicIP(ip) {
			return nil, fmt.Errorf("push: blocked private IP")
		}
		d := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
		return d.DialContext(ctx, network, addr)
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("push: no addresses for %s", host)
	}
	for _, ia := range ips {
		if !isPublicIP(ia.IP) {
			return nil, fmt.Errorf("push: blocked non-public IP for %s", host)
		}
	}
	d := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	var lastErr error
	for _, ia := range ips {
		conn, err := d.DialContext(ctx, network, net.JoinHostPort(ia.IP.String(), port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("push: dial failed for %s", host)
}

var (
	secureClientOnce sync.Once
	secureClient     *http.Client
)

// securePushClient returns the shared SSRF-safe client for push delivery:
// no redirects (push services never redirect; following one could bounce to
// an internal URL), dial guard against private IPs, and bounded timeouts.
func securePushClient() *http.Client {
	secureClientOnce.Do(func() {
		tr := &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           ssrfDialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          10,
			IdleConnTimeout:       30 * time.Second,
			TLSHandshakeTimeout:   5 * time.Second,
			ResponseHeaderTimeout: 5 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		}
		secureClient = &http.Client{
			Transport: tr,
			Timeout:   DeliveryTimeout,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	})
	return secureClient
}

// snapshotWithTimeout runs snap.Snapshot with a bound. If the snapshotter
// supports SnapshotWithContext it is used directly; otherwise Snapshot() is
// run in a goroutine with a select timeout so a hung `herdr api snapshot`
// cannot wedge the monitor loop (the leaked goroutine uses a buffered
// channel so it never blocks on send).
func snapshotWithTimeout(snap Snapshotter, timeout time.Duration) ([]herdr.Agent, []herdr.Workspace, error) {
	if snap == nil {
		return nil, nil, fmt.Errorf("push: nil snapshotter")
	}
	if timeout <= 0 {
		timeout = SnapshotTimeout
	}
	if cs, ok := snap.(contextSnapshotter); ok {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		return cs.SnapshotWithContext(ctx)
	}
	type result struct {
		agents []herdr.Agent
		spaces []herdr.Workspace
		err    error
	}
	ch := make(chan result, 1)
	go func() {
		a, w, e := snap.Snapshot()
		ch <- result{agents: a, spaces: w, err: e}
	}()
	select {
	case r := <-ch:
		return r.agents, r.spaces, r.err
	case <-time.After(timeout):
		return nil, nil, fmt.Errorf("push: snapshot timeout after %s", timeout)
	}
}

// DefaultConfigPath resolves the push state file location.
func DefaultConfigPath() string {
	if p := strings.TrimSpace(os.Getenv("HERDR_SERVE_PUSH_FILE")); p != "" {
		return p
	}
	if dir, err := os.UserConfigDir(); err == nil && strings.TrimSpace(dir) != "" {
		return filepath.Join(dir, "herdr-serve", "push.json")
	}
	home, _ := os.UserHomeDir()
	if strings.TrimSpace(home) == "" {
		home = "."
	}
	return filepath.Join(home, ".config", "herdr-serve", "push.json")
}

// NewService loads (or generates) state at the default path.
func NewService() (*Service, error) {
	return NewServiceWithPath(DefaultConfigPath())
}

// NewServiceWithPath loads (or generates) state at path.
// Empty path keeps everything in memory (no persistence) — useful for tests.
func NewServiceWithPath(path string) (*Service, error) {
	s := &Service{
		path: strings.TrimSpace(path),
		subs: make(map[string]StoredSubscription),
	}
	s.sender = s.defaultSend
	if s.path == "" {
		pub, priv, err := webpush.GenerateVAPIDKeys()
		if err != nil {
			return nil, fmt.Errorf("push: generate vapid keys: %w", err)
		}
		s.vapidPublic, s.vapidPriv = pub, priv
		return s, nil
	}
	if err := os.MkdirAll(filepath.Dir(s.path), dirPerm); err != nil {
		return nil, fmt.Errorf("push: mkdir config: %w", err)
	}
	if err := s.loadOrInit(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Service) loadOrInit() error {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		if !os.IsNotExist(err) {
			return fmt.Errorf("push: read state: %w", err)
		}
		pub, priv, genErr := webpush.GenerateVAPIDKeys()
		if genErr != nil {
			return fmt.Errorf("push: generate vapid keys: %w", genErr)
		}
		s.vapidPublic, s.vapidPriv = pub, priv
		return s.saveLocked()
	}
	var pf persistedFile
	if err := json.Unmarshal(raw, &pf); err != nil {
		return fmt.Errorf("push: parse state: %w", err)
	}
	if strings.TrimSpace(pf.VAPIDPublic) == "" || strings.TrimSpace(pf.VAPIDPrivate) == "" {
		pub, priv, genErr := webpush.GenerateVAPIDKeys()
		if genErr != nil {
			return fmt.Errorf("push: generate vapid keys: %w", genErr)
		}
		pf.VAPIDPublic, pf.VAPIDPrivate = pub, priv
	}
	s.vapidPublic = strings.TrimSpace(pf.VAPIDPublic)
	s.vapidPriv = strings.TrimSpace(pf.VAPIDPrivate)
	for _, sub := range pf.Subscriptions {
		ep := strings.TrimSpace(sub.Endpoint)
		if ep == "" {
			continue
		}
		if _, ok := s.subs[ep]; ok {
			continue
		}
		if len(s.subs) >= MaxSubscriptions {
			break
		}
		// Self-heal: drop persisted entries that are no longer valid
		// (pre-hardening arbitrary endpoints or malformed keys) without
		// ever dialing them.
		if err := validateSubscription(sub.Endpoint, sub.P256dh, sub.Auth); err != nil {
			continue
		}
		sub.Endpoint = ep
		sub.P256dh = strings.TrimSpace(sub.P256dh)
		sub.Auth = strings.TrimSpace(sub.Auth)
		if len(sub.UserAgent) > maxUserAgentLen {
			sub.UserAgent = sub.UserAgent[:maxUserAgentLen]
		}
		s.subs[ep] = sub
	}
	// Persist back in case keys were just generated or invalid entries were
	// pruned.
	return s.saveLocked()
}

// saveLocked writes state atomically with 0600 perms.
func (s *Service) saveLocked() error {
	if s.path == "" {
		return nil // in-memory mode
	}
	pf := persistedFile{
		VAPIDPublic:  s.vapidPublic,
		VAPIDPrivate: s.vapidPriv,
	}
	for _, sub := range s.subs {
		pf.Subscriptions = append(pf.Subscriptions, sub)
	}
	raw, err := json.MarshalIndent(pf, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, filePerm); err != nil {
		return err
	}
	// Ensure 0600 even if the file pre-existed with wider perms.
	_ = os.Chmod(tmp, filePerm)
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	_ = os.Chmod(s.path, filePerm)
	return nil
}

// SetSender overrides the delivery function (tests).
func (s *Service) SetSender(fn SenderFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if fn != nil {
		s.sender = fn
	}
}

// PublicKey returns the VAPID public key (URL-safe base64) for
// PushManager.subscribe(applicationServerKey).
func (s *Service) PublicKey() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.vapidPublic
}

// Count returns the number of stored subscriptions.
func (s *Service) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.subs)
}

// List returns a copy of stored subscriptions (oldest first-ish).
func (s *Service) List() []StoredSubscription {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]StoredSubscription, 0, len(s.subs))
	for _, sub := range s.subs {
		out = append(out, sub)
	}
	return out
}

// validateSubscription bounds-checks client-supplied push credentials.
//
// SSRF: endpoint must be https:// on a legitimate browser push-service host
// (or HERDR_SERVE_PUSH_EXTRA_HOSTS). Arbitrary https URLs — including
// intranet, cloud-metadata, or attacker hosts — are rejected before anything
// is stored or dialed. Keys must decode to the exact RFC sizes.
func validateSubscription(endpoint, p256dh, auth string) error {
	endpoint = strings.TrimSpace(endpoint)
	p256dh = strings.TrimSpace(p256dh)
	auth = strings.TrimSpace(auth)
	if endpoint == "" || p256dh == "" || auth == "" {
		return fmt.Errorf("endpoint and keys required")
	}
	if len(endpoint) > 2048 || len(p256dh) > 512 || len(auth) > 512 {
		return fmt.Errorf("subscription fields too long")
	}
	u, err := url.Parse(endpoint)
	if err != nil || u == nil {
		return fmt.Errorf("invalid endpoint")
	}
	if !strings.EqualFold(u.Scheme, "https") {
		return fmt.Errorf("endpoint must be https://")
	}
	if u.User != nil {
		return fmt.Errorf("endpoint must not contain credentials")
	}
	host := strings.ToLower(strings.TrimSpace(u.Hostname()))
	host = strings.TrimSuffix(host, ".")
	if host == "" {
		return fmt.Errorf("invalid endpoint")
	}
	if net.ParseIP(strings.Trim(host, "[]")) != nil {
		return fmt.Errorf("endpoint host not allowed")
	}
	if p := u.Port(); p != "" && p != "443" {
		extra := false
		for _, e := range pushExtraHosts() {
			if host == e || (len(host) > len(e)+1 && strings.HasSuffix(host, "."+e)) {
				extra = true
				break
			}
		}
		if !extra {
			return fmt.Errorf("endpoint host not allowed")
		}
	}
	if !isAllowedPushHost(host) {
		return fmt.Errorf("endpoint host not allowed")
	}
	if err := validatePushKeys(p256dh, auth); err != nil {
		return err
	}
	return nil
}

// AddSubscription stores (or refreshes) a push subscription.
func (s *Service) AddSubscription(endpoint, p256dh, auth, userAgent string) error {
	if err := validateSubscription(endpoint, p256dh, auth); err != nil {
		return err
	}
	endpoint = strings.TrimSpace(endpoint)
	ua := strings.TrimSpace(userAgent)
	if len(ua) > maxUserAgentLen {
		ua = ua[:maxUserAgentLen]
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.subs[endpoint]; !ok && len(s.subs) >= MaxSubscriptions {
		return fmt.Errorf("too many subscriptions")
	}
	s.subs[endpoint] = StoredSubscription{
		Endpoint:  endpoint,
		P256dh:    strings.TrimSpace(p256dh),
		Auth:      strings.TrimSpace(auth),
		CreatedAt: time.Now().UTC(),
		UserAgent: ua,
	}
	return s.saveLocked()
}

// RemoveSubscription deletes by endpoint. Returns true if one was removed.
// No allowlist check here on purpose: unsubscribing must always be able to
// clean up stale or pre-hardening entries.
func (s *Service) RemoveSubscription(endpoint string) bool {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.subs[endpoint]; !ok {
		return false
	}
	delete(s.subs, endpoint)
	_ = s.saveLocked()
	return true
}

func (s *Service) defaultSend(ctx context.Context, msg []byte, sub webpush.Subscription) (*http.Response, error) {
	// Defense in depth: re-check the allowlist at send time (persisted state
	// may predate hardening or have been edited on disk).
	if !isAllowedPushEndpoint(sub.Endpoint) {
		return nil, fmt.Errorf("push: endpoint host not allowed")
	}
	s.mu.Lock()
	pub, priv := s.vapidPublic, s.vapidPriv
	s.mu.Unlock()
	opts := &webpush.Options{
		Subscriber:      vapidSubscriber,
		VAPIDPublicKey:  pub,
		VAPIDPrivateKey: priv,
		TTL:             pushTTL,
		HTTPClient:      securePushClient(),
	}
	return webpush.SendNotificationWithContext(ctx, msg, &sub, opts)
}

// isExpired reports push-service "subscription gone" statuses.
func isExpired(status int) bool {
	return status == http.StatusNotFound || status == http.StatusGone
}

// fanout delivers msg to every stored subscription with a bounded timeout
// each, pruning expired endpoints. Delivery is sequential to keep thundering
// herds small (subscription counts are tiny); each POST is still bounded by
// DeliveryTimeout so one slow push service cannot stall the monitor.
//
// Disallowed endpoints (non-allowlisted hosts) and malformed keys are never
// dialed — they are pruned silently to self-heal pre-hardening state.
func (s *Service) fanout(msg []byte) {
	s.mu.Lock()
	subs := make([]StoredSubscription, 0, len(s.subs))
	for _, sub := range s.subs {
		subs = append(subs, sub)
	}
	sender := s.sender
	s.mu.Unlock()
	if len(subs) == 0 || sender == nil {
		return
	}
	var expired []string
	var invalid []string
	for _, st := range subs {
		if !isAllowedPushEndpoint(st.Endpoint) {
			invalid = append(invalid, st.Endpoint)
			continue
		}
		if err := validatePushKeys(st.P256dh, st.Auth); err != nil {
			invalid = append(invalid, st.Endpoint)
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), DeliveryTimeout)
		resp, err := sender(ctx, msg, st.toWebpush())
		cancel()
		if err != nil {
			// Network/encryption error: keep the subscription; the next
			// transition will retry. (No log spam per sub here.)
			continue
		}
		if resp != nil && resp.Body != nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
			_ = resp.Body.Close()
		}
		if resp != nil && isExpired(resp.StatusCode) {
			expired = append(expired, st.Endpoint)
		}
	}
	if len(expired) == 0 && len(invalid) == 0 {
		return
	}
	s.mu.Lock()
	for _, ep := range expired {
		delete(s.subs, ep)
	}
	for _, ep := range invalid {
		delete(s.subs, ep)
	}
	_ = s.saveLocked()
	s.mu.Unlock()
}

// checkAndNotify runs one monitor iteration: snapshot, diff, fan out.
// prev==nil baselines without notifying (no initial flood).
func (s *Service) checkAndNotify(snap Snapshotter, prev map[string]string) (map[string]string, error) {
	agents, workspaces, err := snapshotWithTimeout(snap, SnapshotTimeout)
	if err != nil {
		return prev, err
	}
	labels := make(map[string]string, len(workspaces))
	for _, w := range workspaces {
		if strings.TrimSpace(w.WorkspaceID) == "" {
			continue
		}
		label := strings.TrimSpace(w.Label)
		if label == "" {
			label = strings.TrimSpace(w.WorkspaceID)
		}
		labels[strings.TrimSpace(w.WorkspaceID)] = label
	}
	events, next := DetectTransitions(prev, agents)
	for _, ev := range events {
		msg, err := json.Marshal(BuildPushMessage(ev, labels[ev.WorkspaceID]))
		if err != nil {
			continue
		}
		s.fanout(msg)
	}
	return next, nil
}

// StartMonitor launches the background transition watcher. Safe to call
// twice (restarts). Stop with Stop(). A nil snapshotter is a no-op.
//
// Load: the monitor snapshots only while at least one subscription exists —
// with zero subscribers no `herdr api snapshot` exec runs at all (the App
// intentionally avoids herdr polling because it hitches the terminal
// takeover stream; this monitor is the only background poller). When the
// last subscriber leaves, the baseline is reset so transitions missed while
// unsubscribed never notify the next subscriber.
//
// Overlap: iterations run sequentially in one goroutine (never `go` per
// tick) and each Snapshot() is bounded by SnapshotTimeout (< interval), so
// polls cannot overlap or accumulate.
func (s *Service) StartMonitor(snap Snapshotter, interval time.Duration) {
	if snap == nil {
		return
	}
	if interval <= 0 {
		interval = DefaultPollInterval
	}
	s.monitorMu.Lock()
	defer s.monitorMu.Unlock()
	if s.monitorCancel != nil {
		s.monitorCancel()
		if s.monitorDone != nil {
			<-s.monitorDone
		}
		s.monitorCancel = nil
		s.monitorDone = nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.monitorCancel = cancel
	s.monitorDone = done
	go func() {
		defer close(done)
		t := time.NewTicker(interval)
		defer t.Stop()
		var prev map[string]string // nil => first poll baselines
		// Prime immediately (only when subscribed) so the baseline is
		// fresh, then tick.
		if s.Count() > 0 {
			if next, err := s.checkAndNotify(snap, prev); err == nil {
				prev = next
			} else {
				log.Printf("push: initial snapshot: %v", err)
			}
		}
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if s.Count() == 0 {
					// Nobody to notify: skip the herdr exec entirely
					// and reset the baseline (no flood on resubscribe).
					prev = nil
					continue
				}
				next, err := s.checkAndNotify(snap, prev)
				if err != nil {
					// Transient herdr errors are normal (daemon restart);
					// keep last-good state so the next success diffs cleanly.
					// Timeout errors from snapshotWithTimeout land here too.
					continue
				}
				prev = next
			}
		}
	}()
}

// Stop halts the background monitor (if running).
func (s *Service) Stop() {
	s.monitorMu.Lock()
	defer s.monitorMu.Unlock()
	if s.monitorCancel != nil {
		s.monitorCancel()
		if s.monitorDone != nil {
			<-s.monitorDone
		}
		s.monitorCancel = nil
		s.monitorDone = nil
	}
}
