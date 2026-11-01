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
    /// Remote server for this command (one you are logged in to); default: the server chosen at
    /// login in remote mode, else the local server.
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
        /// Where this machine sends its work: everything local, or a remote server (asked
        /// interactively on a fresh install).
        #[arg(long, value_enum)]
        mode: Option<ModeArg>,
        /// Remote mode: turn on sync for this project without asking.
        #[arg(long)]
        sync: bool,
    },
    /// Connect this machine to a remote pamA server (browser approval). Give the server with
    /// `--server <url>` (default: $PAMA_CLOUD_URL).
    Login {
        /// Print the approval link instead of opening a browser.
        #[arg(long)]
        no_browser: bool,
    },
    /// Disconnect this machine from a remote server (`--server`, default: the default server).
    Logout {
        /// Drop drafts and deletions not yet delivered to that server.
        #[arg(long)]
        discard_pending: bool,
    },
    /// Show or change where this machine works: local or remote.
    Mode {
        #[arg(value_enum)]
        mode: Option<ModeArg>,
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
    /// What is shared and where: Publish (local mode, a one-way copy of approved digests to a
    /// server) or the drafts sent to your home server (remote mode).
    Sync {
        #[command(subcommand)]
        action: SyncAction,
    },
    /// Tasks: agent sessions grouped by the work they belong to (by git branch at first).
    Tasks {
        #[command(subcommand)]
        action: TasksAction,
    },
    /// Agent sessions pamA has read, with their digests.
    Sessions {
        #[command(subcommand)]
        action: SessionsAction,
    },
    /// Digests by status (draft, approved, discarded, withdrawn).
    Digests {
        #[command(subcommand)]
        action: DigestsAction,
    },
    /// Search approved digest items across all projects.
    Search {
        query: Vec<String>,
        #[arg(long, default_value_t = 20)]
        limit: u32,
    },
    /// Pair this device with a server.
    Pair {
        code: String,
        #[arg(long)]
        server: String,
    },
    /// Open the owner console in the browser (starts the local server if needed).
    Console {
        /// Print the link instead of opening it.
        #[arg(long)]
        print: bool,
    },
    /// Manage the local server.
    Server {
        #[command(subcommand)]
        action: ServerAction,
    },
    /// Configure, check and switch the chat and embedding models.
    Model {
        /// The drafting model on this machine (remote mode) instead of the server's models.
        #[arg(long)]
        device: bool,
        #[command(subcommand)]
        action: ModelAction,
    },
    /// Check hooks, models, permissions and offline config.
    Doctor {
        /// Internal: full report as one JSON object, for the console.
        #[arg(long, hide = true)]
        report: bool,
    },
    /// Read or change settings.
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Internal: process captured sessions (spawned by `pama hook`).
    #[command(hide = true)]
    Capture {
        #[command(subcommand)]
        action: CaptureAction,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum ModeArg {
    Local,
    Remote,
}

#[derive(Debug, Subcommand)]
pub enum CaptureAction {
    /// Process due captures, waiting for debounced ones, then exit.
    Drain {
        /// Process what is due once and exit without waiting.
        #[arg(long)]
        once: bool,
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
    /// `task:<id>`, `project:<id>`, `session:<id>` or a bare task id; repeat for more.
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
    /// Projects and tasks being shared, the server, the queue and failed items.
    Status,
    /// Start sharing a project or task (local mode: Publish to the paired server).
    Enable(SyncTarget),
    /// Stop sharing a project or task; its copies on the server are deleted. Lists the Ask Links
    /// that would lose sources first and asks for --yes.
    Disable(SyncTarget),
    /// Send everything waiting now (and, in remote mode, pull review decisions back).
    Now,
    /// Items the server refused or that ran out of retries, with the last error.
    Failed,
    /// Try failed items again.
    Retry {
        /// An id (or id prefix) from `pama sync failed`.
        #[arg(required_unless_present = "all")]
        id: Option<String>,
        #[arg(long, conflicts_with = "id")]
        all: bool,
    },
    /// Give up on a failed item.
    Drop { id: String },
}

#[derive(Debug, Args)]
pub struct SyncTarget {
    /// Project name, id, repo key or directory.
    #[arg(long, conflicts_with = "bundle")]
    pub project: Option<String>,
    /// Task name or id.
    #[arg(long = "task", visible_alias = "bundle")]
    pub bundle: Option<String>,
    /// Server to publish to (local mode; default: the paired server).
    #[arg(long)]
    pub target: Option<String>,
    /// Go ahead even if Ask Links lose sources.
    #[arg(long)]
    pub yes: bool,
}

#[derive(Debug, Subcommand)]
pub enum TasksAction {
    /// Tasks per project.
    List {
        /// Project name or id.
        #[arg(long)]
        project: Option<String>,
    },
    /// One task with its sessions.
    Show { task: String },
    /// Give a task a new name.
    Rename { task: String, name: String },
    /// Merge tasks into the first one.
    Merge {
        #[arg(num_args = 2.., required = true)]
        tasks: Vec<String>,
        /// Name of the merged task (default: the first task's name).
        #[arg(long)]
        name: Option<String>,
    },
    /// Move sessions of a task into a new task.
    Split {
        task: String,
        /// Session id (or prefix, or agent session id) to move; repeat for more.
        #[arg(long = "session", required = true)]
        sessions: Vec<String>,
        #[arg(long)]
        name: String,
    },
}

#[derive(Debug, Args)]
pub struct ListPage {
    #[arg(long, default_value_t = 50)]
    pub limit: u32,
    #[arg(long, default_value_t = 0)]
    pub offset: u32,
}

#[derive(Debug, Subcommand)]
pub enum SessionsAction {
    /// Agent sessions, newest first.
    List {
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        task: Option<String>,
        #[arg(long, value_parser = ["claude_code", "codex"])]
        agent: Option<String>,
        #[arg(long, value_parser = ["draft", "approved", "discarded", "withdrawn", "none"])]
        status: Option<String>,
        #[command(flatten)]
        page: ListPage,
    },
    /// One session: agent, times, branches, capture status, digest versions, links using it.
    Show { session: String },
    /// Delete a session and its digests (and its published copy).
    Delete {
        session: String,
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Debug, Subcommand)]
pub enum DigestsAction {
    List {
        #[arg(long, value_parser = ["draft", "approved", "discarded", "withdrawn", "superseded"])]
        status: Option<String>,
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        task: Option<String>,
        #[command(flatten)]
        page: ListPage,
    },
    Show {
        digest: String,
    },
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

const ROLES: [&str; 3] = ["chat", "small", "embed"];

#[derive(Debug, Subcommand)]
pub enum ModelAction {
    /// Show the model setup (provider, local/cloud, model, key state, status).
    Show,
    /// Set provider and model for a role.
    Set(ModelSet),
    /// Switch a role between local and cloud.
    Switch {
        #[arg(value_parser = ROLES)]
        role: String,
        #[arg(value_enum)]
        target: SwitchTarget,
        /// Provider for cloud (default: anthropic; embed: openai-compatible).
        #[arg(long)]
        provider: Option<String>,
        /// Model (default: keep the current one when switching to local).
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        base_url: Option<String>,
        /// Read the API key from stdin.
        #[arg(long)]
        key_stdin: bool,
        /// Confirm data-leaves-machine and re-index prompts.
        #[arg(long)]
        yes: bool,
        /// Save even if the check fails.
        #[arg(long)]
        force: bool,
    },
    /// Check status and compatibility of one role or all.
    Check {
        #[arg(value_parser = ROLES)]
        role: Option<String>,
    },
    /// Go back to the previous configuration of a role.
    Revert {
        #[arg(value_parser = ROLES)]
        role: String,
    },
    /// Guided setup (interactive terminal).
    Setup,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum SwitchTarget {
    Local,
    Cloud,
}

#[derive(Debug, Args)]
pub struct ModelSet {
    #[arg(value_parser = ROLES)]
    pub role: String,
    #[arg(long, value_parser = ["ollama", "openai-compatible", "openrouter", "anthropic"])]
    pub provider: String,
    #[arg(long)]
    pub model: String,
    #[arg(long)]
    pub base_url: Option<String>,
    /// Read the API key from stdin (never pass keys as arguments).
    #[arg(long)]
    pub key_stdin: bool,
    /// Confirm data-leaves-machine and re-index prompts.
    #[arg(long)]
    pub yes: bool,
    /// Save even if the check fails.
    #[arg(long)]
    pub force: bool,
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
