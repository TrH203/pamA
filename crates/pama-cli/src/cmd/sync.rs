//! `pama pair <code> --server <url>` and `pama sync status|enable|disable` (contracts/cli.md).
//! Sync is off by default and opt-in per project or bundle; disabling issues tombstones.

use pama_core::client::{policy_from, Api};
use pama_core::net::GuardedClient;
use pama_core::remote;
use pama_core::store::OutboxKind;
use pama_core::sync::{sync_once, token_key};
use serde_json::{json, Value};

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
    ctx.store.set_setting(KEY_DEFAULT_TARGET, server)?;
    ctx.print(&json!({ "server": server, "device_id": body["device_id"] }), || {
        format!("paired with {server}; enable sync per source with `pama sync enable --project <id>`")
    });
    Ok(Exit::Ok)
}

fn status(ctx: &Ctx, api: &Api) -> anyhow::Result<Exit> {
    let v = match api.get("/v1/sync/status", "sync.status") {
        Ok(v) => v,
        Err(e) => return Ok(api_exit(&e)),
    };
    let counts = ctx.store.outbox_counts()?;
    let mut out = v.clone();
    out["outbox"] = serde_json::to_value(&counts)?;
    ctx.print(&out, || {
        let mut lines = Vec::new();
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
        if lines.is_empty() {
            lines.push("no projects yet".into());
        }
        lines.push(format!(
            "\noutbox: {} pending, {} sent, {} failed",
            counts.pending, counts.sent, counts.dead
        ));
        lines.join("\n")
    });
    Ok(Exit::Ok)
}

fn set(ctx: &Ctx, api: &Api, t: &SyncTarget, enabled: bool) -> anyhow::Result<Exit> {
    let target = t.target.clone().or(ctx.store.setting(KEY_DEFAULT_TARGET)?);
    if enabled && target.is_none() {
        eprintln!("error: no target server; pair first (`pama pair <code> --server <url>`) or pass --target");
        return Ok(Exit::Config);
    }
    let (path, what) = match (&t.project, &t.bundle) {
        (Some(p), _) => (format!("/v1/projects/{p}"), format!("project {p}")),
        (_, Some(b)) => (format!("/v1/bundles/{b}"), format!("bundle {b}")),
        _ => {
            eprintln!("error: give --project <id> or --bundle <id> (see `pama sync status`)");
            return Ok(Exit::User);
        }
    };
    let mut body = json!({ "sync_enabled": enabled });
    if enabled {
        body["sync_target"] = json!(target);
    }
    // PATCH through the local API.
    if let Err(e) = api.patch(&path, "sync.toggle", &body) {
        return Ok(api_exit(&e));
    }
    let report = sync_once(&ctx.store)?;
    ctx.print(
        &json!({ "source": what, "enabled": enabled, "delivery": report }),
        || {
            format!(
                "sync {} for {what}; delivered {} item(s){}",
                if enabled {
                    "enabled"
                } else {
                    "disabled (remote copies will be deleted)"
                },
                report.sent,
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

/// Remote mode (spec 004): sync is a list of projects on this device; turning one off sends a
/// tombstone so the server deletes its copies (the device always wins).
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
            ctx.print(
                &json!({ "mode": "remote", "server": server, "projects": projects, "digests": by_status, "outbox": counts }),
                || {
                    let mut lines = vec![format!("remote mode → {server}")];
                    if projects.is_empty() {
                        lines.push("no project sends drafts yet (`pama init --sync`)".into());
                    }
                    for p in &projects {
                        lines.push(format!("● {p}"));
                    }
                    let digests: Vec<String> =
                        by_status.iter().map(|(k, v)| format!("{v} {k}")).collect();
                    if !digests.is_empty() {
                        lines.push(format!("digests on this device: {}", digests.join(", ")));
                    }
                    lines.push(format!(
                        "\noutbox: {} pending, {} sent, {} failed",
                        counts.pending, counts.sent, counts.dead
                    ));
                    lines.join("\n")
                },
            );
            Ok(Exit::Ok)
        }
        SyncAction::Enable(t) | SyncAction::Disable(t) if t.bundle.is_some() => {
            let _ = t;
            eprintln!("error: in remote mode sync is per project (--project <dir|key>)");
            Ok(Exit::User)
        }
        SyncAction::Enable(t) | SyncAction::Disable(t) if t.project.is_none() => {
            let _ = t;
            eprintln!("error: give --project <dir|key> (see `pama sync status`)");
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
            let report = pama_core::sync::deliver_due(
                &ctx.store,
                &pama_core::sync::HttpRemote::new(&ctx.store),
            )?;
            ctx.print(
                &json!({ "project": key, "enabled": false, "delivery": report }),
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
    }
}

pub fn run(ctx: &Ctx, action: SyncAction) -> anyhow::Result<Exit> {
    pama_core::secrets::init_platform_store();
    let api = match ctx.api() {
        Ok(a) => a,
        Err(e) => return Ok(api_exit(&e)),
    };
    if api.remote_url().is_some() {
        return run_remote(ctx, &api, action);
    }
    match action {
        SyncAction::Status => status(ctx, &api),
        SyncAction::Enable(t) => set(ctx, &api, &t, true),
        SyncAction::Disable(t) => set(ctx, &api, &t, false),
    }
}
