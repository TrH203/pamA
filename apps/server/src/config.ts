// Server configuration from environment variables (validated). Same image in every mode;
// modes differ only by configuration and storage/queue adapters (Constitution IV).
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const VERSION = "0.1.0";

const ProviderSchema = z.object({
  provider: z.enum(["anthropic", "openai-compatible", "ollama", "fake"]),
  model: z.string().min(1),
  baseUrl: z.url().optional(),
  apiKey: z.string().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderSchema>;

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  PAMA_MODE: z.enum(["local", "selfhost", "cloud"]).default("local"),
  PAMA_PORT: z.coerce.number().int().min(0).max(65535).default(7465),
  PAMA_BIND: z.string().optional(),
  PAMA_DATA_DIR: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  PAMA_BASE_URL: z.url().optional(),
  PAMA_LOCAL_TOKEN: z.string().min(16).optional(),
  /** Signs visitor cookies and salts IP hashes. Local mode persists one in the data dir. */
  PAMA_SECRET: z.string().min(32).optional(),
  /** Bearer token for the owner API on self-host/cloud servers (admin and CLI access). */
  PAMA_OWNER_TOKEN: z.string().min(24).optional(),
  PAMA_STRICT_OFFLINE: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  PAMA_DECLARED_HOSTS: csv,
  PAMA_CHAT_PROVIDER: z.string().default("ollama"),
  PAMA_CHAT_MODEL: z.string().default("qwen3:14b"),
  PAMA_CHAT_BASE_URL: z.url().optional(),
  PAMA_CHAT_API_KEY: z.string().optional(),
  PAMA_SMALL_MODEL: z.string().optional(),
  PAMA_EMBED_PROVIDER: z.string().default("ollama"),
  PAMA_EMBED_MODEL: z.string().default("bge-m3"),
  PAMA_EMBED_BASE_URL: z.url().optional(),
  PAMA_EMBED_API_KEY: z.string().optional(),
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().optional(),
});

export interface Config {
  mode: "local" | "selfhost" | "cloud";
  version: string;
  port: number;
  /** Local mode binds to loopback unless the owner opts into LAN (research R12). */
  bind: string;
  dataDir: string;
  databaseUrl: string | undefined;
  baseUrl: string;
  /** Per-launch owner token in local mode (Constitution I: console only on 127.0.0.1). */
  localToken: string;
  secret: string;
  ownerToken: string | undefined;
  strictOffline: boolean;
  declaredHosts: string[];
  chat: ProviderConfig;
  small: ProviderConfig;
  embed: ProviderConfig;
  smtp: { url: string; from: string } | undefined;
}

/** Local mode: keep one secret in the data dir so visitor cookies survive restarts. */
function persistentSecret(dataDir: string, mode: string): string {
  if (mode !== "local")
    throw new Error("PAMA_SECRET (32+ characters) is required outside local mode");
  const file = join(dataDir, "secret");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    const s = randomBytes(32).toString("base64url");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, s, { mode: 0o600 });
    return s;
  }
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const e = EnvSchema.parse(env);
  if (e.PAMA_MODE !== "local" && !e.DATABASE_URL) {
    throw new Error(`DATABASE_URL is required in ${e.PAMA_MODE} mode`);
  }
  const bind = e.PAMA_BIND ?? (e.PAMA_MODE === "local" ? "127.0.0.1" : "0.0.0.0");
  const chat = ProviderSchema.parse({
    provider: e.PAMA_CHAT_PROVIDER,
    model: e.PAMA_CHAT_MODEL,
    baseUrl: e.PAMA_CHAT_BASE_URL,
    apiKey: e.PAMA_CHAT_API_KEY,
  });
  return {
    mode: e.PAMA_MODE,
    version: VERSION,
    port: e.PAMA_PORT,
    bind,
    dataDir: e.PAMA_DATA_DIR ?? join(homedir(), ".pama", "server"),
    databaseUrl: e.DATABASE_URL,
    baseUrl: e.PAMA_BASE_URL ?? `http://${bind === "0.0.0.0" ? "localhost" : bind}:${e.PAMA_PORT}`,
    localToken: e.PAMA_LOCAL_TOKEN ?? randomBytes(24).toString("base64url"),
    ownerToken: e.PAMA_OWNER_TOKEN,
    secret:
      e.PAMA_SECRET ??
      persistentSecret(e.PAMA_DATA_DIR ?? join(homedir(), ".pama", "server"), e.PAMA_MODE),
    strictOffline: e.PAMA_STRICT_OFFLINE,
    declaredHosts: e.PAMA_DECLARED_HOSTS,
    chat,
    small: { ...chat, model: e.PAMA_SMALL_MODEL ?? chat.model },
    embed: ProviderSchema.parse({
      provider: e.PAMA_EMBED_PROVIDER,
      model: e.PAMA_EMBED_MODEL,
      baseUrl: e.PAMA_EMBED_BASE_URL,
      apiKey: e.PAMA_EMBED_API_KEY,
    }),
    smtp: e.SMTP_URL ? { url: e.SMTP_URL, from: e.SMTP_FROM ?? "pama@localhost" } : undefined,
  };
}

/** Config for tests: local mode, in-memory database, fake models. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      PAMA_MODE: "local",
      PAMA_LOCAL_TOKEN: "test-local-token-0123456789",
      PAMA_SECRET: "test-secret-0123456789-0123456789-abcdef",
      PAMA_OWNER_TOKEN: "test-owner-token-0123456789-abcdef",
      PAMA_CHAT_PROVIDER: "fake",
      PAMA_CHAT_MODEL: "fake",
      PAMA_EMBED_PROVIDER: "fake",
      PAMA_EMBED_MODEL: "fake",
    }),
    ...overrides,
  };
}
