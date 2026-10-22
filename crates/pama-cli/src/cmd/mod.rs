//! Command implementations. Commands that are not built yet report so and exit with code 1.

use crate::{Cli, Command, Exit};

pub fn run(cli: Cli) -> anyhow::Result<Exit> {
    let name = match &cli.command {
        Command::Init { .. } => "init",
        Command::Hook { .. } => "hook",
        Command::Scan { .. } => "scan",
        Command::Review { .. } => "review",
        Command::Link { .. } => "link",
        Command::Inbox => "inbox",
        Command::Reply { .. } => "reply",
        Command::Log { .. } => "log",
        Command::Sync { .. } => "sync",
        Command::Pair { .. } => "pair",
        Command::Server { .. } => "server",
        Command::Doctor => "doctor",
        Command::Config { .. } => "config",
    };
    eprintln!("pama {name}: not implemented yet");
    Ok(Exit::User)
}
