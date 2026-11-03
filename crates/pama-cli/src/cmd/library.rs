//! Library commands (spec 007): `pama tasks`, `pama sessions`, `pama digests`, `pama search`.
//! Tasks are what the API calls bundles. Every command accepts names or ids and has `--json`.

use pama_core::client::Api;
use serde_json::{json, Value};

use super::bundle_fmt::branches_text;
use super::resolve::{candidates, resolve_or_exit, Candidate};
use super::{api_exit, Ctx};
use crate::ui;
use crate::{DigestsAction, Exit, ListPage, SessionsAction, TasksAction};

/// `2026-10-23T09:12:00.000Z` → `2026-10-23 09:12`.
fn when(v: &Value) -> String {
    v.as_str()
        .map(|t| t.replace('T', " ").chars().take(16).collect())
        .unwrap_or_else(|| "-".into())
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("-")
}

/// The distinct items, first occurrence kept, in order (`Vec::dedup` only drops neighbours).
fn unique<T: PartialEq + Clone>(items: impl IntoIterator<Item = T>) -> Vec<T> {
    let mut out: Vec<T> = Vec::new();
    for x in items {
        if !out.contains(&x) {
            out.push(x);
        }
    }
    out
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn connect(ctx: &Ctx) -> Result<Api<'_>, Exit> {
    ctx.api().map_err(|e| api_exit(&e))
}

fn get(api: &Api, path: &str) -> Result<Value, Exit> {
    api.get(path, "library").map_err(|e| api_exit(&e))
}

/// Run `f`; an `Err(exit)` becomes that exit code.
fn done(r: Result<Exit, Exit>) -> anyhow::Result<Exit> {
    Ok(r.unwrap_or_else(|e| e))
}

// --- tasks ---------------------------------------------------------------------------------

fn all_tasks(api: &Api) -> Result<Vec<Value>, Exit> {
    Ok(get(api, "/v1/bundles")?["items"]
        .as_array()
        .cloned()
        .unwrap_or_default())
}

fn find_task(tasks: &[Value], query: &str) -> Result<Value, Exit> {
    let i = resolve_or_exit("task", query, &candidates(tasks, "name", "project"))?;
    Ok(tasks[i].clone())
}

fn find_project(api: &Api, query: &str) -> Result<Value, Exit> {
    let items = get(api, "/v1/projects")?["items"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if let Some(p) = items.iter().find(|p| p["repo_key"] == query) {
        return Ok(p.clone());
    }
    let i = resolve_or_exit("project", query, &candidates(&items, "name", "repo_key"))?;
    Ok(items[i].clone())
}

fn task_line(t: &Value) -> String {
    let n = t["session_count"].as_u64().unwrap_or(0);
    format!(
        "  {}  {}\n      {}",
        ui::dim(s(t, "id")),
        s(t, "name"),
        ui::dim(&format!(
            "{} · branches: {} · last {}",
            if n == 1 {
                "1 session".to_string()
            } else {
                format!("{n} sessions")
            },
            branches_text(&strings(&t["branches"])),
            when(&t["last_activity"]),
        ))
    )
}

pub fn tasks(ctx: &Ctx, action: TasksAction) -> anyhow::Result<Exit> {
    done((|| {
        let api = connect(ctx)?;
        match action {
            TasksAction::List { project } => {
                let mut items = all_tasks(&api)?;
                if let Some(p) = project {
                    let p = find_project(&api, &p)?;
                    items.retain(|t| t["project_id"] == p["id"]);
                }
                ctx.print(&json!({ "items": items }), || {
                    if items.is_empty() {
                        return format!(
                            "{} no tasks yet: tasks appear once an agent session is captured",
                            ui::Mark::Info.sym()
                        );
                    }
                    let mut out = Vec::new();
                    let mut last = String::new();
                    for t in &items {
                        let p = s(t, "project").to_string();
                        if p != last {
                            if !out.is_empty() {
                                out.push(String::new());
                            }
                            out.push(ui::heading(&p));
                            last = p;
                        }
                        out.push(task_line(t));
                    }
                    out.join("\n")
                });
                Ok(Exit::Ok)
            }
            TasksAction::Show { task } => {
                let t = find_task(&all_tasks(&api)?, &task)?;
                ctx.print(&t, || {
                    let mut out = vec![
                        format!("{} ({})", s(&t, "name"), s(&t, "project")),
                        task_line(&t),
                    ];
                    for x in t["sessions"].as_array().into_iter().flatten() {
                        out.push(format!(
                            "    {}  {} {}  ended {}{}",
                            s(x, "id"),
                            s(x, "agent"),
                            s(x, "agent_session_id"),
                            when(&x["ended_at"]),
                            if x["bundle_pinned"].as_bool() == Some(true) {
                                "  (moved by you)"
                            } else {
                                ""
                            }
                        ));
                    }
                    out.join("\n")
                });
                Ok(Exit::Ok)
            }
            TasksAction::Rename { task, name } => {
                let t = find_task(&all_tasks(&api)?, &task)?;
                let id = s(&t, "id");
                api.patch(
                    &format!("/v1/bundles/{id}"),
                    "library",
                    &json!({ "name": name }),
                )
                .map_err(|e| api_exit(&e))?;
                ctx.print(&json!({ "id": id, "name": name }), || {
                    format!("renamed task \"{}\" to \"{name}\"", s(&t, "name"))
                });
                Ok(Exit::Ok)
            }
            TasksAction::Merge { tasks, name } => {
                let all = all_tasks(&api)?;
                let picked = tasks
                    .iter()
                    .map(|q| find_task(&all, q))
                    .collect::<Result<Vec<_>, _>>()?;
                // A task named twice (by name and by id, say) is merged once.
                let ids = unique(picked.iter().map(|t| s(t, "id")));
                if ids.len() < 2 {
                    crate::fail!("usage", "give at least two different tasks");
                    return Err(Exit::User);
                }
                let name = name.unwrap_or_else(|| s(&picked[0], "name").to_string());
                let r = api
                    .post(
                        "/v1/bundles/merge",
                        "library",
                        &json!({ "bundle_ids": ids, "name": name }),
                    )
                    .map_err(|e| api_exit(&e))?;
                ctx.print(&r, || {
                    format!(
                        "merged {} tasks into \"{name}\" ({})",
                        ids.len(),
                        s(&r, "id")
                    )
                });
                Ok(Exit::Ok)
            }
            TasksAction::Split {
                task,
                sessions,
                name,
            } => {
                let t = find_task(&all_tasks(&api)?, &task)?;
                let members: Vec<Value> = t["sessions"].as_array().cloned().unwrap_or_default();
                // Sessions answer to their id or to the agent's own session id.
                let cands: Vec<Candidate> = members
                    .iter()
                    .flat_map(|m| {
                        [
                            Candidate {
                                id: s(m, "id").into(),
                                name: s(m, "agent_session_id").into(),
                                context: String::new(),
                            },
                            Candidate {
                                id: s(m, "agent_session_id").into(),
                                name: s(m, "id").into(),
                                context: String::new(),
                            },
                        ]
                    })
                    .collect();
                let mut picked = Vec::new();
                for q in &sessions {
                    let i = resolve_or_exit("session in this task", q, &cands)?;
                    picked.push(s(&members[i / 2], "id").to_string());
                }
                let ids = unique(picked);
                let r = api
                    .post(
                        &format!("/v1/bundles/{}/split", s(&t, "id")),
                        "library",
                        &json!({ "session_ids": ids, "new_name": name }),
                    )
                    .map_err(|e| api_exit(&e))?;
                ctx.print(&r, || {
                    format!(
                        "moved {} session(s) from \"{}\" to new task \"{name}\" ({})",
                        ids.len(),
                        s(&t, "name"),
                        s(&r, "id")
                    )
                });
                Ok(Exit::Ok)
            }
        }
    })())
}

// --- sessions ------------------------------------------------------------------------------

fn query_string(pairs: &[(&str, Option<String>)]) -> String {
    let mut url = reqwest::Url::parse("http://x/").expect("url");
    {
        let mut q = url.query_pairs_mut();
        for (k, v) in pairs {
            if let Some(v) = v {
                q.append_pair(k, v);
            }
        }
    }
    url.query()
        .filter(|q| !q.is_empty())
        .map(|q| format!("?{q}"))
        .unwrap_or_default()
}

fn page_pairs(p: &ListPage) -> [(&'static str, Option<String>); 2] {
    [
        ("limit", Some(p.limit.to_string())),
        ("offset", Some(p.offset.to_string())),
    ]
}

fn more_line(v: &Value, cmd: &str) -> Option<String> {
    v["next_offset"].as_u64().map(|n| {
        ui::dim(&format!(
            "… {} in all; next page: {cmd} --offset {n}",
            v["total"]
        ))
    })
}

/// A session by id, id prefix or agent session id (prefix).
fn find_session(api: &Api, query: &str) -> Result<Value, Exit> {
    if let Ok(v) = api.get(&format!("/v1/sessions/{query}"), "library") {
        return Ok(v);
    }
    let list = get(api, "/v1/sessions?limit=200")?;
    let items = list["items"].as_array().cloned().unwrap_or_default();
    let cands: Vec<Candidate> = items
        .iter()
        .map(|m| Candidate {
            id: s(m, "id").into(),
            name: s(m, "agent_session_id").into(),
            context: s(m, "project").into(),
        })
        .collect();
    let q = query.to_lowercase();
    let by_agent_id: Vec<usize> = items
        .iter()
        .enumerate()
        .filter(|(_, m)| s(m, "agent_session_id").to_lowercase().starts_with(&q))
        .map(|(i, _)| i)
        .collect();
    let i = if by_agent_id.len() == 1 && q.len() >= 4 {
        by_agent_id[0]
    } else {
        resolve_or_exit("session", query, &cands)?
    };
    get(api, &format!("/v1/sessions/{}", s(&items[i], "id")))
}

pub fn sessions(ctx: &Ctx, action: SessionsAction) -> anyhow::Result<Exit> {
    done((|| {
        let api = connect(ctx)?;
        match action {
            SessionsAction::List {
                project,
                task,
                agent,
                status,
                page,
            } => {
                let project = match project {
                    Some(p) => Some(s(&find_project(&api, &p)?, "id").to_string()),
                    None => None,
                };
                let task = match task {
                    Some(t) => Some(s(&find_task(&all_tasks(&api)?, &t)?, "id").to_string()),
                    None => None,
                };
                let [l, o] = page_pairs(&page);
                let qs = query_string(&[
                    ("project", project),
                    ("bundle", task),
                    ("agent", agent),
                    ("status", status),
                    l,
                    o,
                ]);
                let v = get(&api, &format!("/v1/sessions{qs}"))?;
                ctx.print(&v, || {
                    let items = v["items"].as_array().cloned().unwrap_or_default();
                    if items.is_empty() {
                        return format!("{} no agent sessions match", ui::Mark::Info.sym());
                    }
                    let rows = items
                        .iter()
                        .map(|x| {
                            vec![
                                s(x, "id").to_string(),
                                when(&x["ended_at"]),
                                format!("{} / {}", s(x, "project"), s(x, "bundle")),
                                match x["status"].as_str() {
                                    Some(st) => ui::status(st),
                                    None => ui::dim("no digest"),
                                },
                                x["goal"]
                                    .as_str()
                                    .map(str::to_string)
                                    .unwrap_or_else(|| ui::dim("(no digest yet)")),
                            ]
                        })
                        .collect();
                    let mut out = vec![ui::table(
                        &["ID", "ENDED", "PROJECT / TASK", "DIGEST", "GOAL"],
                        rows,
                    )];
                    out.extend(more_line(&v, "pama sessions list"));
                    out.join("\n")
                });
                Ok(Exit::Ok)
            }
            SessionsAction::Show { session } => {
                let mut v = find_session(&api, &session)?;
                // The device knows its own capture pipeline; the server does not.
                if let Ok(Some(c)) = ctx
                    .store
                    .capture_for_session(s(&v, "agent"), s(&v, "agent_session_id"))
                {
                    v["capture"] = json!({
                        "status": c.status, "error": c.error, "attempts": c.attempts,
                        "transcript_path": c.transcript_path,
                    });
                }
                ctx.print(&v, || session_text(&v));
                Ok(Exit::Ok)
            }
            SessionsAction::Delete { session, yes } => {
                let v = find_session(&api, &session)?;
                let id = s(&v, "id").to_string();
                let links = v["links"].as_array().cloned().unwrap_or_default();
                if !yes {
                    eprintln!(
                        "This deletes session {id} ({} / {}) and its {} digest version(s){}.",
                        s(&v, "project"),
                        s(&v, "bundle"),
                        v["digests"].as_array().map_or(0, Vec::len),
                        if links.is_empty() {
                            String::new()
                        } else {
                            format!("; {} Ask Link(s) use its task or project", links.len())
                        }
                    );
                    eprintln!("Run again with --yes to go ahead.");
                    return Err(Exit::User);
                }
                let r = api
                    .delete(&format!("/v1/sessions/{id}"), "library")
                    .map_err(|e| api_exit(&e))?;
                ctx.print(&r, || {
                    let mut t = format!("deleted session {id}");
                    if r["tombstone"].as_bool() == Some(true) {
                        t.push_str("; its published copy will be deleted at the next sync");
                    }
                    t
                });
                Ok(Exit::Ok)
            }
        }
    })())
}

fn session_text(v: &Value) -> String {
    let mut out = vec![
        format!(
            "{}  {} {}",
            s(v, "id"),
            s(v, "agent"),
            s(v, "agent_session_id")
        ),
        format!("  project {} · task {}", s(v, "project"), s(v, "bundle")),
        format!(
            "  started {} · ended {}",
            when(&v["started_at"]),
            when(&v["ended_at"])
        ),
    ];
    let branches: Vec<String> = v["branches"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| b["name"].as_str().map(String::from))
        .collect();
    out.push(format!("  branches: {}", branches_text(&branches)));
    if let Some(c) = v["capture"].as_object() {
        out.push(format!(
            "  capture on this device: {}{}",
            c.get("status").and_then(Value::as_str).unwrap_or("?"),
            c.get("error")
                .and_then(Value::as_str)
                .map(|e| format!(" ({e})"))
                .unwrap_or_default()
        ));
    }
    out.push("  digests:".into());
    for d in v["digests"].as_array().into_iter().flatten() {
        out.push(format!(
            "    v{}  {}  {}  {}",
            d["version"],
            s(d, "status"),
            s(d, "id"),
            d["goal"].as_str().unwrap_or("")
        ));
    }
    let links = v["links"].as_array().cloned().unwrap_or_default();
    if !links.is_empty() {
        out.push("  Ask Links using it:".into());
        for l in &links {
            out.push(format!("    {}  {}", s(l, "slug"), s(l, "title")));
        }
    }
    out.join("\n")
}

// --- digests -------------------------------------------------------------------------------

pub fn digests(ctx: &Ctx, action: DigestsAction) -> anyhow::Result<Exit> {
    done((|| {
        let api = connect(ctx)?;
        match action {
            DigestsAction::List {
                status,
                project,
                task,
                page,
            } => {
                let project = match project {
                    Some(p) => Some(s(&find_project(&api, &p)?, "id").to_string()),
                    None => None,
                };
                let task = match task {
                    Some(t) => Some(s(&find_task(&all_tasks(&api)?, &t)?, "id").to_string()),
                    None => None,
                };
                let [l, o] = page_pairs(&page);
                let qs = query_string(&[
                    ("status", status),
                    ("project", project),
                    ("bundle", task),
                    l,
                    o,
                ]);
                let v = get(&api, &format!("/v1/digests{qs}"))?;
                ctx.print(&v, || {
                    let items = v["items"].as_array().cloned().unwrap_or_default();
                    if items.is_empty() {
                        return format!("{} no digests match", ui::Mark::Info.sym());
                    }
                    let rows = items
                        .iter()
                        .map(|d| {
                            vec![
                                s(d, "id").to_string(),
                                format!("v{}", d["version"]),
                                ui::status(s(d, "status")),
                                when(&d["created_at"]),
                                format!("{} / {}", s(d, "project"), s(d, "bundle")),
                                d["decisions"].to_string(),
                                s(d, "goal").to_string(),
                            ]
                        })
                        .collect();
                    let mut out = vec![ui::table(
                        &[
                            "ID",
                            "VER",
                            "STATUS",
                            "CREATED",
                            "PROJECT / TASK",
                            "DECISIONS",
                            "GOAL",
                        ],
                        rows,
                    )];
                    out.extend(more_line(&v, "pama digests list"));
                    out.join("\n")
                });
                Ok(Exit::Ok)
            }
            DigestsAction::Show { digest } => {
                let d = get(&api, &format!("/v1/digests/{digest}"))?;
                ctx.print(&d, || digest_text(&d));
                Ok(Exit::Ok)
            }
        }
    })())
}

fn digest_text(d: &Value) -> String {
    let c = &d["content"];
    let mut out = vec![
        format!("{}  v{}  {}", s(d, "id"), d["version"], s(d, "status")),
        format!("goal: {}", s(c, "goal")),
    ];
    let decisions = c["decisions"].as_array().cloned().unwrap_or_default();
    if !decisions.is_empty() {
        out.push("decisions:".into());
        for x in &decisions {
            out.push(format!("  - {}", s(x, "what")));
            if let Some(why) = x["why"].as_str() {
                out.push(format!("    why: {why}"));
            }
        }
    }
    out.push(format!("outcome: {}", s(c, "outcome")));
    let open = strings(&c["open_items"]);
    if !open.is_empty() {
        out.push("open items:".into());
        out.extend(open.iter().map(|o| format!("  - {o}")));
    }
    out.join("\n")
}

// --- search --------------------------------------------------------------------------------

pub fn search(ctx: &Ctx, query: &str, limit: u32) -> anyhow::Result<Exit> {
    if query.trim().is_empty() {
        crate::fail!("usage", "give something to search for");
        return Ok(Exit::User);
    }
    done((|| {
        let api = connect(ctx)?;
        let qs = query_string(&[
            ("q", Some(query.into())),
            ("limit", Some(limit.to_string())),
        ]);
        let v = get(&api, &format!("/v1/search{qs}"))?;
        ctx.print(&v, || {
            let items = v["items"].as_array().cloned().unwrap_or_default();
            if items.is_empty() {
                return format!("nothing found for \"{query}\"");
            }
            items
                .iter()
                .map(|i| {
                    format!(
                        "[{}] {}\n    {} / {} · digest {} v{} · session {}",
                        s(i, "kind"),
                        s(i, "text"),
                        s(i, "project"),
                        s(i, "bundle"),
                        s(i, "digest_id"),
                        i["digest_version"],
                        s(i, "session_id"),
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        });
        Ok(Exit::Ok)
    })())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_drops_repeats_anywhere_and_keeps_order() {
        // `Vec::dedup` would keep all three: the repeat is not next to the first.
        assert_eq!(unique(["01A", "01B", "01A"]), vec!["01A", "01B"]);
        assert_eq!(unique(["01A", "01A"]), vec!["01A"]);
        assert_eq!(
            unique(vec!["s2".to_string(), "s1".into(), "s2".into()]),
            vec!["s2", "s1"]
        );
    }

    #[test]
    fn query_strings_skip_missing_values_and_escape() {
        assert_eq!(
            query_string(&[("q", Some("refund & fee".into())), ("x", None)]),
            "?q=refund+%26+fee"
        );
        assert_eq!(query_string(&[("x", None)]), "");
    }

    #[test]
    fn session_text_lists_versions_branches_and_capture() {
        let v = json!({
            "id": "01S", "agent": "codex", "agent_session_id": "abc", "project": "shop",
            "bundle": "Refunds", "started_at": "2026-10-20T08:00:00Z", "ended_at": null,
            "branches": [{ "name": "feat/a" }, { "name": "fix/b" }],
            "capture": { "status": "submitted", "error": null },
            "digests": [{ "version": 2, "status": "approved", "id": "d2", "goal": "G" }],
            "links": [{ "slug": "abcdefgh", "title": "Refund FAQ" }],
        });
        let t = session_text(&v);
        assert!(t.contains("branches: feat/a, fix/b"));
        assert!(t.contains("capture on this device: submitted"));
        assert!(t.contains("v2  approved  d2  G"));
        assert!(t.contains("abcdefgh  Refund FAQ"));
        assert!(t.contains("started 2026-10-20 08:00 · ended -"));
    }
}
