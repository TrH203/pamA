//! OpenCode sessions (spec 005 research). OpenCode 1.2+ keeps sessions in SQLite at
//! `$XDG_DATA_HOME/opencode/opencode.db` (default `~/.local/share/opencode`): tables `session`
//! (`id`, `directory`, `version`, `time_created`, `time_updated`), `message` (`id`, `session_id`,
//! `data`) and `part` (`id`, `message_id`, `data`), where `data` is the JSON each record had in
//! the older file layout: `storage/session/<project>/<id>.json`,
//! `storage/message/<session>/<id>.json`, `storage/part/<message>/<id>.json`. Both are read.
//!
//! A session is addressed by a location string: the legacy session file, or `<db>#<session id>`.
//! The database is opened read-only; nothing is written to OpenCode's files.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;

use super::cursor::tool_event;
use super::event::{truncate, Event, EventKind, NormalizedSession, SessionMeta, MAX_RESULT_CHARS};
use super::reader::ReadError;
use crate::digest::Agent;

pub const DB_FILE: &str = "opencode.db";

/// `$XDG_DATA_HOME/opencode`, `$OPENCODE_DATA_DIR`, or `~/.local/share/opencode`.
pub fn data_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("OPENCODE_DATA_DIR") {
        return Some(PathBuf::from(d));
    }
    if let Some(d) = std::env::var_os("XDG_DATA_HOME") {
        return Some(PathBuf::from(d).join("opencode"));
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|h| PathBuf::from(h).join(".local/share/opencode"))
}

/// A session OpenCode knows about: id, location string, last update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub id: String,
    pub location: String,
    pub updated: SystemTime,
}

fn ms_time(ms: i64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(ms.max(0) as u64)
}

fn ms_rfc3339(ms: i64) -> String {
    crate::capture::worker::rfc3339(ms_time(ms))
}

fn io(p: &Path, e: impl std::fmt::Display) -> ReadError {
    ReadError::Io(
        p.display().to_string(),
        std::io::Error::other(e.to_string()),
    )
}

fn open_ro(db: &Path) -> Result<Connection, ReadError> {
    let c = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| io(db, e))?;
    let _ = c.busy_timeout(Duration::from_secs(2));
    Ok(c)
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

fn json_files(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|r| {
            r.flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "json"))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

/// Every session in a data dir (database first; legacy files only for ids the database lacks).
pub fn sessions(data: &Path) -> Vec<Found> {
    let mut out: Vec<Found> = Vec::new();
    let db = data.join(DB_FILE);
    if db.is_file() {
        if let Ok(c) = open_ro(&db) {
            if let Ok(mut st) = c.prepare("SELECT id, time_updated FROM session") {
                let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)));
                if let Ok(rows) = rows {
                    for (id, upd) in rows.flatten() {
                        out.push(Found {
                            location: format!("{}#{id}", db.display()),
                            id,
                            updated: ms_time(upd),
                        });
                    }
                }
            }
        }
    }
    let legacy = data.join("storage/session");
    if let Ok(projects) = std::fs::read_dir(&legacy) {
        for p in projects.flatten() {
            for f in json_files(&p.path()) {
                let Some(v) = read_json(&f) else { continue };
                let Some(id) = v["id"].as_str().map(String::from) else {
                    continue;
                };
                if out.iter().any(|x| x.id == id) {
                    continue;
                }
                let updated = v["time"]["updated"]
                    .as_i64()
                    .map(ms_time)
                    .or_else(|| std::fs::metadata(&f).and_then(|m| m.modified()).ok())
                    .unwrap_or(UNIX_EPOCH);
                out.push(Found {
                    id,
                    location: f.to_string_lossy().into_owned(),
                    updated,
                });
            }
        }
    }
    out
}

/// Where a session id lives (hook input carries only the id). Runs in the plugin's hook after
/// every turn, so it looks the one id up instead of listing every session: a keyed query on the
/// database, else `storage/session/*/<id>.json` by file name.
pub fn locate(data: &Path, session_id: &str) -> Option<String> {
    if session_id.is_empty() || session_id.contains(['/', '\\', '#']) || session_id.contains("..") {
        return None;
    }
    let db = data.join(DB_FILE);
    if db.is_file() {
        if let Ok(c) = open_ro(&db) {
            let hit: Option<String> = c
                .query_row("SELECT id FROM session WHERE id = ?1", [session_id], |r| {
                    r.get(0)
                })
                .optional()
                .ok()
                .flatten();
            if hit.is_some() {
                return Some(format!("{}#{session_id}", db.display()));
            }
        }
    }
    let file = format!("{session_id}.json");
    std::fs::read_dir(data.join("storage/session"))
        .ok()?
        .flatten()
        .map(|p| p.path().join(&file))
        .find(|f| f.is_file())
        .map(|f| f.to_string_lossy().into_owned())
}

/// The session id of a location string.
pub fn session_id_of(location: &str) -> String {
    match location.rsplit_once('#') {
        Some((_, id)) if location.contains(".db#") => id.to_string(),
        _ => Path::new(location)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// One message with its parts, as OpenCode's JSON records.
struct Msg {
    info: Value,
    parts: Vec<Value>,
}

fn load_db(db: &Path, id: &str) -> Result<(Value, Vec<Msg>), ReadError> {
    let c = open_ro(db)?;
    let info: Option<Value> = c
        .query_row(
            "SELECT directory, version, time_created, time_updated FROM session WHERE id = ?1",
            [id],
            |r| {
                Ok(serde_json::json!({
                    "id": id,
                    "directory": r.get::<_, Option<String>>(0)?,
                    "version": r.get::<_, Option<String>>(1)?,
                    "time": { "created": r.get::<_, Option<i64>>(2)?, "updated": r.get::<_, Option<i64>>(3)? },
                }))
            },
        )
        .optional()
        .map_err(|e| io(db, e))?;
    let info = info.ok_or_else(|| io(db, format!("session {id} not found")))?;
    let mut st = c
        .prepare("SELECT id, data FROM message WHERE session_id = ?1")
        .map_err(|e| io(db, e))?;
    let msgs: Vec<(String, String)> = st
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| io(db, e))?
        .flatten()
        .collect();
    let mut pst = c
        .prepare("SELECT data FROM part WHERE message_id = ?1 ORDER BY id")
        .map_err(|e| io(db, e))?;
    let mut out = Vec::new();
    for (mid, data) in msgs {
        let mut m: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        m["id"] = Value::String(mid.clone());
        let parts = pst
            .query_map([&mid], |r| r.get::<_, String>(0))
            .map_err(|e| io(db, e))?
            .flatten()
            .filter_map(|d| serde_json::from_str(&d).ok())
            .collect();
        out.push(Msg { info: m, parts });
    }
    Ok((info, out))
}

fn load_legacy(file: &Path) -> Result<(Value, Vec<Msg>), ReadError> {
    let info = read_json(file).ok_or_else(|| io(file, "not a session file"))?;
    let id = info["id"].as_str().unwrap_or_default().to_string();
    // <data>/storage/session/<project>/<id>.json → <data>/storage
    let storage = file
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| io(file, "unexpected layout"))?;
    let mut out = Vec::new();
    for mf in json_files(&storage.join("message").join(&id)) {
        let Some(m) = read_json(&mf) else { continue };
        let mid = m["id"].as_str().unwrap_or_default().to_string();
        let parts = json_files(&storage.join("part").join(&mid))
            .iter()
            .filter_map(|p| read_json(p))
            .collect();
        out.push(Msg { info: m, parts });
    }
    Ok((info, out))
}

pub fn parse(location: &str) -> Result<NormalizedSession, ReadError> {
    let (info, mut msgs) = match location.rsplit_once('#') {
        Some((db, id)) if db.ends_with(".db") => load_db(Path::new(db), id)?,
        _ => load_legacy(Path::new(location))?,
    };
    msgs.sort_by(|a, b| {
        (a.info["time"]["created"].as_i64(), a.info["id"].as_str())
            .cmp(&(b.info["time"]["created"].as_i64(), b.info["id"].as_str()))
    });
    let mut meta = SessionMeta::new(
        Agent::OpenCode,
        info["id"].as_str().unwrap_or_default().to_string(),
    );
    meta.cwd = info["directory"].as_str().map(String::from);
    meta.agent_version = info["version"].as_str().map(String::from);
    if let Some(t) = info["time"]["created"].as_i64() {
        meta.saw_time(Some(&ms_rfc3339(t)));
    }
    let mut events = Vec::new();
    for m in &msgs {
        let kind = match m.info["role"].as_str() {
            Some("user") => EventKind::User,
            Some("assistant") => EventKind::Assistant,
            _ => continue,
        };
        let at = m.info["time"]["created"].as_i64().map(ms_rfc3339);
        meta.saw_time(at.as_deref());
        if meta.cwd.is_none() {
            meta.cwd = m.info["path"]["cwd"].as_str().map(String::from);
        }
        for p in &m.parts {
            match p["type"].as_str() {
                Some("text") => {
                    // Synthetic parts are context OpenCode injected, not the conversation.
                    if p["synthetic"].as_bool() == Some(true) {
                        continue;
                    }
                    if let Some(t) = p["text"].as_str().filter(|t| !t.trim().is_empty()) {
                        events.push(Event::text(kind, t, at.clone()));
                    }
                }
                Some("tool") => {
                    let name = p["tool"].as_str().unwrap_or("tool");
                    let state = &p["state"];
                    let call_id = p["callID"].as_str().map(String::from);
                    let call = tool_event(
                        name,
                        state.get("input").unwrap_or(&Value::Null),
                        call_id.clone(),
                        at.clone(),
                    );
                    let output = state["output"]
                        .as_str()
                        .or_else(|| state["error"].as_str())
                        .map(String::from);
                    let (tool, path, command) =
                        (call.tool.clone(), call.path.clone(), call.command.clone());
                    events.push(call);
                    if let Some(o) = output {
                        events.push(Event {
                            kind: EventKind::ToolResult,
                            text: truncate(&o, MAX_RESULT_CHARS),
                            tool,
                            path,
                            command,
                            call_id,
                            at: at.clone(),
                        });
                    }
                }
                _ => {} // reasoning, step-start/finish, snapshots, patches, files
            }
        }
    }
    Ok(NormalizedSession {
        meta,
        events,
        skipped_lines: 0,
    })
}
