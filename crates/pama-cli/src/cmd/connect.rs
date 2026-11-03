//! Connections (spec 005): `pama connect <url>` (the one way to connect a server),
//! `pama use local|<url>` (switch home with a preview) and `pama server list|use|forget`.

use pama_core::remote::{self, Home};
use serde_json::json;

use super::Ctx;
use crate::ui::{self, Mark};
use crate::Exit;

pub fn connect(
    ctx: &Ctx,
    url: Option<String>,
    no_browser: bool,
    code: Option<String>,
) -> anyhow::Result<Exit> {
    let url = url.or_else(|| ctx.server.clone());
    match code {
        Some(code) => {
            let Some(server) = url.or_else(|| std::env::var("PAMA_CLOUD_URL").ok()) else {
                crate::fail!("usage", "which server? `pama connect <url> --code <code>`");
                return Ok(Exit::User);
            };
            // Pairing makes the server the default target; in remote mode the default is also
            // home, so keep home where it was and let `pama use` move it (with its preview).
            let home_before = remote::home(&ctx.store);
            let exit = super::sync::pair(ctx, &code, &remote::normalize(&server))?;
            if let Home::Server(prev) = &home_before {
                if remote::home(&ctx.store) != home_before {
                    remote::set_default_server(&ctx.store, prev)?;
                    ui::note(&format!(
                        "home stays {prev}; `pama use {}` moves review and Ask Links there",
                        remote::normalize(&server)
                    ));
                }
            }
            Ok(exit)
        }
        None => super::login::login_to(ctx, url, no_browser),
    }
}

fn parse_home(target: &str) -> Home {
    if target.eq_ignore_ascii_case("local") {
        Home::Local
    } else {
        Home::Server(remote::normalize(target))
    }
}

/// `pama use local|<url>`: show what changes, then switch (asks unless `--yes`).
pub fn use_home(ctx: &Ctx, target: &str, yes: bool) -> anyhow::Result<Exit> {
    let to = parse_home(target);
    let p = remote::preview_switch(&ctx.store, &to)?;
    if p.needs_connect {
        ui::error(
            "not_connected",
            &format!("this machine is not connected to {target}"),
            Some(&format!("run `pama connect {target}` first")),
        );
        return Ok(Exit::Config);
    }
    // A listed server without its device token (e.g. a default set by hand and then listed by
    // `remote::repair`) cannot be used as home: every review call would fail.
    if let Home::Server(u) = &p.to {
        pama_core::secrets::init_platform_store();
        if !pama_core::secrets::exists(&pama_core::sync::token_key(u)).unwrap_or(false) {
            crate::fail!(
                "not_logged_in",
                "no device token for {u}; run `pama connect {u}` again"
            );
            return Ok(Exit::Config);
        }
    }
    if p.unchanged {
        ctx.print(&json!({ "home": p.to, "changed": false }), || {
            format!("{} already using {}", Mark::Ok.sym(), p.to.label())
        });
        return Ok(Exit::Ok);
    }
    if !ctx.json || !yes {
        anstream::eprintln!(
            "{}",
            ui::heading(&format!(
                "Switch from {} to {}:",
                p.from.label(),
                p.to.label()
            ))
        );
        for c in &p.consequences {
            anstream::eprintln!("  {} {c}", ui::dim("•"));
        }
    }
    if !yes && !super::login::ask_yes("Switch?") {
        if ctx.json {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({ "preview": p, "changed": false }))?
            );
        }
        ui::note("not changed (use --yes to switch without asking)");
        return Ok(Exit::User);
    }
    if matches!(to, Home::Local) {
        // Same warning as `pama mode local`: the local server must be installed.
        if let Err(code) = super::login::set_mode(ctx, crate::ModeArg::Local)? {
            return Ok(code);
        }
    } else {
        remote::switch_home(&ctx.store, &to)?;
    }
    ctx.print(
        &json!({ "home": p.to, "changed": true, "preview": p }),
        || format!("{} now using {}", Mark::Ok.sym(), p.to.label()),
    );
    Ok(Exit::Ok)
}

pub fn server_list(ctx: &Ctx) -> anyhow::Result<Exit> {
    let home = remote::home(&ctx.store);
    let default = remote::default_server(&ctx.store);
    let list = remote::servers(&ctx.store);
    pama_core::secrets::init_platform_store();
    let rows: Vec<serde_json::Value> = list
        .iter()
        .map(|s| {
            let token =
                pama_core::secrets::exists(&pama_core::sync::token_key(&s.url)).unwrap_or(false);
            json!({
                "url": s.url,
                "default": default.as_deref() == Some(s.url.as_str()),
                "home": home == Home::Server(s.url.clone()),
                "device_id": s.device_id,
                "workspace_id": s.workspace_id,
                "token": token,
            })
        })
        .collect();
    ctx.print(&json!({ "home": home, "servers": rows }), || {
        let mut out = ui::kv(&[("home", home.label())]);
        if rows.is_empty() {
            out.push_str(&format!(
                "\n\n{} no servers; connect one with {}",
                Mark::Info.sym(),
                ui::cmd("pama connect <url>")
            ));
            return out;
        }
        let table = rows
            .iter()
            .map(|r| {
                vec![
                    r["url"].as_str().unwrap_or("").to_string(),
                    if r["default"] == true {
                        Mark::Ok.label("default")
                    } else {
                        String::new()
                    },
                    if r["home"] == true {
                        "home".to_string()
                    } else {
                        String::new()
                    },
                    if r["token"] == true {
                        Mark::Ok.label("connected")
                    } else {
                        format!(
                            "{} {}",
                            Mark::Fail.label("no token"),
                            ui::dim("→ `pama connect` again")
                        )
                    },
                ]
            })
            .collect();
        out.push_str("\n\n");
        out.push_str(&ui::table(&["SERVER", "DEFAULT", "HOME", "DEVICE"], table));
        out
    });
    Ok(Exit::Ok)
}

pub fn server_use(ctx: &Ctx, url: &str) -> anyhow::Result<Exit> {
    let url = remote::normalize(url);
    if !remote::set_default_server(&ctx.store, &url)? {
        crate::fail!(
            "not_logged_in",
            "not connected to {url}; run `pama connect {url}`"
        );
        return Ok(Exit::Config);
    }
    let home = remote::home(&ctx.store);
    ctx.print(&json!({ "default": url, "home": home }), || {
        let mut out = format!("{} default server: {url}", Mark::Ok.sym());
        if home == Home::Local {
            out.push_str(&format!(
                "\nhome is still this machine; `pama use {url}` moves review and Ask Links there"
            ));
        }
        out
    });
    Ok(Exit::Ok)
}

pub fn server_forget(ctx: &Ctx, url: &str, discard_pending: bool) -> anyhow::Result<Exit> {
    let url = remote::normalize(url);
    if remote::server_entry(&ctx.store, &url).is_none() {
        crate::fail!("not_logged_in", "not connected to {url}");
        return Ok(Exit::User);
    }
    super::login::logout_from(ctx, Some(url), discard_pending)
}
