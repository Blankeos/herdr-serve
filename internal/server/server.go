package server

import (
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/carlo/herdr-serve/internal/auth"
	"github.com/carlo/herdr-serve/internal/favicon"
	"github.com/carlo/herdr-serve/internal/herdr"
	"github.com/carlo/herdr-serve/internal/relay"
	"github.com/carlo/herdr-serve/web"
)

type Server struct {
	client *herdr.Client
	herdr  string
	mux    *http.ServeMux
	gate   *auth.Gate

	statusCache *snapshotCache
}

// snapshotCache serves a serialized payload for a short TTL with
// single-flight dedupe, so N browser tabs polling concurrently cause at most
// one daemon round-trip per TTL window instead of one per request.
type snapshotCache struct {
	mu      sync.Mutex
	cond    *sync.Cond
	payload []byte
	expires time.Time
	loading bool
}

func newSnapshotCache() *snapshotCache {
	c := &snapshotCache{}
	c.cond = sync.NewCond(&c.mu)
	return c
}

func (c *snapshotCache) get(fetch func() ([]byte, error)) ([]byte, error) {
	c.mu.Lock()
	defer func() { c.mu.Unlock() }()
	for {
		if len(c.payload) > 0 && time.Now().Before(c.expires) {
			return c.payload, nil
		}
		if c.loading {
			c.cond.Wait()
			continue
		}
		c.loading = true
		c.mu.Unlock()
		payload, err := fetch()
		c.mu.Lock()
		c.loading = false
		c.cond.Broadcast()
		if err != nil {
			// Don't cache failures: next caller retries immediately.
			return nil, err
		}
		c.payload = payload
		c.expires = time.Now().Add(600 * time.Millisecond)
		return payload, nil
	}
}

func New(client *herdr.Client, password string) *Server {
	bin := "herdr"
	if client != nil && client.Bin != "" {
		bin = client.Bin
	}
	s := &Server{
		client:      client,
		herdr:       bin,
		mux:         http.NewServeMux(),
		gate:        auth.New(password),
		statusCache: newSnapshotCache(),
	}
	s.routes()
	return s
}

func (s *Server) Serve(ln net.Listener) error {
	return http.Serve(ln, s.cors(s.mux))
}

func (s *Server) Handler() http.Handler {
	return s.cors(s.mux)
}

func (s *Server) routes() {
	// Auth endpoints stay public so the UI can unlock.
	s.mux.HandleFunc("GET /api/auth/status", s.handleAuthStatus)
	s.mux.HandleFunc("POST /api/auth/login", s.handleAuthLogin)

	s.mux.Handle("GET /api/agents", s.requireAuth(http.HandlerFunc(s.handleListAgents)))
	s.mux.Handle("POST /api/agents", s.requireAuth(http.HandlerFunc(s.handleCreateAgent)))
	s.mux.Handle("GET /api/agents/{id}", s.requireAuth(http.HandlerFunc(s.handleGetAgent)))
	s.mux.Handle("GET /api/agents/{id}/read", s.requireAuth(http.HandlerFunc(s.handleRead)))
	s.mux.Handle("POST /api/agents/{id}/prompt", s.requireAuth(http.HandlerFunc(s.handlePrompt)))
	s.mux.Handle("POST /api/agents/{id}/approve", s.requireAuth(http.HandlerFunc(s.handleApprove)))
	s.mux.Handle("POST /api/agents/{id}/interrupt", s.requireAuth(http.HandlerFunc(s.handleInterrupt)))
	s.mux.Handle("POST /api/agents/{id}/keys", s.requireAuth(http.HandlerFunc(s.handleKeys)))
	s.mux.Handle("GET /api/workspaces", s.requireAuth(http.HandlerFunc(s.handleListWorkspaces)))
	s.mux.Handle("GET /api/project-favicon", s.requireAuth(http.HandlerFunc(s.handleProjectFavicon)))
	s.mux.Handle("/ws/term", s.requireAuth(&relay.Handler{Herdr: s.herdr}))

	static, err := fs.Sub(web.Dist, "dist")
	uiReady := false
	if err == nil {
		if f, err := static.Open("index.html"); err == nil {
			_ = f.Close()
			uiReady = true
		}
	}
	if !uiReady {
		s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(`<!doctype html><meta charset=utf-8><title>herdr-serve</title>
<body style="font:14px system-ui;background:#151515;color:#eee;padding:2rem">
<h1>herdr-serve</h1>
<p>API is up. Build the UI: <code>just ui</code></p>
<p><a href="/api/agents" style="color:#6c8ed8">/api/agents</a></p>
</body>`))
		})
		return
	}
	fileServer := http.FileServer(http.FS(static))
	s.mux.Handle("/", spa(fileServer))
}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.gate.Authorized(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleAuthStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"required": s.gate.Required()})
}

type loginBody struct {
	Password string `json:"password"`
}

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if !s.gate.Required() {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "token": ""})
		return
	}
	var body loginBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if !s.gate.AcceptsPassword(body.Password) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid password"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "token": s.gate.Token()})
}

func spa(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
	})
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func (s *Server) statusSnapshot() (agents []byte, workspaces []byte, err error) {
	payload, err := s.statusCache.get(func() ([]byte, error) {
		ags, wss, err := s.client.Snapshot()
		if err != nil {
			return nil, err
		}
		agentsJSON, err := json.Marshal(map[string]any{"agents": ags})
		if err != nil {
			return nil, err
		}
		workspacesJSON, err := json.Marshal(map[string]any{"workspaces": wss})
		if err != nil {
			return nil, err
		}
		// Pack both under one cached blob; split on read.
		both, err := json.Marshal(map[string]json.RawMessage{
			"agents":     agentsJSON,
			"workspaces": workspacesJSON,
		})
		return both, err
	})
	if err != nil {
		return nil, nil, err
	}
	var both struct {
		Agents     json.RawMessage `json:"agents"`
		Workspaces json.RawMessage `json:"workspaces"`
	}
	if err := json.Unmarshal(payload, &both); err != nil {
		return nil, nil, err
	}
	return both.Agents, both.Workspaces, nil
}

func (s *Server) handleListAgents(w http.ResponseWriter, r *http.Request) {
	agents, _, err := s.statusSnapshot()
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(agents)
}

func (s *Server) handleListWorkspaces(w http.ResponseWriter, r *http.Request) {
	_, workspaces, err := s.statusSnapshot()
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(workspaces)
}

type createAgentBody struct {
	WorkspaceID string `json:"workspace_id"`
	Kind        string `json:"kind"`
	Label       string `json:"label"`
	Cwd         string `json:"cwd"`
	Name        string `json:"name"`
	Focus       bool   `json:"focus"`
}

func (s *Server) handleCreateAgent(w http.ResponseWriter, r *http.Request) {
	var body createAgentBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	body.WorkspaceID = strings.TrimSpace(body.WorkspaceID)
	body.Kind = strings.TrimSpace(strings.ToLower(body.Kind))
	body.Label = strings.TrimSpace(body.Label)
	body.Cwd = strings.TrimSpace(body.Cwd)
	body.Name = strings.TrimSpace(body.Name)
	if body.WorkspaceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "workspace_id required"})
		return
	}
	if body.Kind == "" {
		body.Kind = "crabcode"
	}
	if body.Label == "" {
		body.Label = body.Kind
	}
	if body.Name == "" {
		body.Name = body.Kind
	}

	created, err := s.client.CreateTab(body.WorkspaceID, body.Cwd, body.Label, body.Focus)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	paneID := created.RootPane.PaneID
	if paneID == "" {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "tab created without pane id"})
		return
	}

	// Give the shell a beat to become interactive before launching.
	time.Sleep(350 * time.Millisecond)

	switch body.Kind {
	case "crabcode":
		if err := s.client.PaneRun(paneID, "crabcode"); err != nil {
			writeErr(w, http.StatusBadGateway, err)
			return
		}
	default:
		if err := s.client.AgentStart(body.Name, body.Kind, paneID); err != nil {
			writeErr(w, http.StatusBadGateway, err)
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":           true,
		"kind":         body.Kind,
		"pane_id":      paneID,
		"terminal_id":  created.RootPane.TerminalID,
		"tab_id":       created.Tab.TabID,
		"workspace_id": body.WorkspaceID,
		"root_pane":    created.RootPane,
	})
}

func (s *Server) handleProjectFavicon(w http.ResponseWriter, r *http.Request) {
	favicon.Serve(w, r)
}

func (s *Server) handleGetAgent(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	agent, err := s.client.GetAgent(id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agent": agent})
}

func (s *Server) handleRead(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	lines, _ := strconv.Atoi(r.URL.Query().Get("lines"))
	text, err := s.client.Read(id, lines)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"text": text})
}

type promptBody struct {
	Text string `json:"text"`
}

func (s *Server) handlePrompt(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body promptBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	body.Text = strings.TrimSpace(body.Text)
	if body.Text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text required"})
		return
	}
	if err := s.client.Prompt(id, body.Text); err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleApprove(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.client.Approve(id); err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleInterrupt(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.client.Interrupt(id); err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type keysBody struct {
	Keys []string `json:"keys"`
}

func (s *Server) handleKeys(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body keysBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if len(body.Keys) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "keys required"})
		return
	}
	if err := s.client.SendKeys(id, body.Keys...); err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
