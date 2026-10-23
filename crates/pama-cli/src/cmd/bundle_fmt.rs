//! Text formats for bundles (specs/002-bundle-names-branches/contracts/cli.md).

use serde_json::Value;

/// At most this many branch names are listed before `+N more`.
const MAX_LISTED: usize = 3;

/// ` [first +N]` for a session or bundle that spans more than one branch, else empty.
pub fn branch_hint(branches: &Value) -> String {
    let names: Vec<&str> = branches
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    match names.as_slice() {
        [] | [_] => String::new(),
        [first, rest @ ..] => format!(" [{first} +{}]", rest.len()),
    }
}

/// `a, b, c +2 more`, or `-` when there are none.
pub fn branches_text(branches: &[String]) -> String {
    if branches.is_empty() {
        return "-".into();
    }
    let shown = branches
        .iter()
        .take(MAX_LISTED)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    match branches.len().saturating_sub(MAX_LISTED) {
        0 => shown,
        n => format!("{shown} +{n} more"),
    }
}

/// One line per bundle for `pama sync status`.
pub fn bundle_line(b: &Value) -> String {
    let branches: Vec<String> = b["branches"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let count = b["session_count"].as_u64().unwrap_or(0);
    let sessions = if count == 1 {
        "1 session".to_string()
    } else {
        format!("{count} sessions")
    };
    let last = b["last_activity"]
        .as_str()
        .map(|t| t.replace('T', " ").chars().take(16).collect::<String>())
        .unwrap_or_else(|| "-".into());
    let sync = match b["sync_enabled"].as_bool() {
        Some(true) => "on",
        Some(false) => "off",
        None => "inherit",
    };
    format!(
        "    {}   id={}   branches: {}   {sessions}   last {last}   sync: {sync}",
        b["name"].as_str().unwrap_or("?"),
        b["id"].as_str().unwrap_or("?"),
        branches_text(&branches),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn branch_hint_only_for_multi_branch_sessions() {
        assert_eq!(branch_hint(&json!(["feat/a"])), "");
        assert_eq!(branch_hint(&json!([])), "");
        assert_eq!(branch_hint(&json!(null)), "");
        assert_eq!(
            branch_hint(&json!(["feat/a", "fix/b", "main"])),
            " [feat/a +2]"
        );
    }

    #[test]
    fn branches_truncate_to_three_in_text() {
        let b = ["a", "b", "c", "d", "e"].map(String::from);
        assert_eq!(branches_text(&b[..2]), "a, b");
        assert_eq!(branches_text(&b[..3]), "a, b, c");
        assert_eq!(branches_text(&b), "a, b, c +2 more");
        assert_eq!(branches_text(&[]), "-");
    }

    #[test]
    fn bundle_line_matches_the_contract() {
        let b = json!({
            "id": "01J", "name": "Refund shipping fee",
            "branches": ["feat/refund-shipping", "fix/refund-typo"],
            "session_count": 4, "last_activity": "2026-10-23T09:12:00Z",
            "sync_enabled": false
        });
        assert_eq!(
            bundle_line(&b),
            "    Refund shipping fee   id=01J   branches: feat/refund-shipping, fix/refund-typo   4 sessions   last 2026-10-23 09:12   sync: off"
        );
        let one = json!({"id": "x", "name": "N", "branches": [], "session_count": 1,
            "last_activity": null, "sync_enabled": null});
        assert_eq!(
            bundle_line(&one),
            "    N   id=x   branches: -   1 session   last -   sync: inherit"
        );
    }
}
