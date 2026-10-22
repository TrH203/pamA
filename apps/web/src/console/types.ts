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
  content: DigestContent;
}

export interface Bundle {
  id: string;
  name: string;
  key: string | null;
  project: string;
  project_id: string;
  sessions: { id: string; agent: string; agent_session_id: string; ended_at: string | null }[];
}

export interface Project {
  id: string;
  name: string;
  repo_key: string;
  auto_approve: boolean | null;
}
