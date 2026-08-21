package herdr

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// Client talks to a running Herder instance via the `herdr` CLI.
type Client struct {
	Bin string
}

func New(bin string) *Client {
	if bin == "" {
		bin = "herdr"
	}
	return &Client{Bin: bin}
}

type Agent struct {
	Agent                 string `json:"agent"`
	AgentStatus           string `json:"agent_status"`
	Cwd                   string `json:"cwd"`
	Focused               bool   `json:"focused"`
	ForegroundCwd         string `json:"foreground_cwd"`
	PaneID                string `json:"pane_id"`
	Revision              int    `json:"revision"`
	StateChangeSeq        int    `json:"state_change_seq"`
	TabID                 string `json:"tab_id"`
	TerminalID            string `json:"terminal_id"`
	TerminalTitle         string `json:"terminal_title"`
	TerminalTitleStripped string `json:"terminal_title_stripped"`
	WorkspaceID           string `json:"workspace_id"`
}

type envelope struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (c *Client) runJSON(args ...string) (json.RawMessage, error) {
	cmd := exec.Command(c.Bin, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		// herdr sometimes still emits JSON on failure
		if raw := extractJSON(stdout.Bytes()); len(raw) > 0 {
			var env envelope
			if json.Unmarshal(raw, &env) == nil && env.Error != nil {
				return nil, fmt.Errorf("%s: %s", env.Error.Code, env.Error.Message)
			}
		}
		return nil, fmt.Errorf("herdr %s: %s", strings.Join(args, " "), msg)
	}
	raw := extractJSON(stdout.Bytes())
	if len(raw) == 0 {
		return nil, fmt.Errorf("herdr %s: empty response", strings.Join(args, " "))
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	if env.Error != nil {
		return nil, fmt.Errorf("%s: %s", env.Error.Code, env.Error.Message)
	}
	return env.Result, nil
}

func extractJSON(b []byte) []byte {
	i := bytes.IndexByte(b, '{')
	if i < 0 {
		return nil
	}
	return b[i:]
}

func (c *Client) ListAgents() ([]Agent, error) {
	res, err := c.runJSON("agent", "list")
	if err != nil {
		return nil, err
	}
	var out struct {
		Agents []Agent `json:"agents"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return nil, err
	}
	return out.Agents, nil
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

// Interrupt sends Escape to the agent pane (works for crabcode / most CLIs).
func (c *Client) Interrupt(target string) error {
	return c.SendKeys(target, "esc")
}

// Approve sends a common approve key chord. Agents differ; Escape+y is not
// universal, so we send "y" as the default approve for blocked prompts.
func (c *Client) Approve(target string) error {
	return c.SendKeys(target, "y")
}
