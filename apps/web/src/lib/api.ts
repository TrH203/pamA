// Owner API client. In local mode the console gets the per-launch token from the URL fragment
// (`#token=…`, opened by the desktop app or `pama console`) and trades it for an httpOnly cookie so
// later tabs and reloads need no token; it is also kept for this tab as a fallback.
const KEY = "pama.token";

export function token(): string | null {
  const m = /[#&]token=([^&]+)/.exec(window.location.hash);
  if (m?.[1]) {
    try {
      sessionStorage.setItem(KEY, decodeURIComponent(m[1]));
    } catch {
      /* storage unavailable: keep using the fragment */
    }
    history.replaceState(null, "", window.location.pathname + window.location.search);
    return decodeURIComponent(m[1]);
  }
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

let exchanged: Promise<unknown> | null = null;

/** Trade a fragment token for the session cookie (once per page load). */
function exchange(): Promise<unknown> {
  const t = token();
  if (!t) return Promise.resolve();
  exchanged ??= fetch("/v1/auth/local-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: t }),
  }).catch(() => undefined);
  return exchanged;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; json?: unknown } = {},
): Promise<T> {
  await exchange();
  const t = token();
  const res = await fetch(path, {
    method: init.method ?? (init.json === undefined ? "GET" : "POST"),
    headers: {
      ...(t ? { authorization: `Bearer ${t}` } : {}),
      ...(init.json === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (body as { error?: { code: string; message: string } }).error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? res.statusText, body);
  }
  return body as T;
}
