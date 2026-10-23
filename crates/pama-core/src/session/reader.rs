//! Streaming JSONL reading with bounded memory: one line at a time, oversized lines and files
//! are skipped or rejected instead of loaded (edge case: transcripts of hundreds of MB).

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use sha2::{Digest, Sha256};

/// Files above this size are not processed (marked failed with a reason).
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
/// Single JSONL records above this size are skipped (e.g. huge tool outputs or images).
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    #[error("reading {0}: {1}")]
    Io(String, std::io::Error),
    #[error("transcript too large ({0} bytes, limit {MAX_FILE_BYTES})")]
    TooLarge(u64),
}

/// Calls `f` for every JSON line; returns the number of skipped (malformed/oversized) lines.
pub fn for_each_json_line(
    path: &Path,
    mut f: impl FnMut(serde_json::Value),
) -> Result<usize, ReadError> {
    let file = File::open(path).map_err(|e| ReadError::Io(path.display().to_string(), e))?;
    let len = file
        .metadata()
        .map_err(|e| ReadError::Io(path.display().to_string(), e))?
        .len();
    if len > MAX_FILE_BYTES {
        return Err(ReadError::TooLarge(len));
    }
    let mut reader = BufReader::with_capacity(1 << 16, file);
    let mut buf = Vec::with_capacity(1 << 16);
    let mut skipped = 0;
    loop {
        buf.clear();
        let n = (&mut reader)
            .take(MAX_LINE_BYTES as u64 + 1)
            .read_until(b'\n', &mut buf)
            .map_err(|e| ReadError::Io(path.display().to_string(), e))?;
        if n == 0 {
            break;
        }
        if n > MAX_LINE_BYTES && buf.last() != Some(&b'\n') {
            // Drain the rest of the oversized line.
            let mut sink = Vec::new();
            reader
                .read_until(b'\n', &mut sink)
                .map_err(|e| ReadError::Io(path.display().to_string(), e))?;
            skipped += 1;
            continue;
        }
        let line = buf.trim_ascii();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_slice(line) {
            Ok(v) => f(v),
            Err(_) => skipped += 1,
        }
    }
    Ok(skipped)
}

/// SHA-256 of a file, streamed (detects re-processing of an unchanged transcript).
pub fn sha256_file(path: &Path) -> Result<String, ReadError> {
    let mut file = File::open(path).map_err(|e| ReadError::Io(path.display().to_string(), e))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| ReadError::Io(path.display().to_string(), e))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}
