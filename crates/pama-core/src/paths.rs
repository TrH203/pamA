//! Where pamA keeps device state: `$PAMA_HOME`, default `~/.pama`.

use std::path::PathBuf;

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn pama_home() -> PathBuf {
    std::env::var_os("PAMA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".pama"))
}

pub fn device_db() -> PathBuf {
    pama_home().join("device.db")
}

/// Written by whoever starts the local server (CLI or desktop): url, token, pid.
pub fn server_info() -> PathBuf {
    pama_home().join("server.json")
}

pub fn server_data_dir() -> PathBuf {
    pama_home().join("server")
}

pub fn log_file() -> PathBuf {
    pama_home().join("pama.log")
}

pub fn drain_lock() -> PathBuf {
    pama_home().join("capture.lock")
}
