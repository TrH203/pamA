//! Connections (spec 005): `pama connect <url>` (the one way to connect a server),
//! `pama use local|<url>` (switch home with a preview) and `pama server list|use|forget`.

use pama_core::remote::{self, Home};
use serde_json::json;

use super::Ctx;
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
                eprintln!("error: which server? `pama connect <url> --code <code>`");
                return Ok(Exit::User);
            };
            super::sync::pair(ctx, &code, &remote::normalize(&server))
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
        eprintln!(
            "error: this machine is not connected to {target}; run `pama connect {target}` first"
        );
        return Ok(Exit::Config);
    }
    if p.unchanged {
        ctx.print(&json!({ "home": p.to, "changed": false }), || {
            format!("already using {}", p.to.label())
        });
        return Ok(Exit::Ok);
    }
    if !ctx.json || !yes {
        eprintln!("Switch from {} to {}:", p.from.label(), p.to.label());
        for c in &p.consequences {
            eprintln!("  • {c}");
        }
    }
    if !yes && !super::login::ask_yes("Switch?") {
        if ctx.json {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({ "preview": p, "changed": false }))?
            );
        }
        eprintln!("not changed (use --yes to switch without asking)");
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
        || format!("now using {}", p.to.label()),
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
        let mut out = format!("home: {}", home.label());
        if rows.is_empty() {
            out.push_str("\nno servers; connect one with `pama connect <url>`");
        }
        for r in &rows {
            out.push_str(&format!(
                "\n{} {}{}{}",
                if r["default"] == true { "●" } else { "○" },
                r["url"].as_str().unwrap_or(""),
                if r["home"] == true { "  (home)" } else { "" },
                if r["token"] == true {
                    ""
                } else {
                    "  (no token: `pama connect` again)"
                }
            ));
        }
        out
    });
    Ok(Exit::Ok)
}

pub fn server_use(ctx: &Ctx, url: &str) -> anyhow::Result<Exit> {
    let url = remote::normalize(url);
    if !remote::set_default_server(&ctx.store, &url)? {
        eprintln!("error: not connected to {url}; run `pama connect {url}`");
        return Ok(Exit::Config);
    }
    let home = remote::home(&ctx.store);
    ctx.print(&json!({ "default": url, "home": home }), || {
        let mut out = format!("default server: {url}");
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
        eprintln!("error: not connected to {url}");
        return Ok(Exit::User);
    }
    super::login::logout_from(ctx, Some(url), discard_pending)
}
