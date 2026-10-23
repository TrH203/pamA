//! Project and bundle keys. A project key is the normalized git remote (`github.com/acme/shop`)
//! or, without a remote, a hash of the path (`p:<16 hex>`) — never an absolute local path.

use std::path::Path;
use std::process::Command;

use sha2::{Digest, Sha256};

use crate::session::BranchVisit;

/// `git@github.com:Acme/shop.git`, `https://user:tok@github.com/acme/shop`, `ssh://git@host:22/a/b`
/// → `github.com/acme/shop` style keys (host lower-cased, credentials and `.git` dropped).
pub fn normalize_remote(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    let (host, path) = if let Some((_, rest)) = url.split_once("://") {
        let rest = rest.rsplit_once('@').map_or(rest, |(_, r)| r);
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let host = authority.split(':').next().unwrap_or(authority);
        (host.to_string(), path.to_string())
    } else if let Some((user_host, path)) = url.split_once(':') {
        // scp-like: git@github.com:acme/shop.git
        let host = user_host.rsplit_once('@').map_or(user_host, |(_, h)| h);
        if host.contains('/') {
            return None;
        }
        (host.to_string(), path.to_string())
    } else {
        return None;
    };
    let path = path.trim_matches('/').trim_end_matches(".git");
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("{}/{}", host.to_ascii_lowercase(), path))
}

pub fn path_key(path: &str) -> String {
    let h = Sha256::digest(path.as_bytes());
    let hex: String = h.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("p:{hex}")
}

fn git(cwd: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectInfo {
    pub key: String,
    pub name: String,
}

/// Resolve the project for a session: the remote reported by the agent, else the cwd's git
/// remote, else a hash of the repository root (or cwd).
pub fn resolve(cwd: Option<&str>, reported_remote: Option<&str>) -> ProjectInfo {
    let from_remote = reported_remote.and_then(normalize_remote).or_else(|| {
        cwd.and_then(|c| git(Path::new(c), &["config", "--get", "remote.origin.url"]))
            .and_then(|u| normalize_remote(&u))
    });
    if let Some(key) = from_remote {
        let name = key.rsplit('/').next().unwrap_or(&key).to_string();
        return ProjectInfo { key, name };
    }
    let root = cwd
        .and_then(|c| git(Path::new(c), &["rev-parse", "--show-toplevel"]))
        .or_else(|| cwd.map(String::from))
        .unwrap_or_default();
    let name = Path::new(&root)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "project".into());
    ProjectInfo {
        key: path_key(&root),
        name,
    }
}

const DEFAULT_BRANCHES: [&str; 2] = ["main", "master"];

/// The branch a session is filed under: the one with the most events, ignoring `main`/`master`
/// whenever any other branch was visited; ties go to the earliest first-seen (then list order).
pub fn pick_filing_branch(branches: &[BranchVisit]) -> Option<&str> {
    let is_default = |b: &BranchVisit| DEFAULT_BRANCHES.contains(&b.name.as_str());
    let pool: Vec<&BranchVisit> = if branches.iter().any(|b| !is_default(b)) {
        branches.iter().filter(|b| !is_default(b)).collect()
    } else {
        branches.iter().collect()
    };
    pool.iter()
        .enumerate()
        .min_by(|(ia, a), (ib, b)| {
            b.events
                .cmp(&a.events)
                .then_with(|| {
                    (a.first_seen.is_none(), &a.first_seen)
                        .cmp(&(b.first_seen.is_none(), &b.first_seen))
                })
                .then(ia.cmp(ib))
        })
        .map(|(_, b)| b.name.as_str())
}

/// Keep at most `max` branches: the filing branch plus the earliest-visited others, in the
/// original (first-seen) order.
pub fn cap_branches(branches: Vec<BranchVisit>, max: usize) -> Vec<BranchVisit> {
    if branches.len() <= max {
        return branches;
    }
    let filing = pick_filing_branch(&branches).map(String::from);
    let mut keep: Vec<bool> = vec![false; branches.len()];
    let mut left = max;
    if let Some(f) = &filing {
        if let Some(i) = branches.iter().position(|b| &b.name == f) {
            keep[i] = true;
            left -= 1;
        }
    }
    for k in keep.iter_mut() {
        if left == 0 {
            break;
        }
        if !*k {
            *k = true;
            left -= 1;
        }
    }
    branches
        .into_iter()
        .zip(keep)
        .filter_map(|(b, k)| k.then_some(b))
        .collect()
}

/// Current branch of the cwd, used when the transcript does not report one.
pub fn current_branch(cwd: &str) -> Option<String> {
    git(Path::new(cwd), &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| b != "HEAD")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_remotes() {
        for (url, want) in [
            ("git@github.com:Acme/shop.git", "github.com/Acme/shop"),
            ("https://github.com/acme/shop", "github.com/acme/shop"),
            (
                "https://user:ghp_x@GitHub.com/acme/shop.git",
                "github.com/acme/shop",
            ),
            (
                "ssh://git@gitlab.acme.vn:2222/team/api.git",
                "gitlab.acme.vn/team/api",
            ),
        ] {
            assert_eq!(normalize_remote(url).as_deref(), Some(want), "{url}");
        }
        assert_eq!(normalize_remote(""), None);
        assert_eq!(normalize_remote("/local/path"), None);
    }

    #[test]
    fn path_keys_hide_the_path() {
        let k = path_key("/Users/dev/secret-client/app");
        assert!(k.starts_with("p:") && k.len() == 18);
        assert!(!k.contains("secret"));
        let p = resolve(Some("/nonexistent/dir/for/test"), None);
        assert!(p.key.starts_with("p:"));
        assert_eq!(p.name, "test");
    }
}
