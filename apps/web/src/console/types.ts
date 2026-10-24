export interface Decision {
  id: number;
  what: string;
  why: string;
  alternatives?: string[];
  labels?: string[];
}

export interface DigestContent {
  goal: string;
  decisions: Decision[];
  outcome: string;
  open_items: string[];
  modules: string[];
  redactions: { secret: number; pii: number; by_rule?: Record<string, number> };
  source: { agent: string; bundle_key?: string; ended_at: string };
}

export interface Draft {
  id: string;
  version: number;
  status: string;
  created_at: string;
  project: string;
  project_id: string;
  bundle: string;
  bundle_id: string;
  /** Device that drafted it (thin client, spec 004). */
  device?: string | null;
  content: DigestContent;
}

export interface Bundle {
  id: string;
  name: string;
  name_source: "key" | "suggested" | "owner";
  key: string | null;
  project: string;
  project_id: string;
  /** Distinct branches over the member sessions, earliest first-seen first. */
  branches: string[];
  session_count: number;
  last_activity: string | null;
  sessions: {
    id: string;
    agent: string;
    agent_session_id: string;
    ended_at: string | null;
    branches: string[];
    bundle_pinned: boolean;
  }[];
}

export interface Project {
  id: string;
  name: string;
  repo_key: string;
  auto_approve: boolean | null;
}
