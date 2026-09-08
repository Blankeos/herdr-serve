package push

// HTTP handlers for Web Push subscription management.
//
// All three endpoints are mounted behind requireAuth by the server package
// (see internal/server/push_routes.go), so only holders of the herdr-serve
// token can register endpoints or read the VAPID public key.
//
//	GET  /api/push/public-key  -> { publicKey }
//	POST /api/push/subscribe   -> { ok:true }  (body: {endpoint, keys:{p256dh,auth}})
//	POST /api/push/unsubscribe -> { ok:true }  (body: {endpoint})
import (
	"encoding/json"
	"net/http"
	"strings"
)

const maxPushBody = 8 << 10 // 8 KiB — subscriptions are a few hundred bytes

type subscribeBody struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
	// Some clients nest keys at top level; accept both shapes.
	P256dh string `json:"p256dh"`
	Auth   string `json:"auth"`
}

type unsubscribeBody struct {
	Endpoint string `json:"endpoint"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// HandlePublicKey serves the VAPID public key for PushManager.subscribe().
func (s *Service) HandlePublicKey(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"publicKey": s.PublicKey()})
}

// HandleSubscribe stores a browser push subscription.
func (s *Service) HandleSubscribe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxPushBody)
	var body subscribeBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	p256dh := strings.TrimSpace(body.Keys.P256dh)
	if p256dh == "" {
		p256dh = strings.TrimSpace(body.P256dh)
	}
	auth := strings.TrimSpace(body.Keys.Auth)
	if auth == "" {
		auth = strings.TrimSpace(body.Auth)
	}
	if err := s.AddSubscription(body.Endpoint, p256dh, auth, r.UserAgent()); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// HandleUnsubscribe removes a push subscription (idempotent).
func (s *Service) HandleUnsubscribe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxPushBody)
	var body unsubscribeBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	s.RemoveSubscription(body.Endpoint)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
