package push

import (
	"strings"
	"testing"

	"github.com/Blankeos/herdr-serve/internal/herdr"
)

func TestNormalizeStatus(t *testing.T) {
	cases := map[string]string{
		"working": "working",
		"Working": "working",
		" DONE ":  "done",
		"":        "unknown",
		"   ":     "unknown",
		"BLOCKED": "blocked",
		"weird-x": "weird-x",
	}
	for in, want := range cases {
		if got := NormalizeStatus(in); got != want {
			t.Errorf("NormalizeStatus(%q)=%q want %q", in, got, want)
		}
	}
}

func TestShouldNotify(t *testing.T) {
	notify := []string{"done", "idle", "blocked", " DONE ", "Blocked"}
	for _, curr := range notify {
		if !ShouldNotify("working", curr) {
			t.Errorf("ShouldNotify(working -> %q) = false, want true", curr)
		}
	}
	noNotify := []struct{ prev, curr string }{
		{"working", "working"},
		{"working", "WORKING"},
		{"working", "unknown"},
		{"working", ""},
		{"working", "weird"},
		{"idle", "done"},
		{"blocked", "done"},
		{"done", "done"},
		{"", "done"},
		{"unknown", "done"},
		{"idle", "blocked"},
	}
	for _, c := range noNotify {
		if ShouldNotify(c.prev, c.curr) {
			t.Errorf("ShouldNotify(%q -> %q) = true, want false", c.prev, c.curr)
		}
	}
}

func mkAgent(pane, term, status string) herdr.Agent {
	return herdr.Agent{
		PaneID:                pane,
		TerminalID:            term,
		WorkspaceID:           "w1",
		Agent:                 "crabcode",
		AgentStatus:           status,
		TerminalTitleStripped: "demo task",
	}
}

func TestDetectTransitionsNoInitialFlood(t *testing.T) {
	curr := []herdr.Agent{
		mkAgent("w1:p1", "term1", "done"),
		mkAgent("w1:p2", "term2", "blocked"),
		mkAgent("w1:p3", "term3", "working"),
	}
	events, next := DetectTransitions(nil, curr)
	if len(events) != 0 {
		t.Fatalf("first poll (nil prev) must not notify, got %d events", len(events))
	}
	if len(next) != 3 {
		t.Fatalf("next map should track 3 agents, got %d", len(next))
	}
	// A brand-new agent appearing already done must not notify either.
	events, next = DetectTransitions(next, append(curr, mkAgent("w1:p9", "term9", "done")))
	if len(events) != 0 {
		t.Fatalf("new already-done agent must not notify, got %+v", events)
	}
}

func TestDetectTransitionsWorkingToDone(t *testing.T) {
	prev := map[string]string{"w1:p1": "working", "w1:p2": "working"}
	curr := []herdr.Agent{
		mkAgent("w1:p1", "term1", "done"),
		mkAgent("w1:p2", "term2", "working"),
	}
	events, next := DetectTransitions(prev, curr)
	if len(events) != 1 {
		t.Fatalf("want 1 event, got %d", len(events))
	}
	ev := events[0]
	if ev.Key != "w1:p1" || ev.CurrStatus != "done" || ev.PrevStatus != "working" {
		t.Errorf("unexpected event %+v", ev)
	}
	if ev.AgentID != "term1" {
		t.Errorf("AgentID should prefer terminal_id, got %q", ev.AgentID)
	}
	if next["w1:p1"] != "done" || next["w1:p2"] != "working" {
		t.Errorf("next map not updated: %+v", next)
	}
	// Second diff with no change must be silent (no repeat).
	events, _ = DetectTransitions(next, curr)
	if len(events) != 0 {
		t.Errorf("stable snapshot must not re-notify, got %+v", events)
	}
}

func TestDetectTransitionsWorkingToBlockedAndIdle(t *testing.T) {
	prev := map[string]string{"w1:p1": "working", "w1:p2": "working", "w1:p3": "working"}
	curr := []herdr.Agent{
		mkAgent("w1:p1", "term1", "blocked"),
		mkAgent("w1:p2", "term2", "idle"),
		mkAgent("w1:p3", "term3", "WORKING"),
	}
	events, _ := DetectTransitions(prev, curr)
	if len(events) != 2 {
		t.Fatalf("want 2 events (blocked+idle), got %d: %+v", len(events), events)
	}
}

func TestDetectTransitionsPrunesRemoved(t *testing.T) {
	prev := map[string]string{"w1:p1": "working", "w1:pX": "working"}
	curr := []herdr.Agent{mkAgent("w1:p1", "term1", "done")}
	events, next := DetectTransitions(prev, curr)
	if len(events) != 1 {
		t.Fatalf("want 1 event, got %d", len(events))
	}
	if _, ok := next["w1:pX"]; ok {
		t.Errorf("removed agent should be pruned, next=%+v", next)
	}
}

func TestBuildPushMessageNoSensitiveContent(t *testing.T) {
	ev := NotificationEvent{
		Key: "w1:p1", PaneID: "w1:p1", TerminalID: "term1", AgentID: "term1",
		Kind: "crabcode", Title: "my project task", WorkspaceID: "w1",
		PrevStatus: "working", CurrStatus: "done",
	}
	msg := BuildPushMessage(ev, "my-workspace")
	if msg.Title == "" || msg.Body == "" {
		t.Fatal("title/body must be non-empty")
	}
	if msg.URL != "/?agent=term1" {
		t.Errorf("deep link URL wrong: %q", msg.URL)
	}
	// Metadata only: kind/title/workspace/status may appear, but a prompt
	// body must never be smuggled through these fields by construction.
	for _, secret := range []string{"sk-ant-", "super secret prompt", "BEGIN PRIVATE KEY"} {
		if strings.Contains(msg.Title+msg.Body, secret) {
			t.Errorf("payload leaked secret %q", secret)
		}
	}
	if !strings.Contains(msg.Body, "my-workspace") {
		t.Errorf("body should mention workspace, got %q", msg.Body)
	}
	// Blocked title signals attention.
	ev.CurrStatus = "blocked"
	msg = BuildPushMessage(ev, "")
	if msg.Title != "Agent needs attention" {
		t.Errorf("blocked title = %q", msg.Title)
	}
}

func TestBuildPushMessageURLEscapes(t *testing.T) {
	ev := NotificationEvent{Key: "w1:p 1", AgentID: "term 1/2", Kind: "claude", Title: "t", CurrStatus: "idle"}
	msg := BuildPushMessage(ev, "")
	if msg.URL != "/?agent=term+1%2F2" {
		t.Errorf("URL not escaped: %q", msg.URL)
	}
}
