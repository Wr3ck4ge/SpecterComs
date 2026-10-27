// owner.rs — who a stored device state belongs to, read natively.
//
// The desktop client used to keep one MLS state per PC; it now keeps one per
// account (web-portal/src-tauri/src/mls_store.rs). Migrating the old per-PC
// state needs to know which account it belongs to without a login or a JS
// runtime, and the only trustworthy answer is the state's own credential,
// "<userId>:<deviceId>" (mlsSession.js credentialFor). Read-only: nothing
// here touches groups or re-serializes the state.

use super::load_device_state;

/// The credential string this device state advertises
/// ("<userId>:<deviceId>"). Errors if the bytes aren't a device state or the
/// state has no identity yet.
pub fn device_state_credential(device_state: &[u8]) -> Result<String, String> {
    if device_state.is_empty() {
        return Err("empty device state".to_string());
    }
    let state = load_device_state(device_state)?;
    let credential = state.credential.ok_or("no credential in device state")?;
    String::from_utf8(credential.serialized_content().to_vec())
        .map_err(|_| "credential is not UTF-8".to_string())
}

/// The user id part of the state's credential (everything before the first
/// ':'). Errors if the credential isn't in "<userId>:<deviceId>" form.
pub fn device_state_owner(device_state: &[u8]) -> Result<String, String> {
    let credential = device_state_credential(device_state)?;
    match credential.split_once(':') {
        Some((user, device)) if !user.is_empty() && !device.is_empty() => Ok(user.to_string()),
        _ => Err("credential is not in userId:deviceId form".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generate_identity_impl;

    #[test]
    fn owner_is_read_from_the_credential() {
        let id = generate_identity_impl("user-123:device-456").unwrap();
        assert_eq!(device_state_credential(&id.device_state).unwrap(), "user-123:device-456");
        assert_eq!(device_state_owner(&id.device_state).unwrap(), "user-123");
    }

    #[test]
    fn malformed_inputs_are_errors() {
        assert!(device_state_owner(&[]).is_err());
        assert!(device_state_owner(b"not a device state").is_err());
        let id = generate_identity_impl("no-separator").unwrap();
        assert!(device_state_owner(&id.device_state).is_err());
    }
}
