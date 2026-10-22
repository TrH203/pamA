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

/// Store a secret under `key` (e.g. `device-token:<server>` or `provider.anthropic.key`).
pub fn set(key: &str, value: &str) -> Result<(), SecretError> {
    Entry::new(SERVICE, key)?.set_password(value)?;
    Ok(())
}

pub fn get(key: &str) -> Result<Option<String>, SecretError> {
    match Entry::new(SERVICE, key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete(key: &str) -> Result<(), SecretError> {
    match Entry::new(SERVICE, key)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
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
        delete("provider.anthropic.key").unwrap();
        assert_eq!(get("provider.anthropic.key").unwrap(), None);
    }
}
