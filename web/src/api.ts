export type Agent = {
  agent: string;
  agent_status: string;
  cwd: string;
  focused: boolean;
  foreground_cwd?: string;
  pane_id: string;
  revision?: number;
  tab_id?: string;
  terminal_id?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  workspace_id?: string;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || res.statusText);
  }
  return data as T;
}

export const listAgents = () =>
  req<{ agents: Agent[] }>("/api/agents").then((d) => d.agents);

export const readAgent = (id: string, lines = 120) =>
  req<{ text: string }>(`/api/agents/${encodeURIComponent(id)}/read?lines=${lines}`);

export const promptAgent = (id: string, text: string) =>
  req<{ ok: boolean }>(`/api/agents/${encodeURIComponent(id)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });

export const approveAgent = (id: string) =>
  req<{ ok: boolean }>(`/api/agents/${encodeURIComponent(id)}/approve`, {
    method: "POST",
  });

export const interruptAgent = (id: string) =>
  req<{ ok: boolean }>(`/api/agents/${encodeURIComponent(id)}/interrupt`, {
    method: "POST",
  });

export const sendKeys = (id: string, keys: string[]) =>
  req<{ ok: boolean }>(`/api/agents/${encodeURIComponent(id)}/keys`, {
    method: "POST",
    body: JSON.stringify({ keys }),
  });
