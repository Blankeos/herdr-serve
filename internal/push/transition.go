package push

// Transition logic for agent-completion push notifications.
//
// Pure functions (no I/O) so they are unit-testable in isolation.
// Semantics are intentionally narrow to avoid noise and leaks:
//
//   - Notify only on working -> {done, idle, blocked}.
//     "blocked" means the agent needs attention (approval / question).
//   - First observation of an agent baselines it: no notification.
//     This prevents an "initial flood" for agents that are already done
//     when the server (re)starts or when a new agent appears already done.
//   - Removed agents are pruned from tracking state, never notified.
//   - Statuses are normalized (trim + lowercase); "" degrades to "unknown"
//     which never notifies.
//   - Payloads carry only metadata (kind, title, workspace, status, ids).
//     Prompt text and terminal output are NEVER included.
import (
	"net/url"
	"strings"

	"github.com/Blankeos/herdr-serve/internal/herdr"
)

// NotifyTargetStatuses are the statuses that complete a "working" run.
var NotifyTargetStatuses = map[string]bool{
	"done":    true,
	"idle":    true,
	"blocked": true,
}

// NormalizeStatus canonicalizes a free-form herdr agent_status.
func NormalizeStatus(s string) string {
	n := strings.TrimSpace(strings.ToLower(s))
	if n == "" {
		return "unknown"
	}
	return n
}

// ShouldNotify reports whether a prev -> curr transition should push.
func ShouldNotify(prevStatus, currStatus string) bool {
	prev := NormalizeStatus(prevStatus)
	curr := NormalizeStatus(currStatus)
	if prev != "working" {
		return false
	}
	if prev == curr {
		return false
	}
	return NotifyTargetStatuses[curr]
}

// AgentKey is the stable tracking key for an agent pane.
// pane_id is stable across reconnects; terminal_id is the UI selection id.
func AgentKey(a herdr.Agent) string {
	if strings.TrimSpace(a.PaneID) != "" {
		return strings.TrimSpace(a.PaneID)
	}
	return strings.TrimSpace(a.TerminalID)
}

// DeepLinkID is the id the web UI uses to select/focus an agent
// (terminal_id preferred, pane_id fallback — mirrors App.tsx selection).
func DeepLinkID(a herdr.Agent) string {
	if strings.TrimSpace(a.TerminalID) != "" {
		return strings.TrimSpace(a.TerminalID)
	}
	return strings.TrimSpace(a.PaneID)
}

// DisplayTitle returns a short human label for an agent without any
// sensitive content (no prompt text, no terminal output).
func DisplayTitle(a herdr.Agent) string {
	t := strings.TrimSpace(a.TerminalTitleStripped)
	if t == "" {
		t = strings.TrimSpace(a.Agent)
	}
	if t == "" {
		if id := AgentKey(a); len(id) > 8 {
			t = id[:8]
		} else if id != "" {
			t = id
		} else {
			t = "agent"
		}
	}
	const max = 80
	if len(t) > max {
		t = t[:max-1] + "…"
	}
	return t
}

// NotificationEvent is a single working -> terminal transition.
type NotificationEvent struct {
	Key         string // tracking key (pane_id)
	PaneID      string
	TerminalID  string
	AgentID     string // deep-link id (terminal_id || pane_id)
	Kind        string // agent kind, e.g. "crabcode"
	Title       string // display title (metadata only)
	WorkspaceID string
	PrevStatus  string // normalized
	CurrStatus  string // normalized
}

// DetectTransitions diffs previously-seen statuses against the current
// snapshot. prev maps AgentKey -> normalized status. A nil prev map means
// "first poll ever": everything is baselined, no events (no initial flood).
//
// Returns the events to notify plus the next tracking map.
func DetectTransitions(prev map[string]string, curr []herdr.Agent) ([]NotificationEvent, map[string]string) {
	next := make(map[string]string, len(curr))
	var events []NotificationEvent
	if prev == nil {
		for _, a := range curr {
			if k := AgentKey(a); k != "" {
				next[k] = NormalizeStatus(a.AgentStatus)
			}
		}
		return nil, next
	}
	for _, a := range curr {
		k := AgentKey(a)
		if k == "" {
			continue
		}
		cur := NormalizeStatus(a.AgentStatus)
		next[k] = cur
		prevStatus, seen := prev[k]
		if !seen {
			// New agent since last poll: baseline, never notify.
			continue
		}
		if ShouldNotify(prevStatus, cur) {
			kind := strings.TrimSpace(a.Agent)
			if kind == "" {
				kind = "agent"
			}
			events = append(events, NotificationEvent{
				Key:         k,
				PaneID:      strings.TrimSpace(a.PaneID),
				TerminalID:  strings.TrimSpace(a.TerminalID),
				AgentID:     DeepLinkID(a),
				Kind:        kind,
				Title:       DisplayTitle(a),
				WorkspaceID: strings.TrimSpace(a.WorkspaceID),
				PrevStatus:  NormalizeStatus(prevStatus),
				CurrStatus:  cur,
			})
		}
	}
	// Agents absent from curr are dropped (pruned) by construction.
	return events, next
}

// PushPayload is the encrypted JSON delivered to the service worker.
// Metadata only — never prompt text or terminal output.
type PushPayload struct {
	Title      string `json:"title"`
	Body       string `json:"body"`
	AgentID    string `json:"agentId"`
	PaneID     string `json:"paneId,omitempty"`
	TerminalID string `json:"terminalId,omitempty"`
	Status     string `json:"status"`
	Kind       string `json:"kind,omitempty"`
	Workspace  string `json:"workspace,omitempty"`
	URL        string `json:"url"` // deep link, e.g. "/?agent=<id>"
}

// BuildPushMessage renders a NotificationEvent into a PushPayload.
// workspaceLabel is the human workspace name (may be "").
func BuildPushMessage(ev NotificationEvent, workspaceLabel string) PushPayload {
	var title, verb string
	switch ev.CurrStatus {
	case "blocked":
		title = "Agent needs attention"
		verb = "needs attention"
	case "idle":
		title = "Agent idle"
		verb = "is now idle"
	default: // "done"
		title = "Agent finished"
		verb = "finished"
	}
	workspaceLabel = strings.TrimSpace(workspaceLabel)
	name := ev.Title
	if name == "" {
		name = ev.Kind
	}
	var body string
	if workspaceLabel != "" {
		body = ev.Kind + " · " + name + " " + verb + " (" + workspaceLabel + "). Tap to open."
	} else {
		body = ev.Kind + " · " + name + " " + verb + ". Tap to open."
	}
	const maxBody = 160
	if len(body) > maxBody {
		body = body[:maxBody-1] + "…"
	}
	agentID := ev.AgentID
	if agentID == "" {
		agentID = ev.Key
	}
	return PushPayload{
		Title:      title,
		Body:       body,
		AgentID:    agentID,
		PaneID:     ev.PaneID,
		TerminalID: ev.TerminalID,
		Status:     ev.CurrStatus,
		Kind:       ev.Kind,
		Workspace:  workspaceLabel,
		URL:        "/?agent=" + url.QueryEscape(agentID),
	}
}
