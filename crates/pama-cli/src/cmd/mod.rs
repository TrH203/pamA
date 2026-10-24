//! Command implementations (contracts/cli.md).

mod bundle_fmt;
mod capture;
mod config;
mod doctor;
mod hook;
mod inbox;
mod init;
mod link;
mod model;
mod review;
mod scan;
mod server;
mod sync;

use pama_core::client::ApiError;
use pama_core::store::Store;

use crate::{Cli, Command, Exit};

pub struct Ctx {
    pub json: bool,
    pub store: Store,
}

impl Ctx {
    pub fn print(&self, value: &serde_json::Value, human: impl FnOnce() -> String) {
        if self.json {
            println!("{}", serde_json::to_string_pretty(value).expect("json"));
        } else {
            let text = human();
            if !text.is_empty() {
                println!("{text}");
            }
        }
    }
}

/// Map API failures to the exit codes of contracts/cli.md.
pub fn api_exit(e: &ApiError) -> Exit {
    eprintln!("error: {e}");
    match e {
        ApiError::NotRunning | ApiError::Net(_) => Exit::Network,
        ApiError::Status {
            status: 401 | 403, ..
        } => Exit::Config,
        ApiError::Status { status, .. } if *status >= 500 => Exit::Network,
        ApiError::Status { .. } => Exit::User,
    }
}

pub fn run(cli: Cli) -> anyhow::Result<Exit> {
    let store = Store::open(&pama_core::paths::device_db())?;
    let ctx = Ctx {
        json: cli.global.json,
        store,
    };
    match cli.command {
        Command::Hook { agent } => hook::run(&ctx, agent),
        Command::Capture { action } => capture::run(&ctx, action),
        Command::Init {
            project,
            agent,
            global,
            project_scope,
        } => init::run(&ctx, project, agent, global, project_scope),
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
        Command::Model { action } => model::run(&ctx, action),
        Command::Inbox => inbox::inbox(&ctx),
        Command::Reply { ask_id, text } => inbox::reply(&ctx, &ask_id, &text),
        Command::Log { link, status } => inbox::log(&ctx, link, status),
        Command::Pair { code, server } => sync::pair(&ctx, &code, &server),
        Command::Sync { action } => sync::run(&ctx, action),
        Command::Doctor { report } => doctor::run(&ctx, report),
    }
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
