import type { Agent } from "./api";

const STORAGE_KEY = "herdr_serve_selected_terminal";

export function loadSelectedTerminal(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function saveSelectedTerminal(id: string): void {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage may be disabled or full; selection still works in memory.
  }
}

/** undefined = still loading, null = no agent available. */
export function resolveInitialTerminal(
  agents: Agent[] | null,
  panes: Agent[] | null,
  remembered: string,
): Agent | null | undefined {
  const matches = (a: Agent) =>
    a.terminal_id === remembered || a.pane_id === remembered;
  if (remembered) {
    const match = agents?.find(matches) || panes?.find(matches);
    if (match) return match;
    // A saved shell is not in the agent list. Don't fall back until both
    // requests succeed, regardless of which response arrives first.
    if (agents === null || panes === null) return undefined;
  }
  if (agents === null) return undefined;
  return agents.find((a) => a.focused) || agents[0] || null;
}
