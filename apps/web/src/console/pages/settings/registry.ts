// The shared provider registry (packages/types/providers.json, spec 005): the same ids, default
// endpoints and suggested models the server and the CLI use.
import registryJson from "@pama/types/providers.json";
import type { Role } from "./data.ts";

export interface RegistryProvider {
  id: string;
  label: string;
  protocol: string;
  locality: "local" | "cloud" | "by_host";
  default_base_url: string | null;
  needs_key: boolean;
  roles: Role[];
  suggested: Record<Role, string[]>;
}

export const PROVIDERS = (registryJson as unknown as { providers: RegistryProvider[] }).providers;

export function providerById(id: string): RegistryProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Providers that serve this role; a cloud workspace cannot use one on the owner's machine. */
export function providersFor(role: Role, tenant: boolean): RegistryProvider[] {
  return PROVIDERS.filter((p) => p.roles.includes(role) && !(tenant && p.locality === "local"));
}

export function providerLabel(id: string): string {
  return providerById(id)?.label ?? id;
}
