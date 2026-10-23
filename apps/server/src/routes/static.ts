// Serves the built web app (apps/web/dist): the Ask Link page at /a/:slug, the owner console at
// / (and /console), and the desktop popup at /desktop. Expired/revoked links get a bare 410 page.
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { HttpError } from "../http.ts";
import { resolveLink } from "../policy/resolve-link.ts";

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
};

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#fafaf9;color:#1c1917;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:28rem;text-align:center}h1{font-size:1.25rem}p{color:#57534e}</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

export function staticRoutes(webDir: string) {
  const r = new Hono<Env>();
  const file = (name: string) => {
    const p = join(webDir, name);
    return existsSync(p) ? readFileSync(p) : null;
  };
  const html = (name: string) => file(name)?.toString("utf8") ?? null;
  const security = {
    "content-security-policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };

  r.get("/assets/*", (c) => {
    const rel = normalize(c.req.path.replace(/^\/+/, ""));
    if (rel.startsWith("..")) return c.notFound();
    const body = file(rel);
    if (!body) return c.notFound();
    return c.body(body, 200, {
      "content-type": TYPES[extname(rel)] ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  r.get("/a/:slug", async (c) => {
    try {
      await resolveLink(c.get("deps").db, c.req.param("slug"));
    } catch (e) {
      if (e instanceof HttpError && e.status === 410) {
        return c.html(
          page("This link is no longer active", "Ask the person who shared it for a new link."),
          410,
          security,
        );
      }
      if (e instanceof HttpError && e.status === 404) {
        return c.html(
          page("Link not found", "Check the address, or ask for a new link."),
          404,
          security,
        );
      }
      throw e;
    }
    const doc = html("ask.html");
    if (!doc) return c.text("web app not built (pnpm --filter @pama/web build)", 503);
    return c.html(doc, 200, {
      ...security,
      "x-robots-tag": "noindex",
      "cache-control": "no-store",
    });
  });

  for (const [path, name] of [
    ["/", "console.html"],
    ["/console", "console.html"],
    ["/desktop", "desktop.html"],
  ] as const) {
    r.get(path, (c) => {
      const doc = html(name);
      return doc
        ? c.html(doc, 200, security)
        : c.text("web app not built (pnpm --filter @pama/web build)", 503);
    });
  }
  return r;
}

export const DEFAULT_WEB_DIR = join(import.meta.dirname, "../../../web/dist");
