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

	"github.com/carlo/herdr-serve/internal/herdr"
	"github.com/carlo/herdr-serve/internal/relay"
	"github.com/carlo/herdr-serve/web"
)

type Server struct {
	client *herdr.Client
	herdr  string
	mux    *http.ServeMux
}

func New(client *herdr.Client) *Server {
	bin := "herdr"
	if client != nil && client.Bin != "" {
		bin = client.Bin
	}
	s := &Server{client: client, herdr: bin, mux: http.NewServeMux()}
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
	s.mux.HandleFunc("GET /api/agents", s.handleListAgents)
	s.mux.HandleFunc("POST /api/agents", s.handleCreateAgent)
	s.mux.HandleFunc("GET /api/agents/{id}", s.handleGetAgent)
	s.mux.HandleFunc("GET /api/agents/{id}/read", s.handleRead)
	s.mux.HandleFunc("POST /api/agents/{id}/prompt", s.handlePrompt)
	s.mux.HandleFunc("POST /api/agents/{id}/approve", s.handleApprove)
	s.mux.HandleFunc("POST /api/agents/{id}/interrupt", s.handleInterrupt)
	s.mux.HandleFunc("POST /api/agents/{id}/keys", s.handleKeys)
	s.mux.HandleFunc("GET /api/workspaces", s.handleListWorkspaces)
	s.mux.HandleFunc("GET /api/stream", s.handleStream)
	s.mux.Handle("/ws/term", &relay.Handler{Herdr: s.herdr})

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

func spa(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
	})
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
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

func (s *Server) handleListAgents(w http.ResponseWriter, r *http.Request) {
	agents, err := s.client.ListAgents()
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agents": agents})
}

func (s *Server) handleListWorkspaces(w http.ResponseWriter, r *http.Request) {
	workspaces, err := s.client.ListWorkspaces()
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspaces": workspaces})
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
		"ok":          true,
		"kind":        body.Kind,
		"pane_id":     paneID,
		"terminal_id": created.RootPane.TerminalID,
		"tab_id":      created.Tab.TabID,
		"workspace_id": body.WorkspaceID,
		"root_pane":   created.RootPane,
	})
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

// handleStream is a simple SSE poll of agent list + selected pane text.
// Query: ?target=wW:p1&lines=120&interval_ms=800
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unsupported", http.StatusInternalServerError)
		return
	}
	target := r.URL.Query().Get("target")
	lines, _ := strconv.Atoi(r.URL.Query().Get("lines"))
	if lines <= 0 {
		lines = 120
	}
	intervalMs, _ := strconv.Atoi(r.URL.Query().Get("interval_ms"))
	if intervalMs < 300 {
		intervalMs = 800
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher.Flush()

	ticker := time.NewTicker(time.Duration(intervalMs) * time.Millisecond)
	defer ticker.Stop()

	var mu sync.Mutex
	send := func(event string, v any) {
		mu.Lock()
		defer mu.Unlock()
		b, _ := json.Marshal(v)
		_, _ = w.Write([]byte("event: " + event + "\ndata: "))
		_, _ = w.Write(b)
		_, _ = w.Write([]byte("\n\n"))
		flusher.Flush()
	}

	push := func() {
		agents, err := s.client.ListAgents()
		if err != nil {
			send("error", map[string]string{"error": err.Error()})
			return
		}
		send("agents", map[string]any{"agents": agents})
		if target != "" {
			text, err := s.client.Read(target, lines)
			if err != nil {
				send("error", map[string]string{"error": err.Error()})
				return
			}
			send("read", map[string]any{"target": target, "text": text})
		}
	}

	push()
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Allow client to switch target via ? — re-read query each tick is overkill;
			// they reconnect. Keep it simple.
			push()
		}
	}
}

