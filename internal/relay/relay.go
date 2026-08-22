package relay

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Handler bridges browser xterm ↔ `herdr terminal session control --takeover`.
type Handler struct {
	Herdr string
}

type frameMsg struct {
	Type     string `json:"type"`
	Bytes    string `json:"bytes,omitempty"`
	Encoding string `json:"encoding,omitempty"`
	Full     bool   `json:"full,omitempty"`
	Width    int    `json:"width,omitempty"`
	Height   int    `json:"height,omitempty"`
	Seq      int    `json:"seq,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

type clientMsg struct {
	Type      string `json:"type"`
	Text      string `json:"text,omitempty"`
	Bytes     string `json:"bytes,omitempty"`
	Cols      int    `json:"cols,omitempty"`
	Rows      int    `json:"rows,omitempty"`
	Lines     int    `json:"lines,omitempty"`
	Direction string `json:"direction,omitempty"`
	Source    string `json:"source,omitempty"`
	Column    *int   `json:"column,omitempty"`
	Row       *int   `json:"row,omitempty"`
	Modifiers int    `json:"modifiers,omitempty"`
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	termID := r.URL.Query().Get("id")
	if termID == "" {
		http.Error(w, "id required (terminal_id)", http.StatusBadRequest)
		return
	}
	cols, _ := strconv.Atoi(r.URL.Query().Get("cols"))
	rows, _ := strconv.Atoi(r.URL.Query().Get("rows"))
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}

	bin := h.Herdr
	if bin == "" {
		bin = "herdr"
	}

	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // phone / LAN / Tailscale / tunnel
	})
	if err != nil {
		return
	}
	defer ws.Close(websocket.StatusNormalClosure, "")

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	cmd := exec.CommandContext(ctx, bin,
		"terminal", "session", "control", termID,
		"--takeover",
		"--cols", strconv.Itoa(cols),
		"--rows", strconv.Itoa(rows),
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		_ = ws.Close(websocket.StatusInternalError, err.Error())
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = ws.Close(websocket.StatusInternalError, err.Error())
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = ws.Close(websocket.StatusInternalError, err.Error())
		return
	}
	if err := cmd.Start(); err != nil {
		_ = ws.Close(websocket.StatusInternalError, err.Error())
		return
	}

	var stdinMu sync.Mutex
	writeLine := func(v any) error {
		stdinMu.Lock()
		defer stdinMu.Unlock()
		b, err := json.Marshal(v)
		if err != nil {
			return err
		}
		_, err = stdin.Write(append(b, '\n'))
		return err
	}

	// Frame fan-out: never block the herdr stdout reader on a slow websocket.
	// A busy agent emits frames faster than some clients can drain; the old
	// path did ws.Write with a 5s timeout and cancelled the whole session on
	// timeout → dead/live reconnect flap. Instead keep only the latest frame
	// and drop intermediates under backpressure.
	outFrames := make(chan []byte, 1)
	closedReason := make(chan string, 1)

	go func() {
		defer close(outFrames)
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 256*1024), 4*1024*1024)
		for sc.Scan() {
			var fr frameMsg
			if err := json.Unmarshal(sc.Bytes(), &fr); err != nil {
				continue
			}
			switch fr.Type {
			case "terminal.frame":
				raw, err := base64.StdEncoding.DecodeString(fr.Bytes)
				if err != nil {
					continue
				}
				// Coalesce: if a frame is already queued, replace it.
				select {
				case <-outFrames:
				default:
				}
				select {
				case outFrames <- raw:
				case <-ctx.Done():
					return
				}
			case "terminal.closed":
				msg := fr.Reason
				if msg == "" {
					msg = "closed"
				}
				select {
				case closedReason <- msg:
				default:
				}
				return
			}
		}
		if err := sc.Err(); err != nil && ctx.Err() == nil {
			log.Printf("herdr control stdout: %v", err)
		}
	}()

	go func() {
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			case reason := <-closedReason:
				_ = ws.Close(websocket.StatusNormalClosure, reason)
				return
			case raw, ok := <-outFrames:
				if !ok {
					// herdr stdout ended without an explicit closed frame.
					_ = ws.Close(websocket.StatusNormalClosure, "stream ended")
					return
				}
				// No short timeout: a temporary network stall must not tear down
				// a healthy takeover. Real disconnect cancels ctx via the reader.
				if err := ws.Write(ctx, websocket.MessageBinary, raw); err != nil {
					return
				}
			}
		}
	}()

	go func() {
		b, _ := io.ReadAll(stderr)
		if len(b) > 0 {
			log.Printf("herdr control stderr: %s", string(b))
		}
	}()

	// websocket → herdr
	go func() {
		defer cancel()
		for {
			msgType, data, err := ws.Read(ctx)
			if err != nil {
				return
			}
			switch msgType {
			case websocket.MessageBinary:
				// raw keystrokes / paste
				_ = writeLine(map[string]any{
					"type": "terminal.input",
					"text": string(data),
				})
			case websocket.MessageText:
				var m clientMsg
				if err := json.Unmarshal(data, &m); err != nil {
					// treat as raw text input
					_ = writeLine(map[string]any{
						"type": "terminal.input",
						"text": string(data),
					})
					continue
				}
				switch m.Type {
				case "terminal.input", "input":
					if m.Text != "" {
						_ = writeLine(map[string]any{"type": "terminal.input", "text": m.Text})
					} else if m.Bytes != "" {
						_ = writeLine(map[string]any{
							"type":     "terminal.input",
							"bytes":    m.Bytes,
							"encoding": "base64",
						})
					}
				case "terminal.resize", "resize":
					if m.Cols > 0 && m.Rows > 0 {
						_ = writeLine(map[string]any{
							"type": "terminal.resize",
							"cols": m.Cols,
							"rows": m.Rows,
						})
					}
				case "terminal.scroll", "scroll":
					direction := strings.ToLower(strings.TrimSpace(m.Direction))
					lines := m.Lines
					if direction == "" {
						// Back-compat: signed lines from older UI builds.
						if lines > 0 {
							direction = "down"
						} else if lines < 0 {
							direction = "up"
							lines = -lines
						}
					}
					if lines < 0 {
						lines = -lines
					}
					if direction != "up" && direction != "down" {
						continue
					}
					if lines == 0 {
						lines = 1
					}
					source := strings.ToLower(strings.TrimSpace(m.Source))
					if source == "" {
						source = "wheel"
					}
					payload := map[string]any{
						"type":      "terminal.scroll",
						"direction": direction,
						"lines":     lines,
						"source":    source,
						"modifiers": m.Modifiers,
					}
					if m.Column != nil {
						payload["column"] = *m.Column
					}
					if m.Row != nil {
						payload["row"] = *m.Row
					}
					_ = writeLine(payload)
				case "ping":
					wctx, wcancel := context.WithTimeout(ctx, time.Second)
					_ = ws.Write(wctx, websocket.MessageText, []byte(`{"type":"pong"}`))
					wcancel()
				}
			}
		}
	}()

	<-ctx.Done()
	_ = stdin.Close()
	_ = cmd.Wait()
}
