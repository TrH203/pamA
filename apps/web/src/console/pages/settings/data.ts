// Settings data: response shapes of the server routes these pages use and their query hooks.
// Every page reads through TanStack Query with the shared api client (lib/api.ts).
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api.ts";
import { queries } from "../../../lib/query.ts";

export type Role = "chat" | "small" | "embed";
export const ROLES: readonly Role[] = ["chat", "small", "embed"];
export type Mode = "local" | "selfhost" | "cloud";
export type Gate = "data_leaves" | "reindex" | "unverified";

export interface CheckItem {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}
export interface Check {
  ok: boolean;
  latencyMs: number | null;
  items: CheckItem[];
}

/** GET /v1/models/effective: the model each role uses and where the choice comes from. */
export interface EffectiveRole {
  provider: string;
  /** Registry id (`lmstudio` for an OpenAI-compatible endpoint on its default URL). */
  preset: string;
  model: string;
  base_url: string | null;
  key_set: boolean;
  local: boolean;
  verified: boolean;
  origin: "saved" | "env" | "default";
  scope: "server" | "workspace";
}
export interface Effective {
  strict_offline: boolean;
  roles: Record<Role, EffectiveRole>;
}

/** GET /v1/models/settings: editable view (tenants get `scope` on every role). */
export interface RoleSettings {
  scope?: "server" | "workspace";
  provider: string;
  model: string;
  baseUrl?: string;
  keySet: boolean;
  local: boolean;
  verified: boolean;
  previous?: { provider: string; model: string; baseUrl?: string };
  lastCheck?: Check;
}
export interface ModelSettings {
  strict_offline: boolean;
  roles: Record<Role, RoleSettings>;
}

export type Place = "device" | "server" | "cloud";
export interface Topology {
  mode: Mode;
  baseUrl: string;
  db: string;
  strictOffline: boolean;
  declaredHosts: string[];
  components: {
    id: string;
    name: string;
    what: string;
    movable: boolean;
    current: Place;
    detail: string;
    options: { place: Place; how: string }[];
  }[];
  dataFlow: string[];
}

export interface Device {
  id: string;
  name: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_at: string;
}
export interface PairingCode {
  code: string;
  expires_at: string;
}

export interface SyncTask {
  id: string;
  project_id: string;
  name: string;
  key: string | null;
  /** null: follows the project. */
  sync_enabled: boolean | null;
  branches: string[];
  session_count: number;
  last_activity: string | null;
}
export interface SyncProject {
  id: string;
  name: string;
  repo_key: string;
  sync_enabled: boolean;
  sync_target: string | null;
  bundles: SyncTask[];
}
export interface SyncStatus {
  projects: SyncProject[];
  pending: { digests: number; tombstones: number };
}
export interface Project {
  id: string;
  name: string;
  repo_key: string;
}

export const settingsKeys = {
  topology: ["settings", "topology"] as const,
  effective: ["models", "effective"] as const,
  models: ["models"] as const,
  devices: ["devices"] as const,
  sync: ["sync", "status"] as const,
  projects: ["projects"] as const,
  retention: ["settings", "retention"] as const,
};

export const useMe = () => useQuery(queries.me);
export const useTopology = () =>
  useQuery({
    queryKey: settingsKeys.topology,
    queryFn: () => api<Topology>("/v1/settings/topology"),
  });
export const useEffective = () =>
  useQuery({
    queryKey: settingsKeys.effective,
    queryFn: () => api<Effective>("/v1/models/effective"),
  });
export const useModelSettings = () =>
  useQuery({
    queryKey: settingsKeys.models,
    queryFn: () => api<ModelSettings>("/v1/models/settings"),
  });
export const useDevices = (enabled = true) =>
  useQuery({
    queryKey: settingsKeys.devices,
    queryFn: () => api<{ items: Device[] }>("/v1/devices"),
    enabled,
  });
export const useSyncStatus = (enabled = true) =>
  useQuery({
    queryKey: settingsKeys.sync,
    queryFn: () => api<SyncStatus>("/v1/sync/status"),
    enabled,
  });
export const useProjects = (enabled = true) =>
  useQuery({
    queryKey: settingsKeys.projects,
    queryFn: () => api<{ items: Project[] }>("/v1/projects"),
    enabled,
  });
export const useRetention = () =>
  useQuery({
    queryKey: settingsKeys.retention,
    queryFn: () => api<{ ask_retention_days: number }>("/v1/settings/retention"),
  });

/** A cloud workspace owner: the server marks every role with a scope only for them. */
export const isTenant = (s: ModelSettings | undefined) => s?.roles.small.scope === "server";
