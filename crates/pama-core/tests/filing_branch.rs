//! Which branch a session is filed under (spec 002 FR-007, research R2).

use pama_core::project::{cap_branches, pick_filing_branch};
use pama_core::session::BranchVisit;

fn b(name: &str, first: &str, events: u32) -> BranchVisit {
    BranchVisit {
        name: name.into(),
        first_seen: Some(first.into()),
        last_seen: Some(first.into()),
        events,
    }
}

#[test]
fn most_events_wins() {
    let v = [
        b("feat/login", "2026-10-20T08:00:00Z", 30),
        b("fix/typo", "2026-10-20T09:00:00Z", 5),
    ];
    assert_eq!(pick_filing_branch(&v), Some("feat/login"));
}

#[test]
fn main_and_master_are_ignored_when_another_branch_exists() {
    let v = [
        b("main", "2026-10-20T08:00:00Z", 50),
        b("feat/x", "2026-10-20T09:00:00Z", 2),
    ];
    assert_eq!(pick_filing_branch(&v), Some("feat/x"));
    let v = [
        b("master", "2026-10-20T08:00:00Z", 50),
        b("feat/x", "2026-10-20T09:00:00Z", 2),
    ];
    assert_eq!(pick_filing_branch(&v), Some("feat/x"));
}

#[test]
fn main_only_files_under_main() {
    assert_eq!(
        pick_filing_branch(&[b("main", "2026-10-20T08:00:00Z", 6)]),
        Some("main")
    );
    let v = [
        b("main", "2026-10-20T08:00:00Z", 3),
        b("master", "2026-10-20T09:00:00Z", 9),
    ];
    assert_eq!(pick_filing_branch(&v), Some("master"));
}

#[test]
fn ties_go_to_the_earliest_first_seen() {
    let v = [
        b("feat/b", "2026-10-20T09:00:00Z", 5),
        b("feat/a", "2026-10-20T08:00:00Z", 5),
    ];
    assert_eq!(pick_filing_branch(&v), Some("feat/a"));
}

#[test]
fn empty_list_has_no_filing_branch() {
    assert_eq!(pick_filing_branch(&[]), None);
}

#[test]
fn cap_keeps_the_filing_branch_and_the_first_visited() {
    let mut v: Vec<BranchVisit> = (0..25)
        .map(|i| b(&format!("b{i:02}"), &format!("2026-10-20T08:{i:02}:00Z"), 1))
        .collect();
    v[24].events = 100; // filing branch is the last one visited
    let capped = cap_branches(v, 20);
    assert_eq!(capped.len(), 20);
    assert_eq!(capped[0].name, "b00");
    assert!(capped.iter().any(|x| x.name == "b24"), "filing branch kept");
    assert_eq!(
        capped.iter().filter(|x| x.name == "b24").count(),
        1,
        "no duplicates"
    );
    // order stays first-seen
    assert!(capped
        .windows(2)
        .all(|w| w[0].first_seen <= w[1].first_seen));
}

#[test]
fn cap_is_a_no_op_under_the_limit() {
    let v = vec![
        b("a", "2026-10-20T08:00:00Z", 1),
        b("b", "2026-10-20T09:00:00Z", 1),
    ];
    assert_eq!(cap_branches(v.clone(), 20), v);
}
