// Public Ask Link API client (same origin, visitor cookie scoped to /a/<slug>).
export const slug = window.location.pathname.split("/")[2] ?? "";
const base = `/a/${slug}/api`;

export interface Meta {
  owner: string;
  title: string;
  access_mode: "open" | "pin" | "email_otp" | "allowlist";
  detail: string;
  coverage: {
    bundle: string;
    project: string;
    sessions: number;
    from: string | null;
    to: string | null;
  }[];
  suggested_questions: string[];
  expires_at: string;
  footer: boolean;
}

export interface Ask {
  id: string;
  question: string;
  status: "answered" | "refused" | "forwarded" | "owner_answered" | "dismissed" | "pending";
  reason?: string | null;
  answer?: string | null;
  citations?: { item_id: string; label: string }[];
  owner_reply?: string | null;
  useful?: boolean | null;
  language?: string;
}

export class PublicError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly access?: string,
  ) {
    super(code);
  }
}

async function call<T>(path: string, json?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: json === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers: json === undefined ? {} : { "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  } catch {
    throw new PublicError(0, "offline");
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = (body as { error?: { code?: string } }).error?.code ?? "error";
    throw new PublicError(res.status, code, res.headers.get("x-pama-access") ?? undefined);
  }
  return body as T;
}

export const api = {
  meta: () => call<Meta>("/meta"),
  access: (b: { pin?: string; email?: string; otp?: string }) => call<void>("/access", b),
  ask: (question: string) =>
    call<{
      ask_id: string;
      status: "answered" | "refused";
      answer?: string;
      reason?: string;
      citations: Ask["citations"];
      language: string;
    }>("/ask", { question }),
  asks: () => call<{ items: Ask[] }>("/asks"),
  forward: (id: string) => call<{ status: string }>(`/asks/${id}/forward`, {}),
  feedback: (id: string, useful: boolean) => call<void>(`/asks/${id}/feedback`, { useful }),
};
