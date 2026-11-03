// Digests tab: digest versions filtered by status, project and task. Superseded versions show
// only when asked for.
import { useI18n } from "@pama/i18n";
import { Table, TBody, TD, TH, THead, TR } from "@pama/ui";
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { useState } from "react";
import { DIGEST_STATUSES, PAGE_SIZE, useBundles, useDigests, useProjects } from "./data.ts";
import {
  AgentBadge,
  DigestStatusPill,
  FilterSelect,
  Pager,
  QueryView,
  useFormatDate,
} from "./parts.tsx";

export function Digests() {
  const { t } = useI18n();
  const l = t.lib.library;
  const fmt = useFormatDate();
  const [status, setStatus] = useState("");
  const [project, setProject] = useState("");
  const [bundle, setBundle] = useState("");
  const [offset, setOffset] = useState(0);
  const projects = useProjects();
  const bundles = useBundles();
  const digests = useDigests({ status, project, bundle }, offset);
  const tasks = (bundles.data?.items ?? []).filter((b) => !project || b.project_id === project);

  return (
    <section className="space-y-4" aria-label={l.tabs.digests}>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="sr-only">{l.filters}</legend>
        <FilterSelect
          label={l.status}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setOffset(0);
          }}
          allLabel={l.allStatuses}
          options={DIGEST_STATUSES.map((s) => ({ value: s, label: t.lib.status[s] ?? s }))}
        />
        <FilterSelect
          label={l.project}
          value={project}
          onChange={(v) => {
            setProject(v);
            setBundle("");
            setOffset(0);
          }}
          allLabel={l.allProjects}
          options={(projects.data?.items ?? []).map((p) => ({ value: p.id, label: p.name }))}
        />
        <FilterSelect
          label={l.task}
          value={bundle}
          onChange={(v) => {
            setBundle(v);
            setOffset(0);
          }}
          allLabel={l.allTasks}
          options={tasks.map((b) => ({ value: b.id, label: b.name }))}
        />
      </fieldset>
      <QueryView
        query={digests}
        isEmpty={(d) => d.items.length === 0}
        empty={{ icon: FileText, title: l.digestsEmpty, description: l.digestsEmptyHint }}
      >
        {(d) => (
          <>
            <Table label={l.tabs.digests}>
              <THead>
                <tr>
                  <TH>{t.lib.editor.goal}</TH>
                  <TH>{l.status}</TH>
                  <TH>{l.task}</TH>
                  <TH>{l.agent}</TH>
                  <TH>{l.created}</TH>
                </tr>
              </THead>
              <TBody>
                {d.items.map((x) => (
                  <TR key={x.id}>
                    <TD className="min-w-56 max-w-md">
                      <Link
                        to={`/library/sessions/${x.session_id}`}
                        className="line-clamp-2 font-medium text-fg hover:underline"
                      >
                        {x.goal ?? l.noGoal}
                      </Link>
                      <span className="text-xs text-faint">
                        {l.version(x.version)} · {l.decisions(x.decisions)}
                      </span>
                    </TD>
                    <TD>
                      <DigestStatusPill status={x.status} />
                    </TD>
                    <TD className="min-w-40">
                      <Link
                        to={`/library/tasks/${x.bundle_id}`}
                        className="block text-fg hover:underline"
                      >
                        {x.bundle}
                      </Link>
                      <span className="text-xs text-faint">{x.project}</span>
                    </TD>
                    <TD>
                      <AgentBadge agent={x.agent} />
                    </TD>
                    <TD className="whitespace-nowrap text-muted">{fmt(x.created_at)}</TD>
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
