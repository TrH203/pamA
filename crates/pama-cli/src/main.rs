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
    /// Without a command, `pama` prints `pama status`.
    #[command(subcommand)]
    pub command: Option<Command>,
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
    Cursor,
    Opencode,
    /// Claude Code and Codex, plus Cursor and OpenCode when they are used on this machine.
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
    /// Connect this machine to a pamA server (browser approval) and make it home.
    Connect {
        /// Server URL (default: --server or $PAMA_CLOUD_URL).
        url: Option<String>,
        /// Print the approval link instead of opening a browser.
        #[arg(long)]
        no_browser: bool,
        /// Use a pairing code from the server's console instead of browser approval (servers
        /// without device login; the server becomes the default sync target).
        #[arg(long)]
        code: Option<String>,
    },
    /// Switch where this machine's work lives: `local` or a connected server URL.
    Use {
        /// `local` or a server URL.
        target: String,
        /// Switch without asking.
        #[arg(long)]
        yes: bool,
    },
    /// Provider API keys in the OS keychain (values are never printed).
    Keys {
        #[command(subcommand)]
        action: KeysAction,
    },
    /// Coding agents pamA reads: detection, hooks and per-agent capture.
    Agents {
        #[command(subcommand)]
        action: Option<AgentsAction>,
    },
    /// Deprecated: use `pama connect <url>`.
    #[command(hide = true)]
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
    /// Per-source sync control.
    Sync {
        #[command(subcommand)]
        action: SyncAction,
    },
    /// Deprecated: use `pama connect <url> --code <code>`.
    #[command(hide = true)]
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
    /// Overview: where data goes, models, digest pipeline and sync (also bare `pama`).
    Status,
    /// Digest pipeline activity: captured sessions and each attempt's stages and errors.
    Activity {
        /// Only failed captures.
        #[arg(long)]
        failed: bool,
        /// Keep printing attempts as they happen.
        #[arg(long)]
        follow: bool,
        #[arg(long, default_value_t = 20)]
        limit: usize,
        #[command(subcommand)]
        action: Option<ActivityAction>,
    },
    /// Show the device log, or the local server's log with `pama logs server`.
    Logs {
        #[arg(value_enum, default_value = "device")]
        source: LogSource,
        /// Lines to show.
        #[arg(short = 'n', long, default_value_t = 50)]
        lines: usize,
        /// Keep printing new lines.
        #[arg(short, long)]
        follow: bool,
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

#[derive(Debug, Subcommand)]
pub enum ActivityAction {
    /// One capture (or server run) with every attempt.
    Show { id: String },
    /// Try a failed capture again now (or resume a failed server run).
    Retry {
        #[arg(required_unless_present = "all_failed")]
        id: Option<String>,
        #[arg(long, conflicts_with = "id")]
        all_failed: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum LogSource {
    /// Hooks, capture and sync on this machine (~/.pama/pama.log).
    Device,
    /// The local server (~/.pama/server.log).
    Server,
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
    /// Codex hook (stdin) or notify (JSON in argv; `--chain <argv…>` runs another notifier).
    Codex {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Cursor hook (JSON on stdin).
    Cursor,
    /// OpenCode plugin (JSON in argv).
    Opencode { json: Option<String> },
}

#[derive(Debug, Subcommand)]
pub enum KeysAction {
    /// Which providers have a key, and where it is stored.
    List,
    /// Store a provider's key (read from stdin, never from arguments).
    Set {
        #[arg(value_parser = clap::builder::PossibleValuesParser::new(pama_core::providers::ids()))]
        provider: String,
    },
    /// Check that the provider accepts the stored key.
    Test {
        #[arg(value_parser = clap::builder::PossibleValuesParser::new(pama_core::providers::ids()))]
        provider: String,
        /// Endpoint to test against (default: the provider's, or the drafting model's).
        #[arg(long)]
        base_url: Option<String>,
    },
    /// Delete a provider's key from the keychain.
    Remove {
        #[arg(value_parser = clap::builder::PossibleValuesParser::new(pama_core::providers::ids()))]
        provider: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum AgentsAction {
    /// List agents: detected, capture on/off, hooks, recent sessions (default).
    List,
    /// Turn capture on for an agent and install its hook.
    Enable {
        /// claude, codex, cursor or opencode.
        id: String,
        /// Install the hook for every project (user scope).
        #[arg(long, conflicts_with = "project")]
        global: bool,
        /// Install the hook in this project (default: the current directory).
        #[arg(long)]
        project: Option<String>,
        /// Use the committed project config (e.g. `.claude/settings.json`).
        #[arg(long)]
        shared: bool,
    },
    /// Turn capture off for an agent (hooks stay but are ignored).
    Disable { id: String },
    /// Remove pamA's hooks for an agent everywhere (user scope and captured projects).
    Uninstall { id: String },
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
    /// Servers this machine is connected to.
    List,
    /// Make a connected server the default (and home, in server mode).
    Use {
        url: String,
    },
    /// Disconnect from a server and forget it.
    Forget {
        url: String,
        /// Drop drafts and deletions not yet delivered to that server.
        #[arg(long)]
        discard_pending: bool,
    },
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
    /// Guided setup (interactive terminal), optionally from a preset.
    Setup {
        /// offline, openrouter, openai or anthropic-deepinfra.
        #[arg(long)]
        preset: Option<String>,
    },
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
    #[arg(long, value_parser = clap::builder::PossibleValuesParser::new(pama_core::providers::ids()))]
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
