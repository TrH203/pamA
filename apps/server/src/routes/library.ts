// Library (spec 007): sessions, digest versions and search across the owner's work. Owner routes.
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.ts";
import { HttpError } from "../http.ts";
import {
  DIGEST_STATUSES,
  deleteSession,
  getSession,
  listDigests,
  listSessions,
  page,
  SESSION_STATUSES,
  searchLibrary,
} from "../services/library.ts";

function query<S extends z.ZodType>(raw: Record<string, string>, schema: S): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(422, "invalid_request", r.error.message);
  return r.data;
}

const SessionQuery = z.object({
  project: z.string().min(1).max(64).optional(),
  bundle: z.string().min(1).max(64).optional(),
  agent: z.string().min(1).max(40).optional(),
  status: z.enum(SESSION_STATUSES).optional(),
});

const DigestQuery = z.object({
  status: z.enum(DIGEST_STATUSES).optional(),
  project: z.string().min(1).max(64).optional(),
  bundle: z.string().min(1).max(64).optional(),
});

export const libraryRoutes = new Hono<Env>()
  .get("/sessions", async (c) => {
    const raw = c.req.query();
    const f = query(raw, SessionQuery);
    return c.json(await listSessions(c.get("deps"), f, page(raw)));
  })
  .get("/sessions/:id", async (c) => c.json(await getSession(c.get("deps"), c.req.param("id"))))
  .delete("/sessions/:id", async (c) =>
    c.json(await deleteSession(c.get("deps"), c.req.param("id"))),
  )
  .get("/digests", async (c) => {
    const raw = c.req.query();
    const f = query(raw, DigestQuery);
    return c.json(await listDigests(c.get("deps"), f, page(raw)));
  })
  .get("/search", async (c) => {
    const q = c.req.query("q") ?? "";
    if (q.length > 500) throw new HttpError(422, "invalid_request", "q is too long");
    const limit = page({ limit: c.req.query("limit") ?? "20" }).limit;
    return c.json(await searchLibrary(c.get("deps"), q, limit));
  });
