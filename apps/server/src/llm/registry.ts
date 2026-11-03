// Shared model provider registry (spec 005): packages/types/providers.json. The device reads the
// same file (crates/pama-core/src/providers.rs), so provider ids, default endpoints and the
// "runs on this machine" rule are identical on both sides (tests/unit/provider-registry.test.ts).
import registryJson from "@pama/types/providers.json" with { type: "json" };

export type Locality = "local" | "cloud" | "by_host";
/** Wire protocols the server speaks; also the provider ids kept in stored settings. */
export type Protocol = "ollama" | "anthropic" | "openrouter" | "openai-compatible";
type RoleName = "chat" | "small" | "embed";

export interface RegistryProvider {
  id: string;
  label: string;
  protocol: Protocol;
  locality: Locality;
  default_base_url: string | null;
  needs_key: boolean;
  roles: RoleName[];
  suggested: Record<RoleName, string[]>;
}

export interface Registry {
  version: number;
  local_hosts: { exact: string[]; prefixes: string[]; suffixes: string[] };
  providers: RegistryProvider[];
  presets: {
    id: string;
    label: string;
    roles: Partial<Record<RoleName, { provider: string; model: string }>>;
  }[];
}

export const REGISTRY = registryJson as unknown as Registry;

/** Every provider id, in registry order (validation lists). */
export const PROVIDER_IDS = REGISTRY.providers.map((p) => p.id) as [string, ...string[]];

export function getProvider(id: string): RegistryProvider | undefined {
  return REGISTRY.providers.find((p) => p.id === id);
}

/** Is this host on this machine or the LAN? */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  const l = REGISTRY.local_hosts;
  return (
    l.exact.includes(h) ||
    l.prefixes.some((p) => h.startsWith(p)) ||
    l.suffixes.some((s) => h.endsWith(s))
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** True when the model runs on this machine or the LAN. Unknown providers are decided by host. */
export function isLocalProvider(provider: string, baseUrl?: string): boolean {
  if (provider === "fake") return true;
  const p = getProvider(provider);
  switch (p?.locality ?? "by_host") {
    case "local":
      return true;
    case "cloud":
      return false;
    default: {
      const url = baseUrl ?? p?.default_base_url ?? undefined;
      return url ? isLocalHost(hostOf(url)) : false;
    }
  }
}

/**
 * The protocol and endpoint a registry id talks to. `lmstudio` becomes `openai-compatible` with
 * its default endpoint; legacy ids (ollama, anthropic, openrouter, openai-compatible) keep theirs,
 * and their endpoint stays unset so the provider's own default applies.
 */
export function resolveProvider(
  id: string,
  baseUrl?: string,
): { provider: Protocol | string; baseUrl?: string } {
  const p = getProvider(id);
  if (!p) return { provider: id, ...(baseUrl ? { baseUrl } : {}) };
  const legacy = p.id === p.protocol;
  const url = baseUrl ?? (legacy ? undefined : (p.default_base_url ?? undefined));
  return { provider: p.protocol, ...(url ? { baseUrl: url } : {}) };
}

/** The registry entry a stored (provider, baseUrl) pair corresponds to (for display). */
export function presetFor(provider: string, baseUrl?: string): RegistryProvider | undefined {
  const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase();
  if (provider === "openai-compatible" && baseUrl) {
    const hit = REGISTRY.providers.find(
      (p) =>
        p.id !== "openai-compatible" &&
        p.protocol === "openai-compatible" &&
        p.default_base_url !== null &&
        norm(p.default_base_url) === norm(baseUrl),
    );
    if (hit) return hit;
  }
  return getProvider(provider);
}
