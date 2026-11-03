// Settings → Publish (local mode, spec 007) and Sharing (server mode). Publish is the one-way copy
// of approved digests of chosen projects and tasks to a server; turning it off warns that Ask
// Links there lose those sources. Sending runs on the machine, so "Send now" is the CLI command.
import { useI18n } from "@pama/i18n";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Notice,
  StatusPill,
  Switch,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useConfirm,
  useToast,
} from "@pama/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CloudUpload, FolderGit2, Share2, TriangleAlert, Unplug } from "lucide-react";
import { useId } from "react";
import { api, errorMessage } from "../../../lib/api.ts";
import {
  type Project,
  type SyncProject,
  type SyncStatus,
  type SyncTask,
  settingsKeys,
  type Topology,
  useDevices,
  useProjects,
  useSyncStatus,
  useTopology,
} from "./data.ts";
import { CopyCommand, Loaded } from "./shared.tsx";

const quote = (s: string) => (/^[\w./-]+$/.test(s) ? s : `"${s.replaceAll('"', '\\"')}"`);

type Change =
  | { kind: "project"; id: string; body: { sync_enabled: boolean; sync_target?: string } }
  | { kind: "bundle"; id: string; body: { sync_enabled: boolean | null; sync_target?: string } };

function usePublishToggle(defaultTarget: string | undefined) {
  const { t } = useI18n();
  const p = t.pages.settings.publish;
  const confirm = useConfirm();
  const toast = useToast();
  const qc = useQueryClient();
  const patch = useMutation({
    mutationFn: (c: Change) =>
      api(`/v1/${c.kind === "project" ? "projects" : "bundles"}/${c.id}`, {
        method: "PATCH",
        json: c.body,
      }),
    onSuccess: () => toast.success(p.updated),
    onError: (e) => toast.error(p.updateFailed, errorMessage(e)),
    onSettled: () => void qc.invalidateQueries({ queryKey: settingsKeys.sync }),
  });

  /** Ask before anything stops being published: links on the target lose these sources. */
  async function confirmStop(kind: "project" | "bundle", id: string, name: string, target: string) {
    let where = target;
    try {
      const src = await api<{ target: string | null }>(
        `/v1/sync/source?type=${kind}&id=${encodeURIComponent(id)}`,
      );
      where = src.target ?? target;
    } catch {
      /* the warning still applies; keep the target we know */
    }
    const flag = kind === "project" ? "--project" : "--task";
    return confirm({
      title: p.stopTitle(name),
      description: (
        <span className="block space-y-2">
          <span className="block">{p.stopBody(where)}</span>
          <span className="block">{p.stopListHint}</span>
          <code className="block break-all rounded-control bg-subtle px-2 py-1 font-mono text-xs text-fg">
            pama sync disable {flag} {quote(name)}
          </code>
        </span>
      ),
      confirmLabel: p.stop,
      danger: true,
    });
  }

  async function setProject(project: SyncProject, on: boolean) {
    if (!on && !(await confirmStop("project", project.id, project.name, project.sync_target ?? "")))
      return;
    const target = !project.sync_target && on ? defaultTarget : undefined;
    patch.mutate({
      kind: "project",
      id: project.id,
      body: { sync_enabled: on, ...(target ? { sync_target: target } : {}) },
    });
  }

  async function setTask(project: SyncProject, task: SyncTask, next: boolean | null) {
    const was = task.sync_enabled ?? project.sync_enabled;
    const now = next ?? project.sync_enabled;
    if (
      was &&
      !now &&
      !(await confirmStop("bundle", task.id, task.name, project.sync_target ?? ""))
    )
      return;
    const target = !project.sync_target && now ? defaultTarget : undefined;
    patch.mutate({
      kind: "bundle",
      id: task.id,
      body: { sync_enabled: next, ...(target ? { sync_target: target } : {}) },
    });
  }

  return { setProject, setTask, busy: patch.isPending };
}

function TaskRow({
  project,
  task,
  toggle,
}: {
  project: SyncProject;
  task: SyncTask;
  toggle: ReturnType<typeof usePublishToggle>;
}) {
  const { t } = useI18n();
  const p = t.pages.settings.publish;
  const on = task.sync_enabled ?? project.sync_enabled;
  const id = useId();
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="text-ui font-medium">
          {task.name}
        </label>
        <p className="text-xs text-muted">
          {p.sessions(task.session_count)}
          {task.branches.length > 0 && (
            <span className="font-mono"> · {task.branches.slice(0, 3).join(", ")}</span>
          )}
        </p>
      </div>
      {task.sync_enabled === null ? (
        <Badge>{p.follows}</Badge>
      ) : (
        <span className="flex items-center gap-1">
          <Badge tone="accent">{p.override}</Badge>
          <Button
            size="sm"
            variant="ghost"
            disabled={toggle.busy}
            onClick={() => void toggle.setTask(project, task, null)}
          >
            {p.reset}
          </Button>
        </span>
      )}
      <StatusPill tone={on ? "success" : "neutral"} className="hidden sm:inline-flex">
        {on ? p.on : p.off}
      </StatusPill>
      <Switch
        id={id}
        aria-label={p.publishTask(task.name)}
        checked={on}
        disabled={toggle.busy}
        onCheckedChange={(v) => void toggle.setTask(project, task, v)}
      />
    </li>
  );
}

function ProjectCard({
  project,
  toggle,
}: {
  project: SyncProject;
  toggle: ReturnType<typeof usePublishToggle>;
}) {
  const { t } = useI18n();
  const p = t.pages.settings.publish;
  const id = useId();
  return (
    <Card aria-labelledby={`${id}-name`}>
      <div className="flex flex-wrap items-start gap-3">
        <FolderGit2 aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <h3 id={`${id}-name`} className="text-sm font-semibold">
            {project.name}
          </h3>
          <p className="break-all font-mono text-xs text-muted">{project.repo_key}</p>
          <p className="text-xs text-muted">
            {p.target}: <span className="font-mono">{project.sync_target ?? p.noTarget}</span> ·{" "}
            {p.tasks(project.bundles.length)}
          </p>
        </div>
        <StatusPill tone={project.sync_enabled ? "success" : "neutral"}>
          {project.sync_enabled ? p.on : p.off}
        </StatusPill>
        <Switch
          aria-label={p.publishProject(project.name)}
          checked={project.sync_enabled}
          disabled={toggle.busy}
          onCheckedChange={(v) => void toggle.setProject(project, v)}
        />
      </div>
      {project.bundles.length === 0 ? (
        <p className="mt-3 text-ui text-muted">{p.noTasks}</p>
      ) : (
        <ul className="mt-3 divide-y divide-line border-t border-line">
          {project.bundles.map((b) => (
            <TaskRow key={b.id} project={project} task={b} toggle={toggle} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function LocalPublish({ status }: { status: SyncStatus }) {
  const { t } = useI18n();
  const p = t.pages.settings.publish;
  const targets = [
    ...new Set(status.projects.map((x) => x.sync_target).filter((x): x is string => !!x)),
  ];
  const toggle = usePublishToggle(targets[0]);
  if (targets.length === 0)
    return (
      <EmptyState
        icon={Unplug}
        title={p.notConnectedTitle}
        description={p.notConnectedHint}
        action={<CopyCommand command="pama connect <url>" />}
      />
    );
  const shared = status.projects.some(
    (x) => x.sync_enabled || x.bundles.some((b) => b.sync_enabled === true),
  );
  const { digests, tombstones } = status.pending;
  return (
    <div className="space-y-4">
      <Notice tone="accent" icon={CloudUpload}>
        {p.oneWay}
      </Notice>
      {!shared && (
        <Notice tone="warning" icon={TriangleAlert}>
          {p.nothingShared(targets.join(", "))}
        </Notice>
      )}
      <Card>
        <CardHeader
          title={p.queueTitle}
          description={digests + tombstones > 0 ? p.queue(digests, tombstones) : p.queueEmpty}
        />
        <div className="space-y-3">
          <CopyCommand hint={p.syncNowHint} command="pama sync now" />
          <CopyCommand hint={p.failedHint} command="pama sync failed" />
        </div>
      </Card>
      <section aria-label={p.projects} className="space-y-3">
        {status.projects.length === 0 ? (
          <EmptyState icon={FolderGit2} title={p.noProjects} description={p.noProjectsHint} />
        ) : (
          status.projects.map((x) => <ProjectCard key={x.id} project={x} toggle={toggle} />)
        )}
      </section>
    </div>
  );
}

function ServerSharing() {
  const { t } = useI18n();
  const s = t.pages.settings.sharing;
  const projects = useProjects();
  const devices = useDevices();
  return (
    <Loaded queries={[projects, devices]}>
      {() => {
        const items: Project[] = projects.data?.items ?? [];
        const connected = (devices.data?.items ?? []).some((d) => !d.revoked_at);
        return (
          <div className="space-y-4">
            <Card>
              <CardHeader title={s.howTitle} description={s.howHint} />
              <div className="space-y-2">
                <CopyCommand command="pama sync status" />
                <CopyCommand command="pama sync enable --project <name>" />
              </div>
            </Card>
            {items.length === 0 ? (
              connected ? (
                <Notice tone="warning" icon={TriangleAlert}>
                  <p className="font-medium">{s.nothingTitle}</p>
                  <p>{s.nothingHint}</p>
                </Notice>
              ) : (
                <EmptyState icon={Share2} title={s.nothingTitle} description={s.howHint} />
              )
            ) : (
              <Table label={s.received}>
                <THead>
                  <tr>
                    <TH>{t.pages.settings.publish.project}</TH>
                    <TH>{s.repo}</TH>
                  </tr>
                </THead>
                <TBody>
                  {items.map((x) => (
                    <TR key={x.id}>
                      <TD className="font-medium">{x.name}</TD>
                      <TD className="break-all font-mono text-xs text-muted">{x.repo_key}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </div>
        );
      }}
    </Loaded>
  );
}

export function Publish() {
  const topo = useTopology();
  const local = topo.data?.mode === "local";
  const status = useSyncStatus(local);
  return (
    <Loaded queries={[topo]} rows={2}>
      {() =>
        (topo.data as Topology).mode === "local" ? (
          <Loaded queries={[status]}>
            {() => <LocalPublish status={status.data as SyncStatus} />}
          </Loaded>
        ) : (
          <ServerSharing />
        )
      }
    </Loaded>
  );
}
