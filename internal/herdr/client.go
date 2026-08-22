package herdr

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

type Client struct {
	Bin string
}

func New(bin ...string) *Client {
	b := "herdr"
	if len(bin) > 0 && strings.TrimSpace(bin[0]) != "" {
		b = strings.TrimSpace(bin[0])
	}
	return &Client{Bin: b}
}

type Agent struct {
	PaneID                string `json:"pane_id"`
	TerminalID            string `json:"terminal_id"`
	WorkspaceID           string `json:"workspace_id"`
	TabID                 string `json:"tab_id"`
	Agent                 string `json:"agent"`
	AgentStatus           string `json:"agent_status"`
	Focused               bool   `json:"focused"`
	Cwd                   string `json:"cwd"`
	ForegroundCwd         string `json:"foreground_cwd"`
	TerminalTitle         string `json:"terminal_title"`
	TerminalTitleStripped string `json:"terminal_title_stripped"`
	LastOutputAt          any    `json:"last_output_at"`
}

type Workspace struct {
	WorkspaceID string `json:"workspace_id"`
	Label       string `json:"label"`
	Number      int    `json:"number"`
	Focused     bool   `json:"focused"`
	AgentStatus string `json:"agent_status"`
	ActiveTabID string `json:"active_tab_id"`
	PaneCount   int    `json:"pane_count"`
	TabCount    int    `json:"tab_count"`
}

type TabCreated struct {
	RootPane Agent `json:"root_pane"`
	Tab      struct {
		TabID       string `json:"tab_id"`
		WorkspaceID string `json:"workspace_id"`
		Label       string `json:"label"`
		Number      int    `json:"number"`
	} `json:"tab"`
}

func (c *Client) run(args ...string) (stdout []byte, err error) {
	cmd := exec.Command(c.Bin, args...)
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = strings.TrimSpace(out.String())
		}
		if msg == "" {
			msg = err.Error()
		}
		return out.Bytes(), fmt.Errorf("herdr %s: %s", strings.Join(args, " "), msg)
	}
	return out.Bytes(), nil
}

func (c *Client) runJSON(args ...string) (json.RawMessage, error) {
	stdout, err := c.run(args...)
	if err != nil {
		return nil, err
	}
	raw := extractJSON(stdout)
	if raw == nil {
		return nil, fmt.Errorf("herdr %s: no JSON in output", strings.Join(args, " "))
	}
	var envelope struct {
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	if len(envelope.Result) == 0 {
		return raw, nil
	}
	return envelope.Result, nil
}

func extractJSON(b []byte) []byte {
	i := bytes.IndexByte(b, '{')
	if i < 0 {
		return nil
	}
	return b[i:]
}

// Snapshot is the cheap one-shot status read. Prefer this over separate
// agent/workspace list execs — one daemon round-trip instead of two.
func (c *Client) Snapshot() (agents []Agent, workspaces []Workspace, err error) {
	res, err := c.runJSON("api", "snapshot")
	if err != nil {
		return nil, nil, err
	}
	var out struct {
		Snapshot struct {
			Agents     []Agent     `json:"agents"`
			Workspaces []Workspace `json:"workspaces"`
		} `json:"snapshot"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return nil, nil, err
	}
	return out.Snapshot.Agents, out.Snapshot.Workspaces, nil
}

func (c *Client) ListAgents() ([]Agent, error) {
	agents, _, err := c.Snapshot()
	return agents, err
}

func (c *Client) ListWorkspaces() ([]Workspace, error) {
	_, workspaces, err := c.Snapshot()
	return workspaces, err
}

func (c *Client) GetAgent(target string) (*Agent, error) {
	res, err := c.runJSON("agent", "get", target)
	if err != nil {
		return nil, err
	}
	var out struct {
		Agent Agent `json:"agent"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return nil, err
	}
	return &out.Agent, nil
}

// CreateTab creates a new tab (shell pane) in a workspace.
func (c *Client) CreateTab(workspaceID, cwd, label string, focus bool) (*TabCreated, error) {
	args := []string{"tab", "create", "--workspace", workspaceID}
	if cwd != "" {
		args = append(args, "--cwd", cwd)
	}
	if label != "" {
		args = append(args, "--label", label)
	}
	if focus {
		args = append(args, "--focus")
	} else {
		args = append(args, "--no-focus")
	}
	res, err := c.runJSON(args...)
	if err != nil {
		return nil, err
	}
	var out TabCreated
	if err := json.Unmarshal(res, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// PaneRun runs a command in an existing pane (e.g. crabcode).
// Some herdr builds exit 0 with empty stdout on success — treat that as OK.
func (c *Client) PaneRun(paneID string, command ...string) error {
	if paneID == "" || len(command) == 0 {
		return fmt.Errorf("pane run requires pane id and command")
	}
	args := append([]string{"pane", "run", paneID}, command...)
	_, err := c.run(args...)
	return err
}

// AgentStart starts a supported agent kind in an existing shell pane.
func (c *Client) AgentStart(name, kind, paneID string) error {
	if name == "" {
		name = kind
	}
	_, err := c.runJSON("agent", "start", name, "--kind", kind, "--pane", paneID)
	return err
}

// Read returns recent terminal text for an agent pane.
func (c *Client) Read(target string, lines int) (string, error) {
	if lines <= 0 {
		lines = 80
	}
	cmd := exec.Command(c.Bin, "agent", "read", target,
		"--source", "recent",
		"--lines", fmt.Sprintf("%d", lines),
		"--format", "ansi",
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("herdr agent read: %s", msg)
	}
	return stdout.String(), nil
}

func (c *Client) Prompt(target, text string) error {
	_, err := c.runJSON("agent", "prompt", target, text)
	return err
}

func (c *Client) SendKeys(target string, keys ...string) error {
	args := append([]string{"agent", "send-keys", target}, keys...)
	_, err := c.runJSON(args...)
	return err
}

func (c *Client) Interrupt(target string) error {
	return c.SendKeys(target, "esc")
}

func (c *Client) Approve(target string) error {
	return c.SendKeys(target, "y")
}
