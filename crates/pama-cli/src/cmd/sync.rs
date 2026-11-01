//! `pama pair <code> --server <url>` and `pama sync status|enable|disable|now|failed|retry|drop`
//! (contracts/cli.md, spec 007).
//!
//! Local mode: the one-way copy of approved digests to a server is called **Publish** in
//! everything people read; it is off by default and opt-in per project or task, and turning it
//! off issues tombstones. Remote mode: the server is the home; sync decides which projects and
//! tasks send drafts there. Code and API keep the word "bundle" for a task.

use pama_core::client::{policy_from, Api};
use pama_core::net::GuardedClient;
use pama_core::remote;
use pama_core::store::{OutboxKind, OutboxMatch};
use pama_core::sync::{
    deliver_due, describe_item, nothing_shared, sync_once, token_key, HttpRemote,
};
use serde_json::{json, Value};

use super::resolve::{candidates, resolve_or_exit};
use super::{api_exit, Ctx};
use crate::{Exit, SyncAction, SyncTarget};

pub const KEY_DEFAULT_TARGET: &str = remote::KEY_DEFAULT_TARGET;

pub fn pair(ctx: &Ctx, code: &str, server: &str) -> anyhow::Result<Exit> {
    pama_core::secrets::init_platform_store();
    let server = server.trim_end_matches('/');
    let name = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "pama device".into());
    let client = GuardedClient::new(policy_from(&ctx.store), &ctx.store, "cli");
    let resp = client.post_json(
        &format!("{server}/v1/devices/pair"),
        "sync.pair",
        None,
        &json!({ "code": code, "device_name": name }),
    )?;
    let status = resp.status().as_u16();
    let body: Value = resp.json().unwrap_or(Value::Null);
    if status != 200 {
        eprintln!(
            "error: pairing failed ({status}): {}",
            body["error"]["message"].as_str().unwrap_or("")
        );
        return Ok(if status == 410 || status == 400 {
            Exit::User
        } else {
            Exit::Network
        });
    }
    let token = body["token"].as_str().unwrap_or_default();
    pama_core::secrets::set(&token_key(server), token)?;
    // Listed like a logged-in server, so `pama server list`, `use` and `forget` see it (spec 005).
    remote::add_server(
        &ctx.store,
        remote::ServerEntry {
            url: server.to_string(),
            workspace_id: None,
            device_id: body["device_id"].as_str().map(String::from),
        },
    )?;
    ctx.print(&json!({ "server": server, "device_id": body["device_id"] }), || {
        format!(
            "paired with {server}; nothing is published yet: publish a project with `pama sync enable --project <name>`"
        )
    });
    Ok(Exit::Ok)
}

fn plural(n: usize, one: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {one}s")
    }
}

fn outbox_line(c: &pama_core::store::OutboxCounts) -> String {
    let mut s = format!(
        "outbox: {} pending, {} sent, {} failed",
        c.pending, c.sent, c.dead
    );
    if c.dead > 0 {
        s.push_str(" (see `pama sync failed`)");
    }
    s
}

/// Local mode: projects and tasks published to their target.
fn status(ctx: &Ctx, api: &Api) -> anyhow::Result<Exit> {
    let v = match api.get("/v1/sync/status", "sync.status") {
        Ok(v) => v,
        Err(e) => return Ok(api_exit(&e)),
    };
    let counts = ctx.store.outbox_counts()?;
    let target = ctx.store.setting(KEY_DEFAULT_TARGET)?;
    let shared = published_count(&v);
    let warning = nothing_shared(target.as_deref(), shared);
    let mut out = v.clone();
    out["outbox"] = serde_json::to_value(&counts)?;
    out["publish_target"] = json!(target);
    out["warning"] = json!(warning);
    ctx.print(&out, || {
        let mut lines = vec![match &target {
            Some(t) => format!("Publish (one-way copy of approved digests) → {t}"),
            None => "Publish: no server paired (`pama pair <code> --server <url>`)".into(),
        }];
        for p in v["projects"].as_array().into_iter().flatten() {
            let on = p["sync_enabled"].as_bool() == Some(true);
            lines.push(format!(
                "{} {}  {}{}",
                if on { "●" } else { "○" },
                p["id"].as_str().unwrap_or("?"),
                p["name"].as_str().unwrap_or("?"),
                p["sync_target"]
                    .as_str()
                    .filter(|_| on)
                    .map(|t| format!(" → {t}"))
                    .unwrap_or_default()
            ));
            for b in p["bundles"].as_array().into_iter().flatten() {
                lines.push(super::bundle_fmt::bundle_line(b));
            }
        }
        if v["projects"].as_array().is_none_or(Vec::is_empty) {
            lines.push("no projects yet".into());
        }
        if let Some(w) = &warning {
            lines.push(format!(
                "\n! {w}: `pama sync enable --project <name>` or `--task <name>`"
            ));
        }
        lines.push(format!("\n{}", outbox_line(&counts)));
        lines.join("\n")
    });
    Ok(Exit::Ok)
}

/// Projects and tasks with publish turned on in a `/v1/sync/status` reply.
pub fn published_count(v: &Value) -> usize {
    v["projects"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            usize::from(p["sync_enabled"].as_bool() == Some(true))
                + p["bundles"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|b| b["sync_enabled"].as_bool() == Some(true))
                    .count()
        })
        .sum()
}

/// A project (`/v1/projects`) or task (`/v1/bundles`) by name or id: `(id, name)`.
fn find(api: &Api, kind: &str, query: &str) -> Result<(Value, String), Exit> {
    let (path, name_field, ctx_field, label) = match kind {
        "project" => ("/v1/projects", "name", "repo_key", "project"),
        _ => ("/v1/bundles", "name", "project", "task"),
    };
    let list = api.get(path, "sync.lookup").map_err(|e| api_exit(&e))?;
    let items = list["items"].as_array().cloned().unwrap_or_default();
    let mut cands = candidates(&items, name_field, ctx_field);
    if kind == "project" {
        // Projects also answer to their repo key (`github.com/acme/shop`) and a directory.
        let keys: Vec<String> = if std::path::Path::new(query).is_dir() {
            remote::project_keys(query)
                .into_iter()
                .map(|p| p.key)
                .collect()
        } else {
            vec![query.to_string()]
        };
        if let Some(i) = cands.iter().position(|c| keys.contains(&c.context)) {
            return Ok((items[i].clone(), label.into()));
        }
        for c in &mut cands {
            c.context.clear();
        }
    }
    let i = resolve_or_exit(label, query, &cands)?;
    Ok((items[i].clone(), label.into()))
}

/// Print the Ask Links that would lose sources and decide whether to go on.
fn confirm_links(ctx: &Ctx, target: &str, links: &[Value], yes: bool, what: &str) -> bool {
    if links.is_empty() || yes {
        return true;
    }
    if ctx.json {
        ctx.print(
            &json!({ "confirmed": false, "source": what, "target": target, "affected_links": links }),
            String::new,
        );
    } else {
        eprintln!(
            "Turning off sync for {what} deletes its copies on {target}; these Ask Links there lose sources:"
        );
        for l in links {
            eprintln!(
                "  {}  {}{}",
                l["slug"].as_str().unwrap_or("?"),
                l["title"].as_str().unwrap_or(""),
                if l["empty"].as_bool() == Some(true) {
                    "  (stops answering: nothing left in its scope)"
                } else {
                    ""
                }
            );
        }
        eprintln!("Run again with --yes to go ahead.");
    }
    false
}

/// Ask the target about affected links; `None` when it cannot tell (old or unreachable server).
fn affected(ctx: &Ctx, target: &str, source_type: &str, key: &str) -> Vec<Value> {
    match HttpRemote::new(&ctx.store).affected_links(target, source_type, key) {
        Ok(Some(links)) => links,
        Ok(None) => {
            eprintln!("note: {target} cannot list affected Ask Links (older server)");
            Vec::new()
        }
        Err(e) => {
            eprintln!("note: could not check Ask Links on {target}: {e}");
            Vec::new()
        }
    }
}

fn set(ctx: &Ctx, api: &Api, t: &SyncTarget, enabled: bool) -> anyhow::Result<Exit> {
    let target = t.target.clone().or(ctx.store.setting(KEY_DEFAULT_TARGET)?);
    if enabled && target.is_none() {
        eprintln!("error: no server to publish to; connect first (`pama connect <url>`) or pass --target");
        return Ok(Exit::Config);
    }
    let (query, kind) = match (&t.project, &t.bundle) {
        (Some(p), _) => (p.as_str(), "project"),
        (_, Some(b)) => (b.as_str(), "bundle"),
        _ => {
            eprintln!(
                "error: give --project <name|id> or --task <name|id> (see `pama sync status`)"
            );
            return Ok(Exit::User);
        }
    };
    let (item, label) = match find(api, kind, query) {
        Ok(x) => x,
        Err(code) => return Ok(code),
    };
    let id = item["id"].as_str().unwrap_or_default().to_string();
    let what = format!("{label} {}", item["name"].as_str().unwrap_or(&id));
    let mut links = Vec::new();
    if !enabled {
        // Where its published copy lives, and the Ask Links there that would lose sources.
        let path = format!("/v1/sync/source?type={kind}&id={id}");
        if let Ok(src) = api.get(&path, "sync.source") {
            if let (Some(to), Some(k)) = (src["target"].as_str(), src["source_key"].as_str()) {
                links = affected(ctx, to, kind, k);
                if !confirm_links(ctx, to, &links, t.yes, &what) {
                    return Ok(Exit::User);
                }
            }
        }
    }
    let path = match kind {
        "project" => format!("/v1/projects/{id}"),
        _ => format!("/v1/bundles/{id}"),
    };
    let mut body = json!({ "sync_enabled": enabled });
    if enabled {
        body["sync_target"] = json!(target);
    }
    if let Err(e) = api.patch(&path, "sync.toggle", &body) {
        return Ok(api_exit(&e));
    }
    let report = sync_once(&ctx.store)?;
    ctx.print(
        &json!({ "source": what, "enabled": enabled, "delivery": report, "affected_links": links }),
        || {
            format!(
                "{} for {what}; delivered {}{}",
                if enabled {
                    "publish on"
                } else {
                    "publish off (the published copies will be deleted)"
                },
                plural(report.sent, "item"),
                if report.retrying > 0 {
                    format!(", {} waiting for the network", report.retrying)
                } else {
                    String::new()
                }
            )
        },
    );
    Ok(Exit::Ok)
}

/// `--project` in remote mode: a directory (resolved to its project keys) or a project key.
fn project_keys(arg: &str) -> Vec<String> {
    if std::path::Path::new(arg).is_dir() {
        return remote::project_keys(arg)
            .into_iter()
            .map(|p| p.key)
            .collect();
    }
    vec![arg.to_string()]
}

/// Remote mode: `pama sync enable|disable --task <name|id>` (spec 004 FR-012). The task is
/// looked up on the server for its portable key (project key + bundle key).
fn remote_task(ctx: &Ctx, api: &Api, t: &SyncTarget, enabled: bool) -> anyhow::Result<Exit> {
    let server = api.remote_url().unwrap_or_default().to_string();
    let (item, _) = match find(api, "bundle", t.bundle.as_deref().unwrap_or_default()) {
        Ok(x) => x,
        Err(code) => return Ok(code),
    };
    let name = item["name"].as_str().unwrap_or("?").to_string();
    let (Some(project_key), Some(key)) = (item["project_key"].as_str(), item["key"].as_str())
    else {
        eprintln!(
            "error: task \"{name}\" was made by a split on the server and has no branch key; turn sync off for its sessions' project or delete them in the console"
        );
        return Ok(Exit::User);
    };
    let what = format!("task {name}");
    if enabled {
        remote::set_bundle_sync(&ctx.store, project_key, key, Some(true))?;
        ctx.print(
            &json!({ "task": name, "project_key": project_key, "bundle_key": key, "enabled": true }),
            || format!("drafts of {what} go to {server} from now on"),
        );
        return Ok(Exit::Ok);
    }
    let source_key = remote::task_key(project_key, key);
    let links = affected(ctx, &server, "bundle", &source_key);
    if !confirm_links(ctx, &server, &links, t.yes, &what) {
        return Ok(Exit::User);
    }
    remote::set_bundle_sync(&ctx.store, project_key, key, Some(false))?;
    ctx.store
        .mark_remote_bundle_deleted(&server, project_key, key)?;
    ctx.store.outbox_push(
        OutboxKind::SourceTombstone,
        &server,
        &json!({ "source_type": "bundle", "source_key": source_key }),
    )?;
    let report = deliver_due(&ctx.store, &HttpRemote::new(&ctx.store))?;
    ctx.print(
        &json!({ "task": name, "enabled": false, "delivery": report, "affected_links": links }),
        || format!("sync off for {what}; its copies on {server} are deleted"),
    );
    Ok(Exit::Ok)
}

/// Remote mode (spec 004): sync is a list of projects (and task overrides) on this device;
/// turning one off sends a tombstone so the server deletes its copies (the device always wins).
fn run_remote(ctx: &Ctx, api: &Api, action: SyncAction) -> anyhow::Result<Exit> {
    let server = api.remote_url().unwrap_or_default().to_string();
    match action {
        SyncAction::Status => {
            let _ = remote::pull_changes(&ctx.store, api, true);
            let counts = ctx.store.outbox_counts()?;
            let mut by_status = std::collections::BTreeMap::<String, usize>::new();
            for d in ctx.store.remote_digests(&server)? {
                *by_status.entry(d.status).or_default() += 1;
            }
            let projects = remote::sync_projects(&ctx.store);
            let tasks = remote::bundle_sync_overrides(&ctx.store);
            let shared = projects.len() + tasks.iter().filter(|(_, on)| *on).count();
            let warning = nothing_shared(Some(&server), shared);
            ctx.print(
                &json!({ "mode": "remote", "server": server, "projects": projects,
                         "tasks": tasks.iter().map(|(k, on)| json!({ "task": k, "enabled": on })).collect::<Vec<_>>(),
                         "digests": by_status, "outbox": counts, "warning": warning }),
                || {
                    let mut lines = vec![format!("home: {server} (drafts are reviewed there)")];
                    for p in &projects {
                        lines.push(format!("● {p}"));
                    }
                    for (k, on) in &tasks {
                        lines.push(format!(
                            "  {} task {k}",
                            if *on { "● on " } else { "○ off" }
                        ));
                    }
                    if let Some(w) = &warning {
                        lines.push(format!("! {w}: `pama init --sync` in a project"));
                    }
                    let digests: Vec<String> =
                        by_status.iter().map(|(k, v)| format!("{v} {k}")).collect();
                    if !digests.is_empty() {
                        lines.push(format!("digests on this device: {}", digests.join(", ")));
                    }
                    lines.push(format!("\n{}", outbox_line(&counts)));
                    lines.join("\n")
                },
            );
            Ok(Exit::Ok)
        }
        SyncAction::Enable(t) if t.bundle.is_some() => remote_task(ctx, api, &t, true),
        SyncAction::Disable(t) if t.bundle.is_some() => remote_task(ctx, api, &t, false),
        SyncAction::Enable(t) | SyncAction::Disable(t) if t.project.is_none() => {
            let _ = t;
            eprintln!(
                "error: give --project <dir|key> or --task <name|id> (see `pama sync status`)"
            );
            Ok(Exit::User)
        }
        SyncAction::Enable(t) => {
            let keys = project_keys(t.project.as_deref().unwrap_or_default());
            for k in &keys {
                remote::set_project_sync(&ctx.store, k, true)?;
            }
            let key = keys[0].clone();
            ctx.print(&json!({ "project": key, "enabled": true }), || {
                format!("drafts of {key} go to {server} from now on")
            });
            Ok(Exit::Ok)
        }
        SyncAction::Disable(t) => {
            let keys = project_keys(t.project.as_deref().unwrap_or_default());
            let mut links = Vec::new();
            for k in &keys {
                links.extend(affected(ctx, &server, "project", k));
            }
            if !confirm_links(ctx, &server, &links, t.yes, &format!("project {}", keys[0])) {
                return Ok(Exit::User);
            }
            for k in &keys {
                remote::set_project_sync(&ctx.store, k, false)?;
                ctx.store.mark_remote_project_deleted(&server, k)?;
                ctx.store.outbox_push(
                    OutboxKind::SourceTombstone,
                    &server,
                    &json!({ "source_type": "project", "source_key": k }),
                )?;
            }
            let key = keys[0].clone();
            let report = deliver_due(&ctx.store, &HttpRemote::new(&ctx.store))?;
            ctx.print(
                &json!({ "project": key, "enabled": false, "delivery": report, "affected_links": links }),
                || {
                    format!(
                        "sync off for {key}; the server copies {}",
                        if report.retrying > 0 {
                            "will be deleted when the server is reachable"
                        } else {
                            "are deleted"
                        }
                    )
                },
            );
            Ok(Exit::Ok)
        }
        other => outbox_action(ctx, Some(api), other),
    }
}

/// `pama sync now|failed|retry|drop` (both modes).
fn outbox_action(ctx: &Ctx, api: Option<&Api>, action: SyncAction) -> anyhow::Result<Exit> {
    let remote_home = api.filter(|a| a.remote_url().is_some());
    match action {
        SyncAction::Now => {
            let local = if remote_home.is_none() {
                pama_core::client::LocalApi::connect(&ctx.store, "cli")
                    .ok()
                    .filter(|a| a.healthy())
            } else {
                None
            };
            let report = match pama_core::sync::sync_now(
                &ctx.store,
                local.as_ref(),
                &HttpRemote::new(&ctx.store),
                remote_home,
            ) {
                Ok(r) => r,
                Err(e) => return Ok(api_exit(&e)),
            };
            let verb = if remote_home.is_some() {
                "sent"
            } else {
                "published"
            };
            ctx.print(&serde_json::to_value(&report)?, || {
                let mut lines = Vec::new();
                if remote_home.is_none() && local.is_none() {
                    lines.push(
                        "note: the local server is not running; only queued items were sent"
                            .to_string(),
                    );
                }
                if report.collected > 0 {
                    lines.push(format!("queued {}", plural(report.collected, "new item")));
                }
                lines.push(format!("{verb} {}", plural(report.delivery.sent, "item")));
                if report.delivery.retrying > 0 {
                    lines.push(format!(
                        "{} waiting for the network",
                        report.delivery.retrying
                    ));
                }
                if let Some(p) = &report.pulled {
                    lines.push(format!("pulled {}", plural(p.applied, "review decision")));
                }
                if report.dead > 0 {
                    lines.push(format!("{} failed (see `pama sync failed`)", report.dead));
                }
                lines.join("; ")
            });
            Ok(if report.delivery.retrying > 0 {
                Exit::Network
            } else {
                Exit::Ok
            })
        }
        SyncAction::Failed => {
            let items = ctx.store.outbox_dead_items(200)?;
            let value: Vec<Value> = items
                .iter()
                .map(|d| {
                    json!({
                        "id": d.id, "kind": d.kind, "target": d.target, "attempts": d.attempts,
                        "last_error": d.last_error, "created_at": d.created_at,
                        "what": describe_item(d.kind, &d.payload),
                    })
                })
                .collect();
            ctx.print(&json!({ "items": value }), || {
                if items.is_empty() {
                    return "nothing failed".into();
                }
                let mut lines: Vec<String> = items
                    .iter()
                    .map(|d| {
                        format!(
                            "{}  {}  → {}\n    {}\n    last error: {}",
                            d.id,
                            d.kind.as_str(),
                            d.target,
                            describe_item(d.kind, &d.payload),
                            d.last_error.as_deref().unwrap_or("-")
                        )
                    })
                    .collect();
                lines.push(
                    "\nretry: pama sync retry <id> | --all · give up: pama sync drop <id>".into(),
                );
                lines.join("\n")
            });
            Ok(Exit::Ok)
        }
        SyncAction::Retry { id, all } => {
            let n = if all {
                ctx.store.outbox_revive_all()?
            } else {
                let Some(id) = id else {
                    eprintln!("error: give an id from `pama sync failed`, or --all");
                    return Ok(Exit::User);
                };
                match matched(ctx, &id)? {
                    Some(full) => usize::from(ctx.store.outbox_revive(&full)?),
                    None => return Ok(Exit::User),
                }
            };
            let report = deliver_due(&ctx.store, &HttpRemote::new(&ctx.store))?;
            ctx.print(&json!({ "retried": n, "delivery": report }), || {
                format!(
                    "retried {}: {} sent, {} waiting, {} failed again",
                    plural(n, "item"),
                    report.sent,
                    report.retrying,
                    report.dead
                )
            });
            Ok(Exit::Ok)
        }
        SyncAction::Drop { id } => match matched(ctx, &id)? {
            Some(full) => {
                ctx.store.outbox_drop(&full)?;
                ctx.print(&json!({ "dropped": full }), || format!("dropped {full}"));
                Ok(Exit::Ok)
            }
            None => Ok(Exit::User),
        },
        SyncAction::Status | SyncAction::Enable(_) | SyncAction::Disable(_) => Ok(Exit::User),
    }
}

/// The dead outbox item an id or id prefix names; explains on stderr otherwise.
fn matched(ctx: &Ctx, id: &str) -> anyhow::Result<Option<String>> {
    Ok(match ctx.store.outbox_match_dead(id)? {
        OutboxMatch::One(full) => Some(full),
        OutboxMatch::None => {
            eprintln!("error: no failed item {id} (see `pama sync failed`)");
            None
        }
        OutboxMatch::Many(ids) => {
            eprintln!(
                "error: {id} matches {} failed items: {}",
                ids.len(),
                ids.join(", ")
            );
            None
        }
    })
}

pub fn run(ctx: &Ctx, action: SyncAction) -> anyhow::Result<Exit> {
    pama_core::secrets::init_platform_store();
    // The outbox commands work without a server connection.
    if matches!(
        action,
        SyncAction::Failed | SyncAction::Drop { .. } | SyncAction::Retry { .. }
    ) {
        return outbox_action(ctx, None, action);
    }
    let api = match ctx.api() {
        Ok(a) => a,
        Err(e) if matches!(action, SyncAction::Now) => {
            // Local mode without a running server: still deliver what is queued.
            if remote::mode(&ctx.store) == remote::Mode::Local {
                return outbox_action(ctx, None, action);
            }
            return Ok(api_exit(&e));
        }
        Err(e) => return Ok(api_exit(&e)),
    };
    if api.remote_url().is_some() {
        return run_remote(ctx, &api, action);
    }
    match action {
        SyncAction::Status => status(ctx, &api),
        SyncAction::Enable(t) => set(ctx, &api, &t, true),
        SyncAction::Disable(t) => set(ctx, &api, &t, false),
        other => outbox_action(ctx, Some(&api), other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn published_count_counts_projects_and_task_overrides() {
        let v = json!({ "projects": [
            { "sync_enabled": true, "bundles": [{ "sync_enabled": null }, { "sync_enabled": false }] },
            { "sync_enabled": false, "bundles": [{ "sync_enabled": true }] },
        ]});
        assert_eq!(published_count(&v), 2);
        assert_eq!(published_count(&json!({ "projects": [] })), 0);
        assert_eq!(
            nothing_shared(Some("https://x"), published_count(&json!({}))).as_deref(),
            Some("connected to https://x but nothing is shared yet")
        );
        assert_eq!(nothing_shared(None, 0), None);
        assert_eq!(nothing_shared(Some("https://x"), 1), None);
    }
}
