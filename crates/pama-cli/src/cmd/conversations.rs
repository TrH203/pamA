//! `pama conversations list|show|reply|delete` and `pama chat` (spec 008b).
//!
//! `pama chat` is the owner's "ask my agent": a multi-turn REPL over all approved work or a chosen
//! scope, through the same answer pipeline (scope, cite-or-refuse, guard) as Ask Links.

use std::io::{BufRead, IsTerminal, Write};

use pama_core::client::{Api, ApiError};
use serde_json::{json, Value};

use super::link::source_ref;
use super::{api_exit, Ctx};
use crate::{ChatArgs, ConversationOriginArg, ConversationStatusArg, ConversationsAction, Exit};

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}

/// Percent-encode a query value (RFC 3986 unreserved characters pass through).
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// `/v1/conversations?…` for the list filters.
pub(crate) fn list_path(
    link: Option<&str>,
    asker: Option<&str>,
    status: Option<ConversationStatusArg>,
    origin: Option<ConversationOriginArg>,
    limit: u32,
    offset: u32,
) -> String {
    let mut q = vec![format!("limit={limit}"), format!("offset={offset}")];
    if let Some(l) = link {
        q.push(format!("link={}", encode(l)));
    }
    if let Some(a) = asker {
        q.push(format!("asker={}", encode(a)));
    }
    if let Some(s) = status {
        q.push(format!(
            "status={}",
            match s {
                ConversationStatusArg::Open => "open",
                ConversationStatusArg::Archived => "archived",
                ConversationStatusArg::NeedsReply => "needs_reply",
            }
        ));
    }
    if let Some(o) = origin {
        q.push(format!(
            "origin={}",
            match o {
                ConversationOriginArg::Link => "link",
                ConversationOriginArg::OwnerChat => "owner_chat",
                ConversationOriginArg::Hotkey => "hotkey",
            }
        ));
    }
    format!("/v1/conversations?{}", q.join("&"))
}

pub(crate) fn format_list(v: &Value) -> String {
    use crate::ui::{self, Mark};
    let rows: Vec<Vec<String>> = v["items"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let wait = c["needs_reply"].as_i64().unwrap_or(0);
            let source = match str_of(c, "origin") {
                "link" => format!(
                    "{} {}",
                    c["link_title"].as_str().unwrap_or("link"),
                    ui::dim(c["asker_email"].as_str().unwrap_or("anonymous"))
                ),
                "owner_chat" => "chat".to_string(),
                o => o.to_string(),
            };
            vec![
                str_of(c, "id").to_string(),
                str_of(c, "last_at").get(..16).unwrap_or("").to_string(),
                c["turns"].as_i64().unwrap_or(0).to_string(),
                if wait > 0 {
                    Mark::Warn.label(&format!("{wait} waiting for you"))
                } else if str_of(c, "status") == "archived" {
                    Mark::Info.label("archived")
                } else {
                    String::new()
                },
                source,
                str_of(c, "title").to_string(),
            ]
        })
        .collect();
    if rows.is_empty() {
        return format!("{} no conversations", Mark::Info.sym());
    }
    let mut out = ui::table(&["ID", "LAST", "TURNS", "STATE", "FROM", "TITLE"], rows);
    if let Some(n) = v["next_offset"].as_u64() {
        out.push_str(&format!("\n\n{}", ui::dim(&format!("more: --offset {n}"))));
    }
    out
}

fn citations_text(cites: &Value) -> String {
    cites
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(n, c)| {
            let what = c["label"]
                .as_str()
                .or_else(|| c["text"].as_str())
                .unwrap_or_else(|| str_of(c, "item_id"));
            format!("\n    [{}] {what}", n + 1)
        })
        .collect()
}

pub(crate) fn format_turns(v: &Value) -> String {
    let mut out = format!(
        "{}  {}{}\n",
        str_of(v, "id"),
        str_of(v, "title"),
        v["link_title"]
            .as_str()
            .map(|t| format!("  (link: {t})"))
            .unwrap_or_default()
    );
    for t in v["turns"].as_array().into_iter().flatten() {
        out.push_str(&format!(
            "\n{}  {}\n  Q: {}\n",
            str_of(t, "created_at").get(..16).unwrap_or(""),
            str_of(t, "id"),
            str_of(t, "question")
        ));
        match t["answer"].as_str() {
            Some(a) if !a.is_empty() && t["status"] != "refused" => {
                out.push_str(&format!("  A: {a}{}\n", citations_text(&t["citations"])));
            }
            _ => out.push_str(&format!(
                "  ({}{})\n",
                str_of(t, "status"),
                t["reason"]
                    .as_str()
                    .map(|r| format!(": {r}"))
                    .unwrap_or_default()
            )),
        }
        if let Some(r) = t["owner_reply"].as_str() {
            out.push_str(&format!("  You replied: {r}\n"));
        }
    }
    out
}

/// One chat answer: the text and its citations, or why there is none.
pub(crate) fn format_answer(v: &Value) -> String {
    if str_of(v, "status") == "answered" {
        format!("{}{}", str_of(v, "answer"), citations_text(&v["citations"]))
    } else {
        let why = match str_of(v, "reason") {
            "out_of_scope" => "nothing in your approved notes answers this",
            "low_confidence" => "your notes only partly answer this",
            "denied_topic" => "this touches a denied topic",
            "guard_failed" => "the answer was held back by the safety check",
            other => other,
        };
        format!("(no answer: {why})")
    }
}

pub(crate) fn chat_body(question: &str, conversation: Option<&str>, scope: &[String]) -> Value {
    let mut b = json!({ "question": question });
    if let Some(c) = conversation {
        b["conversation_id"] = json!(c);
    } else if !scope.is_empty() {
        b["scope"] = Value::Array(scope.iter().map(|s| source_ref(s)).collect());
    }
    b
}

fn with_api(
    ctx: &Ctx,
    f: impl FnOnce(&Api) -> Result<(Value, String), ApiError>,
) -> anyhow::Result<Exit> {
    let api = match ctx.api() {
        Ok(a) => a,
        Err(e) => return Ok(api_exit(&e)),
    };
    match f(&api) {
        Ok((v, text)) => {
            ctx.print(&v, || text);
            Ok(Exit::Ok)
        }
        Err(e) => Ok(api_exit(&e)),
    }
}

pub fn run(ctx: &Ctx, action: ConversationsAction) -> anyhow::Result<Exit> {
    match action {
        ConversationsAction::List {
            link,
            asker,
            status,
            origin,
            limit,
            offset,
        } => {
            let path = list_path(
                link.as_deref(),
                asker.as_deref(),
                status,
                origin,
                limit,
                offset,
            );
            with_api(ctx, |api| {
                api.get(&path, "conversations.list").map(|v| {
                    let t = format_list(&v);
                    (v, t)
                })
            })
        }
        ConversationsAction::Show { id } => with_api(ctx, |api| {
            api.get(
                &format!("/v1/conversations/{}", encode(&id)),
                "conversations.show",
            )
            .map(|v| {
                let t = format_turns(&v);
                (v, t)
            })
        }),
        ConversationsAction::Reply { id, text, ask_id } => with_api(ctx, |api| {
            let mut body = json!({ "text": text });
            if let Some(a) = ask_id {
                body["ask_id"] = json!(a);
            }
            api.post(
                &format!("/v1/conversations/{}/reply", encode(&id)),
                "conversations.reply",
                &body,
            )
            .map(|v| (v, "reply sent; it appears on the link page".into()))
        }),
        ConversationsAction::Delete { id } => with_api(ctx, |api| {
            api.delete(
                &format!("/v1/conversations/{}", encode(&id)),
                "conversations.delete",
            )
            .map(|_| (json!({ "id": id, "deleted": true }), "deleted".into()))
        }),
    }
}

pub fn chat(ctx: &Ctx, args: ChatArgs) -> anyhow::Result<Exit> {
    let api = match ctx.api() {
        Ok(a) => a,
        Err(e) => return Ok(api_exit(&e)),
    };
    // Single shot: one question, one answer (the only form with --json).
    if let Some(q) = &args.question {
        let body = chat_body(q, args.conversation.as_deref(), &args.scope);
        let spin = crate::ui::spinner(ctx.json, "thinking…");
        let res = api.post_slow("/v1/chat", "chat.ask", &body);
        spin.finish();
        return match res {
            Ok(v) => {
                ctx.print(&v, || {
                    format!(
                        "{}\n\ncontinue: pama chat --conversation {}",
                        format_answer(&v),
                        str_of(&v, "conversation_id")
                    )
                });
                Ok(Exit::Ok)
            }
            Err(e) => Ok(api_exit(&e)),
        };
    }
    if ctx.json {
        crate::fail!(
            "usage",
            "--json needs a question: pama chat --json -q \"…\""
        );
        return Ok(Exit::User);
    }

    let tty = std::io::stdin().is_terminal();
    if tty {
        eprintln!(
            "Ask your agent about your approved work{}. /new starts over, /link makes an Ask Link \
             from this chat, /quit leaves.",
            if args.scope.is_empty() {
                ""
            } else {
                " (scoped)"
            }
        );
    }
    let mut conversation = args.conversation.clone();
    let stdin = std::io::stdin();
    loop {
        if tty {
            eprint!("\nyou › ");
            let _ = std::io::stderr().flush();
        }
        let mut line = String::new();
        if stdin.lock().read_line(&mut line)? == 0 {
            break;
        }
        let line = line.trim();
        match line {
            "" => continue,
            "/quit" | "/exit" => break,
            "/new" => {
                conversation = None;
                eprintln!("(new chat)");
                continue;
            }
            "/link" => {
                let Some(id) = &conversation else {
                    eprintln!("(ask something first)");
                    continue;
                };
                match api.post(
                    &format!("/v1/chat/{}/link", encode(id)),
                    "chat.link",
                    &json!({}),
                ) {
                    Ok(v) => println!(
                        "Ask Link: {}{}",
                        str_of(&v, "url"),
                        v["pin"]
                            .as_str()
                            .map(|p| format!("  (PIN {p})"))
                            .unwrap_or_default()
                    ),
                    Err(e) => crate::fail!("error", "{e}"),
                }
                continue;
            }
            _ => {}
        }
        let body = chat_body(line, conversation.as_deref(), &args.scope);
        let spin = crate::ui::spinner(!tty, "thinking…");
        let res = api.post_slow("/v1/chat", "chat.ask", &body);
        spin.finish();
        match res {
            Ok(v) => {
                if let Some(id) = v["conversation_id"].as_str() {
                    conversation = Some(id.to_string());
                }
                crate::ui::out(&format_answer(&v));
            }
            Err(e) => {
                let code = api_exit(&e);
                if code == Exit::Network || code == Exit::Config {
                    return Ok(code);
                }
            }
        }
    }
    if let (Some(id), true) = (&conversation, tty) {
        eprintln!("\ncontinue later: pama chat --conversation {id}");
    }
    Ok(Exit::Ok)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_path_encodes_filters() {
        let p = list_path(
            Some("abc"),
            Some("minh+x@example.com"),
            Some(ConversationStatusArg::NeedsReply),
            Some(ConversationOriginArg::OwnerChat),
            20,
            40,
        );
        assert_eq!(
            p,
            "/v1/conversations?limit=20&offset=40&link=abc&asker=minh%2Bx%40example.com&status=needs_reply&origin=owner_chat"
        );
        assert_eq!(
            list_path(None, None, None, None, 50, 0),
            "/v1/conversations?limit=50&offset=0"
        );
    }

    #[test]
    fn chat_body_scope_only_when_starting() {
        let scope = vec!["bundle:b1".to_string(), "project:p1".to_string()];
        assert_eq!(
            chat_body("why?", None, &scope),
            json!({ "question": "why?", "scope": [
                { "type": "bundle", "id": "b1" }, { "type": "project", "id": "p1" }
            ] })
        );
        assert_eq!(
            chat_body("why?", Some("C1"), &scope),
            json!({ "question": "why?", "conversation_id": "C1" })
        );
        assert_eq!(chat_body("hi", None, &[]), json!({ "question": "hi" }));
    }

    #[test]
    fn answer_shows_citations_or_reason() {
        let a = json!({
            "status": "answered",
            "answer": "No, shipping is not refunded.",
            "citations": [{ "item_id": "i1", "label": "decision · feat/refund" }]
        });
        assert_eq!(
            format_answer(&a),
            "No, shipping is not refunded.\n    [1] decision · feat/refund"
        );
        let r = json!({ "status": "refused", "reason": "out_of_scope" });
        assert!(format_answer(&r).contains("nothing in your approved notes"));
    }

    #[test]
    fn list_and_turns_format() {
        let list = json!({
            "items": [{
                "id": "C1", "origin": "link", "link_title": "Refunds", "asker_email": null,
                "title": "Do refunds include shipping?", "status": "open",
                "last_at": "2026-10-31T10:00:00.000Z", "turns": 2, "needs_reply": 1
            }],
            "next_offset": 50
        });
        let t = crate::ui::plain(&format_list(&list));
        let row = t.lines().nth(1).unwrap_or_default();
        for cell in [
            "C1",
            "2026-10-31T10:00",
            "! 1 waiting for you",
            "Refunds anonymous",
            "Do refunds include shipping?",
        ] {
            assert!(row.contains(cell), "{cell} missing: {t}");
        }
        assert!(t.ends_with("more: --offset 50"));
        assert_eq!(
            crate::ui::plain(&format_list(&json!({ "items": [] }))),
            "· no conversations"
        );

        let conv = json!({
            "id": "C1", "title": "Refunds", "link_title": "Refunds",
            "turns": [
                { "id": "A1", "question": "Shipping?", "status": "answered", "answer": "No.",
                  "citations": [{ "item_id": "i1", "text": "Refunds do not include shipping." }],
                  "created_at": "2026-10-31T10:00:00Z", "owner_reply": null },
                { "id": "A2", "question": "Weather?", "status": "forwarded", "reason": "out_of_scope",
                  "answer": null, "citations": [], "created_at": "2026-10-31T10:01:00Z",
                  "owner_reply": "Sunny." }
            ]
        });
        let t = format_turns(&conv);
        assert!(t.contains("  A: No.\n    [1] Refunds do not include shipping."));
        assert!(t.contains("  (forwarded: out_of_scope)"));
        assert!(t.contains("  You replied: Sunny."));
    }
}
