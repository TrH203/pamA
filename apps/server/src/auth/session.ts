// Owner sign-in sessions for server modes (email magic link, US5). Until then no session exists.
import type { Context } from "hono";
import type { Env } from "../app.ts";

export async function ownerFromSession(_c: Context<Env>): Promise<boolean> {
  return false;
}
