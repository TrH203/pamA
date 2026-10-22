//! `pama` command-line tool. Command surface follows specs/001-pama-mvp/contracts/cli.md.

mod cmd;

use std::process::ExitCode;

use clap::{Args, Parser, Subcommand, ValueEnum};

/// Exit codes from contracts/cli.md.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Ok = 0,
    User = 1,
    Config = 2,
    Network = 3,
    Safety = 4,
}

impl From<Exit> for ExitCode {
    fn from(e: Exit) -> Self {
        ExitCode::from(e as u8)
    }
}

#[derive(Debug, Parser)]
#[command(name = "pama", version, about = "pamA — Please Ask my AI")]
pub struct Cli {
    #[command(flatten)]
    pub global: Global,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Args, Clone)]
pub struct Global {
    /// Machine-readable output on stdout.
    #[arg(long, global = true)]
    pub json: bool,
    /// Server URL (default: the local sidecar).
    #[arg(long, global = true)]
    pub server: Option<String>,
    /// Verbosity (repeat for more).
    #[arg(short, action = clap::ArgAction::Count, global = true)]
    pub verbose: u8,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum AgentArg {
    Claude,
    Codex,
    All,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Enable capture for a project.
    Init {
        #[arg(long)]
        project: Option<String>,
        #[arg(long, value_enum, default_value = "all")]
        agent: AgentArg,
        /// Install hooks in the user scope instead of the project.
        #[arg(long)]
        global: bool,
        /// Allow editing committed project settings.
        #[arg(long)]
        project_scope: bool,
    },
    /// Hook entrypoint called by the coding agents.
    Hook {
        #[command(subcommand)]
        agent: HookAgent,
    },
    /// Find ended sessions that were not captured by hooks.
    Scan {
        #[arg(long)]
        since: Option<String>,
    },
    /// Review draft digests.
    Review {
        #[arg(long, conflicts_with_all = ["discard", "edit"])]
        approve: Option<String>,
        #[arg(long, conflicts_with = "edit")]
        discard: Option<String>,
        #[arg(long)]
        edit: Option<String>,
    },
    /// Manage Ask Links.
    Link {
        #[command(subcommand)]
        action: LinkAction,
    },
    /// Show forwarded questions.
    Inbox,
    /// Reply to a forwarded question.
    Reply { ask_id: String, text: String },
    /// Show the audit log.
    Log {
        #[arg(long)]
        link: Option<String>,
        #[arg(long)]
        status: Option<String>,
    },
    /// Per-source sync control.
    Sync {
        #[command(subcommand)]
        action: SyncAction,
    },
    /// Pair this device with a server.
    Pair {
        code: String,
        #[arg(long)]
        server: String,
    },
    /// Manage the local server.
    Server {
        #[command(subcommand)]
        action: ServerAction,
    },
    /// Check hooks, models, permissions and offline config.
    Doctor,
    /// Read or change settings.
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
}

#[derive(Debug, Subcommand)]
pub enum HookAgent {
    /// Claude Code hook (JSON on stdin).
    Claude,
    /// Codex hook (stdin) or notify (JSON in argv).
    Codex { json: Option<String> },
}

#[derive(Debug, Subcommand)]
pub enum LinkAction {
    Create(LinkCreate),
    List,
    Revoke { slug: String },
}

#[derive(Debug, Args)]
pub struct LinkCreate {
    #[arg(long = "source")]
    pub sources: Vec<String>,
    #[arg(long)]
    pub suggest: Option<String>,
    #[arg(long, default_value = "7d")]
    pub expires: String,
    #[arg(long, default_value = "summary")]
    pub detail: String,
    #[arg(long = "deny")]
    pub deny: Vec<String>,
    #[arg(long)]
    pub instruction: Option<String>,
    #[arg(long, default_value = "pin")]
    pub access: String,
    #[arg(long)]
    pub pin: Option<String>,
    #[arg(long = "allow")]
    pub allow: Vec<String>,
}

#[derive(Debug, Subcommand)]
pub enum SyncAction {
    Status,
    Enable(SyncTarget),
    Disable(SyncTarget),
}

#[derive(Debug, Args)]
pub struct SyncTarget {
    #[arg(long, conflicts_with = "bundle")]
    pub project: Option<String>,
    #[arg(long)]
    pub bundle: Option<String>,
    #[arg(long)]
    pub target: Option<String>,
}

#[derive(Debug, Subcommand)]
pub enum ServerAction {
    Start {
        /// Bind on the LAN instead of 127.0.0.1.
        #[arg(long)]
        lan: bool,
    },
    Stop,
    Status,
}

#[derive(Debug, Subcommand)]
pub enum ConfigAction {
    Set { key: String, value: String },
    Get { key: String },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cmd::run(cli) {
        Ok(code) => code.into(),
        Err(e) => {
            eprintln!("error: {e:#}");
            Exit::User.into()
        }
    }
}
