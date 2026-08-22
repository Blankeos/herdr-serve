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
  /** Optional project directory when provided by the backend. */
  cwd?: string;
  path?: string;
};

const TOKEN_KEY = "herdr_serve_token";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export function clearToken() {
  setToken("");
}

export function projectFaviconUrl(cwd: string): string {
  const q = new URLSearchParams({ cwd });
  const token = getToken();
  if (token) q.set("token", token);
  return `/api/project-favicon?${q}`;
}

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
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    ...init,
    headers,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || res.statusText || "request failed");
  }
  return body as T;
}

export async function authStatus(): Promise<{ required: boolean }> {
  return json<{ required: boolean }>("/api/auth/status");
}

export async function authLogin(
  password: string,
): Promise<{ ok: boolean; token: string }> {
  return json<{ ok: boolean; token: string }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
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
