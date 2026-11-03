//! Command implementations (contracts/cli.md).

mod activity;
mod agents;
mod bundle_fmt;
mod capture;
mod config;
mod connect;
mod conversations;
mod doctor;
mod hook;
mod inbox;
mod init;
mod keys;
mod library;
mod link;
mod login;
mod model;
mod resolve;
mod review;
mod scan;
mod server;
mod status;
mod sync;

use pama_core::client::{Api, ApiError};
use pama_core::store::Store;

use crate::{Cli, Command, Exit};

pub struct Ctx {
    pub json: bool,
    pub store: Store,
    /// `--server`: a remote server for this command.
    pub server: Option<String>,
}

impl Ctx {
    /// The server an owner command talks to (`Api::resolve`). For a remote server, review
    /// decisions made there are pulled into the device copies first (at most once a minute).
    pub fn api(&self) -> Result<Api<'_>, ApiError> {
        pama_core::secrets::init_platform_store();
        let api = Api::resolve(&self.store, "cli", self.server.as_deref())?;
        if api.remote_url().is_some() {
            if let Err(e) = pama_core::remote::pull_changes(&self.store, &api, false) {
                if matches!(e, ApiError::Status { status: 401, .. }) {
                    return Err(ApiError::NotLoggedIn(
                        api.remote_url().unwrap_or_default().to_string(),
                    ));
                }
            }
        }
        Ok(api)
    }

    pub fn print(&self, value: &serde_json::Value, human: impl FnOnce() -> String) {
        if self.json {
            println!("{}", serde_json::to_string_pretty(value).expect("json"));
        } else {
            let text = human();
            if !text.is_empty() {
                crate::ui::out(&text);
            }
        }
    }
}

/// Map API failures to the exit codes of contracts/cli.md.
pub fn api_exit(e: &ApiError) -> Exit {
    print_api_error(e);
    match e {
        ApiError::NotRunning | ApiError::Net(_) => Exit::Network,
        ApiError::NotLoggedIn(_) => Exit::Config,
        ApiError::Status {
            status: 401 | 403, ..
        } => Exit::Config,
        ApiError::Status { status, .. } if *status >= 500 => Exit::Network,
        ApiError::Status { .. } => Exit::User,
    }
}

/// `✗ <code>: <message>` and `→ <fix>` for an API failure.
pub fn print_api_error(e: &ApiError) {
    let (code, message, fix) = describe_api_error(e);
    crate::ui::error(&code, &message, fix.as_deref());
}

fn describe_api_error(e: &ApiError) -> (String, String, Option<String>) {
    use pama_core::capture::errors::ErrorCode;
    match e {
        ApiError::NotRunning => (
            "server_down".into(),
            "the local server is not running".into(),
            Some("`pama server start` (or open the pamA app)".into()),
        ),
        ApiError::Net(n) => (
            "network".into(),
            n.to_string(),
            Some("check the network and `pama status`".into()),
        ),
        ApiError::NotLoggedIn(url) => (
            "not_logged_in".into(),
            format!("not connected to {url}"),
            Some(format!("`pama connect {url}`")),
        ),
        ApiError::Status { status, body } => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let code = v["error"]["code"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!("http_{status}"));
            let message = v["error"]["message"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| e.to_string());
            let fix = v["error"]["fix"]
                .as_str()
                .map(str::to_string)
                .or_else(|| ErrorCode::parse(&code).map(|c| c.hint().to_string()))
                .or_else(|| match status {
                    401 | 403 => Some("`pama connect <url>` to sign this device in again".into()),
                    _ => None,
                });
            (code, message, fix)
        }
    }
}

pub fn run(cli: Cli) -> anyhow::Result<Exit> {
    let store = Store::open(&pama_core::paths::device_db())?;
    // Keep the default server and the server list consistent (spec 005).
    let _ = pama_core::remote::repair(&store);
    let ctx = Ctx {
        json: cli.global.json,
        store,
        server: cli.global.server.clone(),
    };
    // Retries further away than a drain waits (30 m, 2 h, 6 h) run when an owner command
    // notices they are due (spec 006; CLI-only installs have no desktop drain).
    if cli.command.as_ref().is_none_or(kicks_drain) {
        capture::kick_due(&ctx);
    }
    let Some(command) = cli.command else {
        return status::run(&ctx);
    };
    match command {
        Command::Status => status::run(&ctx),
        Command::Activity {
            failed,
            follow,
            limit,
            action,
        } => activity::run(&ctx, failed, follow, limit, action),
        Command::Logs {
            source,
            lines,
            follow,
        } => activity::logs(&ctx, source, lines, follow),
        Command::Hook { agent } => hook::run(&ctx, agent),
        Command::Capture { action } => capture::run(&ctx, action),
        Command::Init {
            project,
            agent,
            global,
            project_scope,
            mode,
            sync,
        } => init::run(&ctx, project, agent, global, project_scope, mode, sync),
        Command::Connect {
            url,
            no_browser,
            code,
        } => connect::connect(&ctx, url, no_browser, code),
        Command::Use { target, yes } => connect::use_home(&ctx, &target, yes),
        Command::Keys { action } => keys::run(&ctx, action),
        Command::Agents { action } => agents::run(&ctx, action),
        Command::Login { no_browser } => {
            crate::ui::note("`pama login` is deprecated; use `pama connect <url>`");
            login::login(&ctx, no_browser)
        }
        Command::Logout { discard_pending } => login::logout(&ctx, discard_pending),
        Command::Mode { mode } => login::mode(&ctx, mode),
        Command::Scan { since } => scan::run(&ctx, since),
        Command::Review {
            approve,
            discard,
            edit,
        } => review::run(&ctx, approve, discard, edit),
        Command::Server { action } => server::run(&ctx, action),
        Command::Console { print } => server::console(&ctx, print),
        Command::Config { action } => config::run(&ctx, action),
        Command::Link { action } => link::run(&ctx, action),
        Command::Model { device, action } => model::run(&ctx, device, action),
        Command::Inbox => inbox::inbox(&ctx),
        Command::Reply { ask_id, text } => inbox::reply(&ctx, &ask_id, &text),
        Command::Log { link, status } => inbox::log(&ctx, link, status),
        Command::Pair { code, server } => {
            crate::ui::note("`pama pair` is deprecated; use `pama connect {server} --code <code>`");
            sync::pair(&ctx, &code, &server)
        }
        Command::Conversations { action } => conversations::run(&ctx, action),
        Command::Chat(args) => conversations::chat(&ctx, args),
        Command::Sync { action } => sync::run(&ctx, action),
        Command::Tasks { action } => library::tasks(&ctx, action),
        Command::Sessions { action } => library::sessions(&ctx, action),
        Command::Digests { action } => library::digests(&ctx, action),
        Command::Search { query, limit } => library::search(&ctx, &query.join(" "), limit),
        Command::Doctor { report } => doctor::run(&ctx, report),
    }
}

/// Owner commands that start a drain for due captures. Not the hook and the drain themselves,
/// and not commands that change the server, mode or login (a drain would act on the old one).
fn kicks_drain(c: &Command) -> bool {
    matches!(
        c,
        Command::Status
            | Command::Activity { .. }
            | Command::Logs { .. }
            | Command::Scan { .. }
            | Command::Review { .. }
            | Command::Inbox
            | Command::Reply { .. }
            | Command::Log { .. }
            | Command::Sync { .. }
            | Command::Tasks { .. }
            | Command::Sessions { .. }
            | Command::Digests { .. }
            | Command::Search { .. }
            | Command::Conversations { .. }
            | Command::Chat(..)
            | Command::Doctor { .. }
    )
}

/// `30m`, `2h`, `7d` → seconds.
pub fn parse_duration(s: &str) -> Option<u64> {
    let (n, unit) = s.split_at(s.find(|c: char| !c.is_ascii_digit())?);
    let n: u64 = n.parse().ok()?;
    Some(match unit {
        "s" => n,
        "m" => n * 60,
        "h" => n * 3_600,
        "d" => n * 86_400,
        _ => return None,
    })
}

/// Read a secret from stdin: a prompt without echo on a terminal, otherwise the first line.
pub fn read_secret(key: &str) -> anyhow::Result<String> {
    use std::io::{BufRead, IsTerminal};
    let stdin = std::io::stdin();
    if stdin.is_terminal() {
        eprint!("{key} (input hidden): ");
        let _ = std::io::Write::flush(&mut std::io::stderr());
        let line = rpassword_line()?;
        eprintln!();
        return Ok(line.trim().to_string());
    }
    let mut line = String::new();
    stdin.lock().read_line(&mut line)?;
    Ok(line.trim().to_string())
}

/// Read one line from the terminal with echo turned off.
#[cfg(unix)]
fn rpassword_line() -> anyhow::Result<String> {
    use std::process::Command;
    let off = Command::new("stty")
        .arg("-echo")
        .stdin(std::process::Stdio::inherit())
        .status();
    let mut line = String::new();
    let res = std::io::stdin().read_line(&mut line);
    if off.is_ok() {
        let _ = Command::new("stty")
            .arg("echo")
            .stdin(std::process::Stdio::inherit())
            .status();
    }
    res?;
    Ok(line)
}

#[cfg(not(unix))]
fn rpassword_line() -> anyhow::Result<String> {
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    Ok(line)
}
