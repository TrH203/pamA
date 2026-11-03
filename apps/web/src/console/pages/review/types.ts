// Draft digests as GET /v1/review returns them (apps/server/src/routes/review.ts). The content is a
// SessionDigest (packages/types/schema/session-digest.schema.json).
import type { SessionDigest } from "@pama/types";

export type DigestContent = SessionDigest;
export type Decision = SessionDigest["decisions"][number];

export interface Draft {
  id: string;
  session_id?: string;
  version: number;
  status: string;
  created_at: string;
  project: string;
  project_id: string;
  bundle: string;
  bundle_id: string;
  /** Device that drafted it (thin client, spec 004). */
  device?: string | null;
  branches?: string[];
  content: DigestContent;
}

export interface Project {
  id: string;
  name: string;
  repo_key: string;
  auto_approve: boolean | null;
}
