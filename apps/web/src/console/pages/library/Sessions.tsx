// Sessions tab: every captured agent session, newest first, filtered by project, agent or status.
import { useI18n } from "@pama/i18n";
import { Table, TBody, TD, TH, THead, TR } from "@pama/ui";
import { Link } from "@tanstack/react-router";
import { Terminal } from "lucide-react";
import { useState } from "react";
import { AGENTS, PAGE_SIZE, SESSION_STATUSES, useProjects, useSessions } from "./data.ts";
import {
  AgentBadge,
  BranchChips,
  DigestStatusPill,
  FilterSelect,
  Pager,
  QueryView,
  useFormatDate,
} from "./parts.tsx";

export function Sessions() {
  const { t } = useI18n();
  const l = t.lib.library;
  const fmt = useFormatDate();
  const [project, setProject] = useState("");
  const [agent, setAgent] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const projects = useProjects();
  const sessions = useSessions({ project, agent, status }, offset);
  const filter = (set: (v: string) => void) => (v: string) => {
    set(v);
    setOffset(0);
  };

  return (
    <section className="space-y-4" aria-label={l.tabs.sessions}>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="sr-only">{l.filters}</legend>
        <FilterSelect
          label={l.project}
          value={project}
          onChange={filter(setProject)}
          allLabel={l.allProjects}
          options={(projects.data?.items ?? []).map((p) => ({ value: p.id, label: p.name }))}
        />
        <FilterSelect
          label={l.agent}
          value={agent}
          onChange={filter(setAgent)}
          allLabel={l.allAgents}
          options={AGENTS.map((a) => ({ value: a, label: t.lib.agents[a] ?? a }))}
        />
        <FilterSelect
          label={l.status}
          value={status}
          onChange={filter(setStatus)}
          allLabel={l.allStatuses}
          options={SESSION_STATUSES.map((s) => ({ value: s, label: t.lib.status[s] ?? s }))}
        />
      </fieldset>
      <QueryView
        query={sessions}
        isEmpty={(d) => d.items.length === 0}
        empty={{ icon: Terminal, title: l.sessionsEmpty, description: l.sessionsEmptyHint }}
      >
        {(d) => (
          <>
            <Table label={l.tabs.sessions}>
              <THead>
                <tr>
                  <TH>{l.session}</TH>
                  <TH>{l.agent}</TH>
                  <TH>{l.task}</TH>
                  <TH>{l.branches}</TH>
                  <TH>{l.status}</TH>
                  <TH>{l.ended}</TH>
                </tr>
              </THead>
              <TBody>
                {d.items.map((s) => (
                  <TR key={s.id}>
                    <TD className="min-w-56 max-w-md">
                      <Link
                        to={`/library/sessions/${s.id}`}
                        className="line-clamp-2 font-medium text-fg hover:underline"
                      >
                        {s.goal ?? l.noGoal}
                      </Link>
                      <span className="font-mono text-xs text-faint">
                        {s.agent_session_id.slice(0, 12)}
                      </span>
                    </TD>
                    <TD>
                      <AgentBadge agent={s.agent} />
                    </TD>
                    <TD className="min-w-40">
                      <Link
                        to={`/library/tasks/${s.bundle_id}`}
                        className="block text-fg hover:underline"
                      >
                        {s.bundle}
                      </Link>
                      <span className="text-xs text-faint">{s.project}</span>
                    </TD>
                    <TD className="min-w-32">
                      <BranchChips branches={s.branches} max={2} />
                    </TD>
                    <TD>
                      <DigestStatusPill status={s.status} />
                      {s.versions > 1 && (
                        <span className="mt-1 block text-xs text-faint">
                          {l.versions(s.versions)}
                        </span>
                      )}
                    </TD>
                    <TD className="whitespace-nowrap text-muted">{fmt(s.ended_at)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pager
              offset={offset}
              count={d.items.length}
              total={d.total}
              limit={PAGE_SIZE}
              onOffset={setOffset}
            />
          </>
        )}
      </QueryView>
    </section>
  );
}
