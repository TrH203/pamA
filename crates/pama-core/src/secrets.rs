//! Device tokens and provider API keys live in the OS keychain, never in plain files
//! (Constitution: Technical & Licensing Constraints).

use std::sync::{Arc, Once};

use keyring_core::{Entry, Error};

pub const SERVICE: &str = "dev.pama";

static INIT: Once = Once::new();

/// Install the platform store once (macOS Keychain, Windows Credential Manager).
/// Tests call [`use_mock_store`] instead.
pub fn init_platform_store() {
    INIT.call_once(|| {
        #[cfg(target_os = "macos")]
        if let Ok(s) = apple_native_keyring_store::keychain::Store::new() {
            keyring_core::set_default_store(s);
        }
        #[cfg(target_os = "windows")]
        if let Ok(s) = windows_native_keyring_store::Store::new() {
            keyring_core::set_default_store(s);
        }
    });
}

/// In-memory store for tests.
pub fn use_mock_store() {
    let store: Arc<keyring_core::CredentialStore> =
        keyring_core::mock::Store::new().expect("mock keyring store");
    keyring_core::set_default_store(store);
}

#[derive(Debug, thiserror::Error)]
#[error("keychain: {0}")]
pub struct SecretError(#[from] Error);

/// Tests and CI only: keep secrets in a plain JSON file instead of the OS keychain.
/// Never set this on a real machine — the file is not encrypted.
const TEST_FILE_ENV: &str = "PAMA_SECRETS_FILE";

fn test_file() -> Option<std::path::PathBuf> {
    std::env::var_os(TEST_FILE_ENV).map(Into::into)
}

fn file_map(p: &std::path::Path) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// All secrets live in ONE keychain item (a JSON object) so a process asks for keychain access
/// at most once, however many secrets it needs. Items written by older versions (one per key)
/// are read as a fallback and folded into the bundle on first use.
const BUNDLE: &str = "secrets";

type Bundle = serde_json::Map<String, serde_json::Value>;

static CACHE: std::sync::Mutex<Option<Bundle>> = std::sync::Mutex::new(None);

fn load_bundle() -> Result<Bundle, SecretError> {
    match Entry::new(SERVICE, BUNDLE)?.get_password() {
        Ok(v) => Ok(serde_json::from_str(&v).unwrap_or_default()),
        Err(Error::NoEntry) => Ok(Bundle::new()),
        Err(e) => Err(e.into()),
    }
}

fn save_bundle(m: &Bundle) -> Result<(), SecretError> {
    Entry::new(SERVICE, BUNDLE)?.set_password(&serde_json::to_string(m).unwrap_or_default())?;
    Ok(())
}

fn with_bundle<T>(f: impl FnOnce(&mut Bundle) -> Result<T, SecretError>) -> Result<T, SecretError> {
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(load_bundle()?);
    }
    f(guard.as_mut().expect("bundle loaded"))
}

/// Store a secret under `key` (e.g. `device-token:<server>` or `provider.anthropic.key`).
pub fn set(key: &str, value: &str) -> Result<(), SecretError> {
    if let Some(p) = test_file() {
        let mut m = file_map(&p);
        m.insert(key.into(), value.into());
        let _ = std::fs::write(&p, serde_json::to_string(&m).unwrap_or_default());
        return Ok(());
    }
    with_bundle(|m| {
        m.insert(key.into(), value.into());
        save_bundle(m)
    })?;
    // A stale per-key item from an older version must not shadow or outlive the new value.
    let _ = delete_legacy(key);
    Ok(())
}

pub fn get(key: &str) -> Result<Option<String>, SecretError> {
    if let Some(p) = test_file() {
        return Ok(file_map(&p)
            .get(key)
            .and_then(|v| v.as_str())
            .map(String::from));
    }
    if let Some(v) = with_bundle(|m| Ok(m.get(key).and_then(|v| v.as_str()).map(String::from)))? {
        return Ok(Some(v));
    }
    match Entry::new(SERVICE, key)?.get_password() {
        Ok(v) => {
            // Migrate: fold the legacy item into the bundle, then drop it.
            if set(key, &v).is_ok() {
                let _ = delete_legacy(key);
            }
            Ok(Some(v))
        }
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Whether a secret exists. Reads the bundle (one keychain access per process), then checks for
/// a legacy item by attributes only, which never prompts.
pub fn exists(key: &str) -> Result<bool, SecretError> {
    if let Some(p) = test_file() {
        return Ok(file_map(&p).contains_key(key));
    }
    if with_bundle(|m| Ok(m.contains_key(key)))? {
        return Ok(true);
    }
    match Entry::new(SERVICE, key)?.get_attributes() {
        Ok(_) => Ok(true),
        Err(Error::NoEntry) => Ok(false),
        Err(e) => Err(e.into()),
    }
}

fn delete_legacy(key: &str) -> Result<(), SecretError> {
    match Entry::new(SERVICE, key)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn delete(key: &str) -> Result<(), SecretError> {
    if let Some(p) = test_file() {
        let mut m = file_map(&p);
        m.remove(key);
        let _ = std::fs::write(&p, serde_json::to_string(&m).unwrap_or_default());
        return Ok(());
    }
    with_bundle(|m| {
        if m.remove(key).is_some() {
            save_bundle(m)?;
        }
        Ok(())
    })?;
    delete_legacy(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_with_mock_store() {
        use_mock_store();
        assert_eq!(get("provider.anthropic.key").unwrap(), None);
        set("provider.anthropic.key", "sk-test").unwrap();
        assert_eq!(
            get("provider.anthropic.key").unwrap().as_deref(),
            Some("sk-test")
        );
        assert!(exists("provider.anthropic.key").unwrap());
        delete("provider.anthropic.key").unwrap();
        assert!(!exists("provider.anthropic.key").unwrap());
        assert_eq!(get("provider.anthropic.key").unwrap(), None);
    }
}
