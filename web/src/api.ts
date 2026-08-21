export type Agent = {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  agent: string;
  agent_status: string;
  focused: boolean;
  cwd: string;
  foreground_cwd?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  last_output_at?: string | null;
};

export type Workspace = {
  workspace_id: string;
  label: string;
  number: number;
  focused: boolean;
  agent_status?: string;
  active_tab_id?: string;
  pane_count?: number;
  tab_count?: number;
};

export type CreateAgentRequest = {
  workspace_id: string;
  kind: string;
  label?: string;
  cwd?: string;
  name?: string;
  focus?: boolean;
};

export type CreateAgentResponse = {
  ok: boolean;
  kind: string;
  pane_id: string;
  terminal_id: string;
  tab_id: string;
  workspace_id: string;
  root_pane?: Agent;
};

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || res.statusText || "request failed");
  }
  return body as T;
}

export async function listAgents(): Promise<Agent[]> {
  const data = await json<{ agents: Agent[] }>("/api/agents");
  return data.agents || [];
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const data = await json<{ workspaces: Workspace[] }>("/api/workspaces");
  return data.workspaces || [];
}

export async function createAgent(
  req: CreateAgentRequest,
): Promise<CreateAgentResponse> {
  return json<CreateAgentResponse>("/api/agents", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function promptAgent(id: string, text: string) {
  return json(`/api/agents/${encodeURIComponent(id)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export async function approveAgent(id: string) {
  return json(`/api/agents/${encodeURIComponent(id)}/approve`, {
    method: "POST",
  });
}

export async function interruptAgent(id: string) {
  return json(`/api/agents/${encodeURIComponent(id)}/interrupt`, {
    method: "POST",
  });
}

export async function sendKeys(id: string, keys: string[]) {
  return json(`/api/agents/${encodeURIComponent(id)}/keys`, {
    method: "POST",
    body: JSON.stringify({ keys }),
  });
}
