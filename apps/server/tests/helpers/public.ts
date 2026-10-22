// A browser-like client for the public Ask Link API: keeps the visitor cookie.
import type { TestCtx } from "./ctx.ts";

export function visitor(t: TestCtx, slug: string, ip = "203.0.113.7") {
  let cookie = "";
  return {
    get cookie() {
      return cookie;
    },
    async call(path: string, json?: unknown, method?: string) {
      const res = await t.app.request(`/a/${slug}${path}`, {
        method: method ?? (json === undefined ? "GET" : "POST"),
        headers: {
          "x-forwarded-for": ip,
          ...(cookie ? { cookie } : {}),
          ...(json === undefined ? {} : { "content-type": "application/json" }),
        },
        body: json === undefined ? undefined : JSON.stringify(json),
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0] as string;
      return res;
    },
  };
}
