// Owner API client. In local mode the console gets the per-launch token from the URL fragment
// (`#token=…`, opened by the desktop app or `pama console`) and keeps it for this tab only.
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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; json?: unknown } = {},
): Promise<T> {
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
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? res.statusText);
  }
  return body as T;
}
