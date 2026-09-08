package server

// Web Push route wiring (separate file to avoid conflicts with concurrent
// route work — e.g. the uploads agent — in server.go).
//
// Endpoints (all behind requireAuth, i.e. Bearer token or ?token=):
//
//	GET  /api/push/public-key  VAPID public key for PushManager.subscribe()
//	POST /api/push/subscribe   store a browser PushSubscription
//	POST /api/push/unsubscribe remove a PushSubscription (idempotent)
//
// The background transition monitor (working -> done/idle/blocked) is
// started from Server.New via startPushMonitor and needs no route.
import (
	"net/http"

	"github.com/Blankeos/herdr-serve/internal/push"
)

func (s *Server) mountPushRoutes() {
	if s.push == nil {
		return
	}
	s.mux.Handle("GET /api/push/public-key", s.requireAuth(http.HandlerFunc(s.push.HandlePublicKey)))
	s.mux.Handle("POST /api/push/subscribe", s.requireAuth(http.HandlerFunc(s.push.HandleSubscribe)))
	s.mux.Handle("POST /api/push/unsubscribe", s.requireAuth(http.HandlerFunc(s.push.HandleUnsubscribe)))
}

func (s *Server) startPushMonitor() {
	if s.push == nil || s.client == nil {
		return
	}
	// Single shared cadence with push.DefaultPollInterval. The monitor itself
	// polls herdr only while subscriptions exist (see push.Service), because
	// the App intentionally avoids herdr polling (terminal hitching).
	s.push.StartMonitor(s.client, push.DefaultPollInterval)
}

// StopPush halts the background push monitor (tests / graceful shutdown).
func (s *Server) StopPush() {
	if s.push != nil {
		s.push.Stop()
	}
}

// PushService exposes the push subsystem (tests / health checks).
func (s *Server) PushService() *push.Service {
	return s.push
}

// pushSWHeaders ensures the push service worker is never aggressively
// cached (otherwise clients pin stale push handling) and advertises root
// scope. It composes with brandingHeaders without touching it:
//
//	s.mux.Handle("/", spa(pushSWHeaders(brandingHeaders(fileServer))))
func pushSWHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/push-sw.js" {
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Service-Worker-Allowed", "/")
		}
		next.ServeHTTP(w, r)
	})
}
