//! Throughput of transcript parsing + Layer 1 (target ≥ 20 MB/s, plan.md Performance Goals).
//! Run: cargo bench -p pama-core --bench redact

use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use pama_core::redact::RuleSet;
use pama_core::session::{claude, redact_session};

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let rules = RuleSet::load_dir(&root.join("../../rules")).unwrap();
    let fixture = std::fs::read_to_string(root.join(
        "tests/fixtures/claude/2.1/-Users-dev-work-shop/7c1e2f30-0000-4a1b-9c2d-3e4f5a6b7c8d.jsonl",
    ))
    .unwrap();
    // ~20 MB transcript built from the fixture.
    let dir = std::env::temp_dir().join(format!("pama-bench-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("bench.jsonl");
    let mut f = std::fs::File::create(&path).unwrap();
    let mut size = 0;
    while size < 20 * 1024 * 1024 {
        f.write_all(fixture.as_bytes()).unwrap();
        size += fixture.len();
    }
    drop(f);
    let start = Instant::now();
    let mut s = claude::parse(&path).unwrap();
    let counts = redact_session(&rules, &mut s);
    let secs = start.elapsed().as_secs_f64();
    let mb = size as f64 / (1024.0 * 1024.0);
    println!(
        "{mb:.1} MB, {} events, {} redactions in {secs:.2}s → {:.1} MB/s",
        s.events.len(),
        counts.total(),
        mb / secs
    );
    std::fs::remove_dir_all(dir).unwrap();
}
