//! Terminal output for people (plan section 7.4): headings, key–value blocks, tables, status
//! symbols, errors with a fix and spinners. One quiet palette: sage green for ok, amber for
//! warnings, red for failures, dim grey for secondary text. Never colour alone: every status
//! carries a symbol and a word.
//!
//! The helpers always build ANSI-styled strings; they are written through `anstream`, which
//! strips the styling when the stream is not a terminal, when `NO_COLOR` is set, or keeps it
//! when `CLICOLOR_FORCE` is set. `--json` output never passes through here.

use std::io::IsTerminal;
use std::time::Duration;

use comfy_table::{presets, Attribute, Cell, CellAlignment, ContentArrangement, Table};
use owo_colors::{OwoColorize, Style};

/// Sage: the accent of the console design system, in the 256-colour palette so it works in
/// terminals without true colour.
const SAGE: u8 = 108;
const AMBER: u8 = 179;
const RED: u8 = 167;

fn paint(s: &str, style: Style) -> String {
    format!("{}", s.style(style))
}

pub fn bold(s: &str) -> String {
    paint(s, Style::new().bold())
}

pub fn dim(s: &str) -> String {
    paint(s, Style::new().dimmed())
}

pub fn ok(s: &str) -> String {
    paint(s, Style::new().color(owo_colors::XtermColors::from(SAGE)))
}

pub fn warn(s: &str) -> String {
    paint(s, Style::new().color(owo_colors::XtermColors::from(AMBER)))
}

pub fn bad(s: &str) -> String {
    paint(s, Style::new().color(owo_colors::XtermColors::from(RED)))
}

/// A command reference such as `pama review`, set off from the prose around it.
pub fn cmd(s: &str) -> String {
    paint(s, Style::new().bold())
}

/// The state of one line: a symbol with its colour. The symbol carries the meaning, so the
/// output reads the same without colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mark {
    Ok,
    Warn,
    Fail,
    Pending,
    Info,
}

impl Mark {
    pub fn symbol(self) -> &'static str {
        match self {
            Mark::Ok => "✓",
            Mark::Warn => "!",
            Mark::Fail => "✗",
            Mark::Pending => "…",
            Mark::Info => "·",
        }
    }

    pub fn paint(self, s: &str) -> String {
        match self {
            Mark::Ok => ok(s),
            Mark::Warn => warn(s),
            Mark::Fail => bad(s),
            Mark::Pending | Mark::Info => dim(s),
        }
    }

    /// The coloured symbol.
    pub fn sym(self) -> String {
        self.paint(self.symbol())
    }

    /// Symbol and word, e.g. `✓ ok`.
    pub fn label(self, word: &str) -> String {
        self.paint(&format!("{} {word}", self.symbol()))
    }

    pub fn from_ok(ok: bool) -> Mark {
        if ok {
            Mark::Ok
        } else {
            Mark::Fail
        }
    }
}

/// The mark for a status word used by the server (`failed`, `running`, `submitted`, …).
pub fn mark_for(status: &str) -> Mark {
    match status {
        "ok" | "done" | "submitted" | "sent" | "approved" | "published" | "verified" | "up"
        | "active" | "connected" | "succeeded" | "success" => Mark::Ok,
        "failed" | "error" | "dead" | "revoked" | "down" | "rejected" => Mark::Fail,
        "running" | "queued" | "pending" | "detected" | "drafting" | "retrying" | "waiting" => {
            Mark::Pending
        }
        "skipped" | "discarded" | "expired" | "stale" | "warning" | "ready_for_review"
        | "awaiting_review" | "draft" | "drafted" => Mark::Warn,
        _ => Mark::Info,
    }
}

/// `status` with its symbol and colour, e.g. `✗ failed`.
pub fn status(status: &str) -> String {
    mark_for(status).label(status)
}

/// A status phrase whose first word is the status, e.g. `retrying in 5m`.
pub fn status_phrase(phrase: &str) -> String {
    let first = phrase.split_whitespace().next().unwrap_or("");
    mark_for(first).label(phrase)
}

/// A stage flow such as `parsed → redacted → ✗ provider_unreachable`: arrows dimmed, the ✓ or
/// ✗ step coloured.
pub fn flow(s: &str) -> String {
    s.split(" → ")
        .map(|p| {
            if p.starts_with('✗') {
                bad(p)
            } else if p.starts_with('✓') {
                ok(p)
            } else {
                p.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(&dim(" → "))
}

/// A document title, e.g. `pamA status`.
pub fn title(s: &str) -> String {
    bold(s)
}

/// A section heading inside a block of output.
pub fn heading(s: &str) -> String {
    bold(s)
}

/// Rows of `  key   value`, keys padded to the widest key (at least 11 columns).
pub fn kv<K: AsRef<str>, V: AsRef<str>>(rows: &[(K, V)]) -> String {
    let width = rows
        .iter()
        .map(|(k, _)| k.as_ref().chars().count())
        .max()
        .unwrap_or(0)
        .max(11);
    rows.iter()
        .map(|(k, v)| {
            let k = k.as_ref();
            let pad = width - k.chars().count();
            // Continuation lines of a multi-line value line up under the value.
            let value = v
                .as_ref()
                .replace('\n', &format!("\n  {}", " ".repeat(width + 1)));
            format!("  {}{} {value}", dim(k), " ".repeat(pad))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A borderless table: bold header, columns separated by spaces, fitted to the terminal width
/// (long cells wrap) when stdout is a terminal.
pub fn table<H: AsRef<str>>(headers: &[H], rows: Vec<Vec<String>>) -> String {
    let mut t = Table::new();
    t.load_preset(presets::NOTHING);
    if std::io::stdout().is_terminal() {
        t.set_content_arrangement(ContentArrangement::Dynamic);
    } else {
        t.set_content_arrangement(ContentArrangement::Disabled);
    }
    t.set_header(
        headers
            .iter()
            .map(|h| Cell::new(h.as_ref()).add_attribute(Attribute::Bold)),
    );
    for row in rows {
        t.add_row(row);
    }
    for col in t.column_iter_mut() {
        col.set_padding((0, 2));
        col.set_cell_alignment(CellAlignment::Left);
    }
    // NOTHING keeps one leading space per row; trim it and trailing spaces.
    t.lines()
        .map(|l| l.trim_end().to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

/// `✗ <code>: <message>` and, when known, `  → <fix>`.
pub fn error_text(code: &str, message: &str, fix: Option<&str>) -> String {
    let mut out = format!("{} {}: {message}", bad("✗"), bad(code));
    if let Some(f) = fix {
        out.push_str(&format!("\n  {} {f}", dim("→")));
    }
    out
}

/// Print an error to stderr in the shared format.
pub fn error(code: &str, message: &str, fix: Option<&str>) {
    anstream::eprintln!("{}", error_text(code, message, fix));
}

/// `fail!("code", "message {x}")`: print `✗ code: message` to stderr.
#[macro_export]
macro_rules! fail {
    ($code:expr, $($arg:tt)*) => {
        $crate::ui::error($code, &std::fmt::format(format_args!($($arg)*)), None)
    };
}

/// A note on stderr (`! message`), e.g. a deprecation.
pub fn note(message: &str) {
    anstream::eprintln!("{} {message}", warn("!"));
}

/// Print human output to stdout (styling stripped when not wanted).
pub fn out(text: &str) {
    anstream::println!("{text}");
}

/// A spinner on stderr while a slow step runs. Nothing is drawn when stderr is not a terminal
/// or when `json` is set, so piped and `--json` output stay clean.
pub struct Spinner(Option<indicatif::ProgressBar>);

pub fn spinner(json: bool, message: &str) -> Spinner {
    if json || !std::io::stderr().is_terminal() || std::env::var_os("PAMA_NO_SPINNER").is_some() {
        return Spinner(None);
    }
    let pb = indicatif::ProgressBar::new_spinner();
    if let Ok(style) = indicatif::ProgressStyle::with_template("{spinner} {msg}") {
        pb.set_style(style.tick_strings(&["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏", " "]));
    }
    pb.set_message(message.to_string());
    pb.enable_steady_tick(Duration::from_millis(90));
    Spinner(Some(pb))
}

impl Spinner {
    pub fn set_message(&self, message: &str) {
        if let Some(pb) = &self.0 {
            pb.set_message(message.to_string());
        }
    }

    /// Remove the spinner line.
    pub fn finish(self) {}
}

impl Drop for Spinner {
    fn drop(&mut self) {
        if let Some(pb) = self.0.take() {
            pb.finish_and_clear();
        }
    }
}

/// Plain text: the string with ANSI styling removed (tests and width checks).
#[cfg(test)]
pub fn plain(s: &str) -> String {
    anstream::adapter::strip_str(s).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_carry_a_symbol_not_only_colour() {
        assert_eq!(plain(&status("failed")), "✗ failed");
        assert_eq!(plain(&status("submitted")), "✓ submitted");
        assert_eq!(plain(&status("running")), "… running");
        assert_eq!(plain(&status("something")), "· something");
        assert_eq!(plain(&Mark::Warn.label("stale")), "! stale");
    }

    #[test]
    fn error_has_code_message_and_fix() {
        let e = plain(&error_text(
            "not_running",
            "the server is not running",
            Some("`pama server start`"),
        ));
        assert_eq!(
            e,
            "✗ not_running: the server is not running\n  → `pama server start`"
        );
        let e = plain(&error_text("http_404", "no such task", None));
        assert_eq!(e, "✗ http_404: no such task");
    }

    #[test]
    fn kv_pads_keys_and_indents_continuations() {
        let s = plain(&kv(&[("data", "local"), ("last error", "a\nb")]));
        assert_eq!(s, "  data        local\n  last error  a\n              b");
    }

    #[test]
    fn table_has_header_and_rows() {
        let s = plain(&table(
            &["ID", "STATUS"],
            vec![vec!["01ab".into(), status("failed")]],
        ));
        let lines: Vec<&str> = s.lines().collect();
        assert_eq!(lines.len(), 2, "{s}");
        assert!(lines[0].trim_start().starts_with("ID"));
        assert!(lines[1].contains("01ab") && lines[1].contains("✗ failed"));
    }

    #[test]
    fn spinner_is_silent_for_json() {
        let s = spinner(true, "checking");
        assert!(s.0.is_none());
    }
}
