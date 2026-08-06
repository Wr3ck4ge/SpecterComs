use openmls::prelude::*;
use openmls::prelude::tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::signatures::Signer;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
const SIGNATURE_SCHEME: SignatureScheme = SignatureScheme::ED25519;

// Core logic below returns plain `Result<T, String>` and is exercised directly
// by the native `#[test]`s. `wasm_bindgen::JsValue` only works inside a real
// JS runtime — most of its operations panic on a native target — so the
// JsValue conversion happens only in the thin `#[wasm_bindgen]` wrappers at
// the bottom of this file, which are never called from tests.

/// Everything needed to resume as this device: the MLS provider's storage
/// (ratchet trees, epoch secrets, pending state for every group this device
/// is in) plus the device's own signer keypair and credential. Opaque to the
/// JS side — persisted as a single blob per device (e.g. in IndexedDB).
#[derive(Serialize, Deserialize, Default)]
struct DeviceState {
    storage_values: std::collections::HashMap<Vec<u8>, Vec<u8>>,
    signer: Option<SignatureKeyPair>,
    credential: Option<Credential>,
}

fn provider_from_state(state: &DeviceState) -> OpenMlsRustCrypto {
    let provider = OpenMlsRustCrypto::default();
    {
        let mut values = provider.storage().values.write().unwrap();
        for (k, v) in &state.storage_values {
            values.insert(k.clone(), v.clone());
        }
    }
    provider
}

fn state_from_provider(
    provider: &OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: Credential,
) -> DeviceState {
    let storage_values = provider.storage().values.read().unwrap().clone();
    DeviceState {
        storage_values,
        signer: Some(signer),
        credential: Some(credential),
    }
}

/// Multiple KeyPackages (e.g. every device belonging to a user being added
/// to a group at once) are passed across the wasm-bindgen boundary as a
/// single framed buffer — [4B LE length][bytes], repeated — rather than a
/// nested array type, since wasm-bindgen doesn't support Vec<Vec<u8>>
/// directly. JS builds this framing when assembling the add-member request.
fn frame_bytes_list(items: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::new();
    for item in items {
        out.extend_from_slice(&(item.len() as u32).to_le_bytes());
        out.extend_from_slice(item);
    }
    out
}

fn decode_framed(bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if i + 4 > bytes.len() {
            return Err("truncated length prefix in framed buffer".to_string());
        }
        let len = u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
        i += 4;
        if i + len > bytes.len() {
            return Err("truncated entry in framed buffer".to_string());
        }
        out.push(bytes[i..i + len].to_vec());
        i += len;
    }
    Ok(out)
}

fn load_device_state(bytes: &[u8]) -> Result<DeviceState, String> {
    if bytes.is_empty() {
        return Ok(DeviceState::default());
    }
    bincode::deserialize(bytes).map_err(|e| e.to_string())
}

fn save_device_state(state: &DeviceState) -> Result<Vec<u8>, String> {
    bincode::serialize(state).map_err(|e| e.to_string())
}

pub struct NewIdentity {
    pub device_state: Vec<u8>,
    pub key_package: Vec<u8>,
}

fn generate_identity_impl(device_label: &str) -> Result<NewIdentity, String> {
    let provider = OpenMlsRustCrypto::default();
    let signer = SignatureKeyPair::new(SIGNATURE_SCHEME).map_err(|e| e.to_string())?;
    let credential = BasicCredential::new(device_label.as_bytes().to_vec());
    let credential_with_key = CredentialWithKey {
        credential: credential.clone().into(),
        signature_key: signer.public().into(),
    };

    let key_package_bundle = KeyPackage::builder()
        .build(CIPHERSUITE, &provider, &signer, credential_with_key)
        .map_err(|e| e.to_string())?;

    let key_package_bytes = key_package_bundle
        .key_package()
        .tls_serialize_detached()
        .map_err(|e| e.to_string())?;

    let state = state_from_provider(&provider, signer, credential.into());
    let device_state = save_device_state(&state)?;

    Ok(NewIdentity {
        device_state,
        key_package: key_package_bytes,
    })
}

fn generate_key_package_impl(device_state: &[u8]) -> Result<NewIdentity, String> {
    let mut state = load_device_state(device_state)?;
    let signer = state.signer.take().ok_or("no signer in device state")?;
    let credential = state.credential.clone().ok_or("no credential in device state")?;
    let provider = provider_from_state(&state);

    let credential_with_key = CredentialWithKey {
        credential: credential.clone(),
        signature_key: signer.public().into(),
    };
    let key_package_bundle = KeyPackage::builder()
        .build(CIPHERSUITE, &provider, &signer, credential_with_key)
        .map_err(|e| e.to_string())?;
    let key_package_bytes = key_package_bundle
        .key_package()
        .tls_serialize_detached()
        .map_err(|e| e.to_string())?;

    let new_state = state_from_provider(&provider, signer, credential);
    Ok(NewIdentity {
        device_state: save_device_state(&new_state)?,
        key_package: key_package_bytes,
    })
}

/// Whether this device already holds local state for `group_id` — lets the
/// caller decide between create_group (first time) and just re-using what's
/// already there, without needing its own separate JS-side bookkeeping.
fn group_exists_impl(device_state: &[u8], group_id: &[u8]) -> Result<bool, String> {
    let state = load_device_state(device_state)?;
    let provider = provider_from_state(&state);
    MlsGroup::load(provider.storage(), &GroupId::from_slice(group_id))
        .map(|opt| opt.is_some())
        .map_err(|e| e.to_string())
}

/// Every current member's credential string (see generate_identity's
/// device_label) — lets the caller reconcile a group's actual membership
/// against who's supposed to be in it (e.g. current org members' devices)
/// without the server tracking MLS membership itself.
fn group_member_labels_impl(device_state: &[u8], group_id: &[u8]) -> Result<Vec<String>, String> {
    let state = load_device_state(device_state)?;
    let provider = provider_from_state(&state);
    let group = MlsGroup::load(provider.storage(), &GroupId::from_slice(group_id))
        .map_err(|e| e.to_string())?
        .ok_or("group not found in device state")?;

    Ok(group
        .members()
        .map(|m| String::from_utf8_lossy(m.credential.serialized_content()).into_owned())
        .collect())
}

/// The group's current epoch — the caller submits `epoch + 1` as the target
/// epoch when relaying a Commit produced from this state (see
/// mlsGroupController.ts's Delivery Service ordering check).
fn group_epoch_impl(device_state: &[u8], group_id: &[u8]) -> Result<u64, String> {
    let state = load_device_state(device_state)?;
    let provider = provider_from_state(&state);
    let group = MlsGroup::load(provider.storage(), &GroupId::from_slice(group_id))
        .map_err(|e| e.to_string())?
        .ok_or("group not found in device state")?;
    Ok(group.epoch().as_u64())
}

fn create_group_impl(device_state: &[u8], group_id: &[u8]) -> Result<Vec<u8>, String> {
    let mut state = load_device_state(device_state)?;
    let signer = state.signer.take().ok_or("no signer in device state")?;
    let credential = state.credential.clone().ok_or("no credential in device state")?;
    let provider = provider_from_state(&state);

    let credential_with_key = CredentialWithKey {
        credential: credential.clone(),
        signature_key: signer.public().into(),
    };

    let mls_group_create_config = MlsGroupCreateConfig::builder()
        .ciphersuite(CIPHERSUITE)
        .use_ratchet_tree_extension(true)
        .build();

    MlsGroup::new_with_group_id(
        &provider,
        &signer,
        &mls_group_create_config,
        GroupId::from_slice(group_id),
        credential_with_key,
    )
    .map_err(|e| e.to_string())?;

    let new_state = state_from_provider(&provider, signer, credential);
    save_device_state(&new_state)
}

pub struct AddMemberResult {
    pub device_state: Vec<u8>,
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
}

/// `key_packages_framed` holds one or more KeyPackages — e.g. every active
/// device belonging to the user being added — framed per decode_framed's
/// format, so they're all added in a single Commit/epoch bump rather than
/// one round-trip per device.
fn add_member_impl(
    device_state: &[u8],
    group_id: &[u8],
    key_packages_framed: &[u8],
) -> Result<AddMemberResult, String> {
    let mut state = load_device_state(device_state)?;
    let signer = state.signer.take().ok_or("no signer in device state")?;
    let credential = state.credential.clone().ok_or("no credential in device state")?;
    let provider = provider_from_state(&state);

    let mut group = MlsGroup::load(provider.storage(), &GroupId::from_slice(group_id))
        .map_err(|e| e.to_string())?
        .ok_or("group not found in device state")?;

    let key_packages: Vec<KeyPackage> = decode_framed(key_packages_framed)?
        .into_iter()
        .map(|kp_bytes| {
            let mut reader = kp_bytes.as_slice();
            let key_package_in = KeyPackageIn::tls_deserialize(&mut reader).map_err(|e| e.to_string())?;
            key_package_in
                .validate(provider.crypto(), ProtocolVersion::Mls10)
                .map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;

    let (commit, welcome, _group_info) = group
        .add_members(&provider, &signer, &key_packages)
        .map_err(|e| e.to_string())?;

    group.merge_pending_commit(&provider).map_err(|e| e.to_string())?;

    let commit_bytes = commit.tls_serialize_detached().map_err(|e| e.to_string())?;
    let welcome_bytes = welcome.tls_serialize_detached().map_err(|e| e.to_string())?;

    let new_state = state_from_provider(&provider, signer, credential);
    Ok(AddMemberResult {
        device_state: save_device_state(&new_state)?,
        commit: commit_bytes,
        welcome: welcome_bytes,
    })
}

/// Removes one or more devices from a group in a single Commit, each
/// identified by the credential string it advertised at generate_identity
/// time (see group_member_labels_impl to discover current members' labels).
fn remove_member_impl(
    device_state: &[u8],
    group_id: &[u8],
    device_labels: &[String],
) -> Result<AddMemberResult, String> {
    let mut state = load_device_state(device_state)?;
    let signer = state.signer.take().ok_or("no signer in device state")?;
    let credential = state.credential.clone().ok_or("no credential in device state")?;
    let provider = provider_from_state(&state);

    let mut group = MlsGroup::load(provider.storage(), &GroupId::from_slice(group_id))
        .map_err(|e| e.to_string())?
        .ok_or("group not found in device state")?;

    let leaf_indices: Vec<LeafNodeIndex> = device_labels
        .iter()
        .map(|label| {
            let target_bytes = label.as_bytes();
            group
                .members()
                .find(|m| m.credential.serialized_content() == target_bytes)
                .map(|m| m.index)
                .ok_or_else(|| format!("device_label '{label}' not found among current group members"))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let (commit, _welcome_option, _group_info) = group
        .remove_members(&provider, &signer, &leaf_indices)
        .map_err(|e| e.to_string())?;

    group.merge_pending_commit(&provider).map_err(|e| e.to_string())?;

    let commit_bytes = commit.tls_serialize_detached().map_err(|e| e.to_string())?;

    let new_state = state_from_provider(&provider, signer, credential);
    Ok(AddMemberResult {
        device_state: save_device_state(&new_state)?,
        commit: commit_bytes,
        welcome: Vec::new(),
    })
}

fn join_from_welcome_impl(device_state: &[u8], welcome_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut state = load_device_state(device_state)?;
    let signer = state.signer.take().ok_or("no signer in device state")?;
    let credential = state.credential.clone().ok_or("no credential in device state")?;
    let provider = provider_from_state(&state);

    let mut welcome_reader = welcome_bytes;
    let mls_message_in = MlsMessageIn::tls_deserialize(&mut welcome_reader).map_err(|e| e.to_string())?;
    let welcome = match mls_message_in.extract() {
        MlsMessageBodyIn::Welcome(welcome) => welcome,
        _ => return Err("expected a Welcome message".to_string()),
    };

    let join_config = MlsGroupJoinConfig::builder()
        .use_ratchet_tree_extension(true)
        .build();
    let staged_welcome = StagedWelcome::new_from_welcome(&provider, &join_config, welcome, None)
        .map_err(|e| e.to_string())?;
    staged_welcome.into_group(&provider).map_err(|e| e.to_string())?;

    let new_state = state_from_provider(&provider, signer, credential);
    save_device_state(&new_state)
}

fn process_commit_impl(device_state: &[u8], group_id: &[u8], commit_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut state = load_device_state(device_state)?;
    let signer = state.signer.take().ok_or("no signer in device state")?;
    let credential = state.credential.clone().ok_or("no credential in device state")?;
    let provider = provider_from_state(&state);

    let mut group = MlsGroup::load(provider.storage(), &GroupId::from_slice(group_id))
        .map_err(|e| e.to_string())?
        .ok_or("group not found in device state")?;

    let mut commit_reader = commit_bytes;
    let mls_message_in = MlsMessageIn::tls_deserialize(&mut commit_reader).map_err(|e| e.to_string())?;
    let protocol_message: ProtocolMessage = mls_message_in
        .try_into_protocol_message()
        .map_err(|e| e.to_string())?;

    let processed = group
        .process_message(&provider, protocol_message)
        .map_err(|e| e.to_string())?;

    match processed.into_content() {
        ProcessedMessageContent::StagedCommitMessage(staged_commit) => {
            group
                .merge_staged_commit(&provider, *staged_commit)
                .map_err(|e| e.to_string())?;
        }
        _ => return Err("expected a Commit message".to_string()),
    }

    let new_state = state_from_provider(&provider, signer, credential);
    save_device_state(&new_state)
}

pub struct EncryptResult {
    pub device_state: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

fn encrypt_impl(device_state: &[u8], group_id: &[u8], plaintext: &[u8]) -> Result<EncryptResult, String> {
    let mut state = load_device_state(device_state)?;
    let signer = state.signer.take().ok_or("no signer in device state")?;
    let credential = state.credential.clone().ok_or("no credential in device state")?;
    let provider = provider_from_state(&state);

    let mut group = MlsGroup::load(provider.storage(), &GroupId::from_slice(group_id))
        .map_err(|e| e.to_string())?
        .ok_or("group not found in device state")?;

    let message_out = group
        .create_message(&provider, &signer, plaintext)
        .map_err(|e| e.to_string())?;
    let ciphertext = message_out.tls_serialize_detached().map_err(|e| e.to_string())?;

    let new_state = state_from_provider(&provider, signer, credential);
    Ok(EncryptResult {
        device_state: save_device_state(&new_state)?,
        ciphertext,
    })
}

pub struct DecryptResult {
    pub device_state: Vec<u8>,
    pub plaintext: Vec<u8>,
}

/// pub (unlike the other *_impl helpers) so a native consumer of this crate
/// — web-portal/src-tauri's background message-sync task — can decrypt
/// incoming channel messages directly, without a wasm-bindgen/JS boundary.
/// See src-tauri/src/msgcache.rs.
pub fn decrypt_impl(device_state: &[u8], group_id: &[u8], ciphertext: &[u8]) -> Result<DecryptResult, String> {
    let mut state = load_device_state(device_state)?;
    let signer = state.signer.take().ok_or("no signer in device state")?;
    let credential = state.credential.clone().ok_or("no credential in device state")?;
    let provider = provider_from_state(&state);

    let mut group = MlsGroup::load(provider.storage(), &GroupId::from_slice(group_id))
        .map_err(|e| e.to_string())?
        .ok_or("group not found in device state")?;

    let mut ciphertext_reader = ciphertext;
    let mls_message_in = MlsMessageIn::tls_deserialize(&mut ciphertext_reader).map_err(|e| e.to_string())?;
    let protocol_message: ProtocolMessage = mls_message_in
        .try_into_protocol_message()
        .map_err(|e| e.to_string())?;

    let processed = group
        .process_message(&provider, protocol_message)
        .map_err(|e| e.to_string())?;

    let plaintext = match processed.into_content() {
        ProcessedMessageContent::ApplicationMessage(app_msg) => app_msg.into_bytes(),
        _ => return Err("expected an application message".to_string()),
    };

    let new_state = state_from_provider(&provider, signer, credential);
    Ok(DecryptResult {
        device_state: save_device_state(&new_state)?,
        plaintext,
    })
}

fn export_secret_impl(
    device_state: &[u8],
    group_id: &[u8],
    label: &str,
    length: usize,
) -> Result<Vec<u8>, String> {
    let state = load_device_state(device_state)?;
    let provider = provider_from_state(&state);

    let group = MlsGroup::load(provider.storage(), &GroupId::from_slice(group_id))
        .map_err(|e| e.to_string())?
        .ok_or("group not found in device state")?;

    group
        .export_secret(provider.crypto(), label, &[], length)
        .map_err(|e| e.to_string())
}

/// Signs arbitrary bytes with this device's Ed25519 MLS signature key — used
/// to authenticate voice frames end-to-end (see AudioFrame.sender_signature
/// in the proto) as coming from this specific device, independent of and in
/// addition to SFrame's AEAD confidentiality/integrity (which alone proves
/// "encrypted with the right group key," not "this specific device sent it").
/// Doesn't touch any group's ratchet state, so device_state is unchanged —
/// unlike encrypt/decrypt/commit, there's no updated state to persist.
fn sign_bytes_impl(device_state: &[u8], message: &[u8]) -> Result<Vec<u8>, String> {
    let state = load_device_state(device_state)?;
    let signer = state.signer.as_ref().ok_or("no signer in device state")?;
    signer.sign(message).map_err(|e| format!("{:?}", e))
}

/// This device's own Ed25519 public key (the counterpart to sign_bytes) —
/// distributed to other devices (e.g. alongside the existing KeyPackage
/// exchange) so they can verify frames this device signs.
fn own_public_key_impl(device_state: &[u8]) -> Result<Vec<u8>, String> {
    let state = load_device_state(device_state)?;
    let signer = state.signer.as_ref().ok_or("no signer in device state")?;
    Ok(signer.public().to_vec())
}

/// Verifies a signature produced by sign_bytes against a known public key.
/// Pure function of its arguments — the verifier doesn't need their own MLS
/// device state to check someone else's signature, just the claimed sender's
/// public key (see own_public_key_impl).
fn verify_bytes_impl(public_key: &[u8], message: &[u8], signature: &[u8]) -> bool {
    let provider = OpenMlsRustCrypto::default();
    provider.crypto().verify_signature(SIGNATURE_SCHEME, message, public_key, signature).is_ok()
}

// ── wasm-bindgen boundary: thin wrappers converting String errors to JsValue ──

#[wasm_bindgen(getter_with_clone)]
pub struct JsNewIdentity {
    pub device_state: Vec<u8>,
    pub key_package: Vec<u8>,
}
impl From<NewIdentity> for JsNewIdentity {
    fn from(r: NewIdentity) -> Self {
        Self { device_state: r.device_state, key_package: r.key_package }
    }
}

#[wasm_bindgen(getter_with_clone)]
pub struct JsAddMemberResult {
    pub device_state: Vec<u8>,
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
}
impl From<AddMemberResult> for JsAddMemberResult {
    fn from(r: AddMemberResult) -> Self {
        Self { device_state: r.device_state, commit: r.commit, welcome: r.welcome }
    }
}

#[wasm_bindgen(getter_with_clone)]
pub struct JsEncryptResult {
    pub device_state: Vec<u8>,
    pub ciphertext: Vec<u8>,
}
impl From<EncryptResult> for JsEncryptResult {
    fn from(r: EncryptResult) -> Self {
        Self { device_state: r.device_state, ciphertext: r.ciphertext }
    }
}

#[wasm_bindgen(getter_with_clone)]
pub struct JsDecryptResult {
    pub device_state: Vec<u8>,
    pub plaintext: Vec<u8>,
}
impl From<DecryptResult> for JsDecryptResult {
    fn from(r: DecryptResult) -> Self {
        Self { device_state: r.device_state, plaintext: r.plaintext }
    }
}

/// Generates a fresh MLS device identity (signature keypair + Basic
/// credential) and a KeyPackage advertising it. Call once per device, on
/// first run; persist `device_state` locally (private key material) and
/// publish `key_package` to the server.
#[wasm_bindgen]
pub fn generate_identity(device_label: &str) -> Result<JsNewIdentity, JsValue> {
    generate_identity_impl(device_label).map(Into::into).map_err(|e| JsValue::from_str(&e))
}

/// Whether this device already holds local state for `group_id`.
#[wasm_bindgen]
pub fn group_exists(device_state: &[u8], group_id: &[u8]) -> Result<bool, JsValue> {
    group_exists_impl(device_state, group_id).map_err(|e| JsValue::from_str(&e))
}

/// Every current member's credential string — see group_member_labels_impl.
#[wasm_bindgen]
pub fn group_member_labels(device_state: &[u8], group_id: &[u8]) -> Result<Vec<String>, JsValue> {
    group_member_labels_impl(device_state, group_id).map_err(|e| JsValue::from_str(&e))
}

/// The group's current epoch, as u64 — note the caller submits `epoch + 1`
/// as the *target* epoch when relaying a Commit produced from this state.
#[wasm_bindgen]
pub fn group_epoch(device_state: &[u8], group_id: &[u8]) -> Result<u64, JsValue> {
    group_epoch_impl(device_state, group_id).map_err(|e| JsValue::from_str(&e))
}

/// Generates an additional KeyPackage for an existing device (e.g. to
/// replenish after one is consumed by an add, or when a fresh one is
/// requested).
#[wasm_bindgen]
pub fn generate_key_package(device_state: &[u8]) -> Result<JsNewIdentity, JsValue> {
    generate_key_package_impl(device_state).map(Into::into).map_err(|e| JsValue::from_str(&e))
}

/// Creates a brand-new MLS group (this device is the sole initial member),
/// keyed by `group_id` (the app's channel_id / conversation_id, as raw
/// bytes — e.g. the UUID's bytes).
#[wasm_bindgen]
pub fn create_group(device_state: &[u8], group_id: &[u8]) -> Result<Vec<u8>, JsValue> {
    create_group_impl(device_state, group_id).map_err(|e| JsValue::from_str(&e))
}

/// Adds one or more new devices to an existing group this device is
/// already a member of, in a single Commit. `key_packages_framed` is one or
/// more KeyPackages framed as [4B LE length][bytes] each, concatenated —
/// see frame_key_packages.
#[wasm_bindgen]
pub fn add_member(
    device_state: &[u8],
    group_id: &[u8],
    key_packages_framed: &[u8],
) -> Result<JsAddMemberResult, JsValue> {
    add_member_impl(device_state, group_id, key_packages_framed)
        .map(Into::into)
        .map_err(|e| JsValue::from_str(&e))
}

/// Frames one or more KeyPackage byte buffers into the format add_member
/// expects, so JS doesn't need to hand-roll the [4B LE length][bytes]
/// encoding itself.
#[wasm_bindgen]
pub fn frame_key_packages(key_packages: Vec<js_sys::Uint8Array>) -> Vec<u8> {
    let owned: Vec<Vec<u8>> = key_packages.iter().map(|kp| kp.to_vec()).collect();
    let refs: Vec<&[u8]> = owned.iter().map(|v| v.as_slice()).collect();
    frame_bytes_list(&refs)
}

/// Removes one or more devices from a group in a single Commit, each
/// identified by the credential string it advertised at generate_identity
/// time.
#[wasm_bindgen]
pub fn remove_member(
    device_state: &[u8],
    group_id: &[u8],
    device_labels: Vec<String>,
) -> Result<JsAddMemberResult, JsValue> {
    remove_member_impl(device_state, group_id, &device_labels)
        .map(Into::into)
        .map_err(|e| JsValue::from_str(&e))
}

/// Processes an incoming Welcome message to join a group as a new member
/// device.
#[wasm_bindgen]
pub fn join_from_welcome(device_state: &[u8], welcome_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    join_from_welcome_impl(device_state, welcome_bytes).map_err(|e| JsValue::from_str(&e))
}

/// Applies an incoming Commit (an add or remove authored by another
/// member's device) to this device's copy of the group.
#[wasm_bindgen]
pub fn process_commit(device_state: &[u8], group_id: &[u8], commit_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    process_commit_impl(device_state, group_id, commit_bytes).map_err(|e| JsValue::from_str(&e))
}

/// Encrypts `plaintext` as an MLS application message for `group_id`.
#[wasm_bindgen]
pub fn encrypt(device_state: &[u8], group_id: &[u8], plaintext: &[u8]) -> Result<JsEncryptResult, JsValue> {
    encrypt_impl(device_state, group_id, plaintext).map(Into::into).map_err(|e| JsValue::from_str(&e))
}

/// Decrypts an incoming MLS application message for `group_id`.
#[wasm_bindgen]
pub fn decrypt(device_state: &[u8], group_id: &[u8], ciphertext: &[u8]) -> Result<JsDecryptResult, JsValue> {
    decrypt_impl(device_state, group_id, ciphertext).map(Into::into).map_err(|e| JsValue::from_str(&e))
}

/// Derives a fixed-length secret from the group's current epoch via MLS's
/// exporter mechanism (RFC 9420 §8.5) — used to key non-MLS-native traffic
/// (e.g. video frames) with a secret that still rotates every epoch.
#[wasm_bindgen]
pub fn export_secret(device_state: &[u8], group_id: &[u8], label: &str, length: usize) -> Result<Vec<u8>, JsValue> {
    export_secret_impl(device_state, group_id, label, length).map_err(|e| JsValue::from_str(&e))
}

/// Signs `message` with this device's Ed25519 MLS signature key.
#[wasm_bindgen]
pub fn sign_bytes(device_state: &[u8], message: &[u8]) -> Result<Vec<u8>, JsValue> {
    sign_bytes_impl(device_state, message).map_err(|e| JsValue::from_str(&e))
}

/// This device's own Ed25519 public key, for distribution to other devices.
#[wasm_bindgen]
pub fn own_public_key(device_state: &[u8]) -> Result<Vec<u8>, JsValue> {
    own_public_key_impl(device_state).map_err(|e| JsValue::from_str(&e))
}

/// Verifies a sign_bytes signature against a claimed sender's public key.
#[wasm_bindgen]
pub fn verify_bytes(public_key: &[u8], message: &[u8], signature: &[u8]) -> bool {
    verify_bytes_impl(public_key, message, signature)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_group_round_trip() {
        // Alice creates a group and adds Bob.
        let alice = generate_identity_impl("alice-device-1").expect("alice identity");
        let bob = generate_identity_impl("bob-device-1").expect("bob identity");

        let group_id = b"test-group-1".to_vec();
        let alice_state = create_group_impl(&alice.device_state, &group_id).expect("create group");

        let framed_bob_kp = frame_bytes_list(&[&bob.key_package]);
        let add_result = add_member_impl(&alice_state, &group_id, &framed_bob_kp).expect("add bob");

        // Bob joins from the Welcome.
        let bob_state = join_from_welcome_impl(&bob.device_state, &add_result.welcome).expect("bob joins");

        // Alice sends an application message; Bob decrypts it.
        let enc = encrypt_impl(&add_result.device_state, &group_id, b"hello bob").expect("encrypt");
        let dec = decrypt_impl(&bob_state, &group_id, &enc.ciphertext).expect("decrypt");
        assert_eq!(dec.plaintext, b"hello bob");

        // Exporter secrets match on both sides for the same epoch.
        let alice_secret = export_secret_impl(&enc.device_state, &group_id, "video", 32).expect("alice export");
        let bob_secret = export_secret_impl(&dec.device_state, &group_id, "video", 32).expect("bob export");
        assert_eq!(alice_secret, bob_secret);
    }

    #[test]
    fn removed_member_cannot_decrypt_future_messages() {
        // Alice creates a 3-member group with Bob and Carol.
        let alice = generate_identity_impl("alice-device-1").expect("alice identity");
        let bob = generate_identity_impl("bob-device-1").expect("bob identity");
        let carol = generate_identity_impl("carol-device-1").expect("carol identity");

        let group_id = b"test-group-2".to_vec();
        let mut alice_state = create_group_impl(&alice.device_state, &group_id).expect("create group");

        let framed_bob_kp = frame_bytes_list(&[&bob.key_package]);
        let add_bob = add_member_impl(&alice_state, &group_id, &framed_bob_kp).expect("add bob");
        alice_state = add_bob.device_state;
        let bob_state = join_from_welcome_impl(&bob.device_state, &add_bob.welcome).expect("bob joins");

        let framed_carol_kp = frame_bytes_list(&[&carol.key_package]);
        let add_carol = add_member_impl(&alice_state, &group_id, &framed_carol_kp).expect("add carol");
        alice_state = add_carol.device_state;
        let bob_state = process_commit_impl(&bob_state, &group_id, &add_carol.commit).expect("bob sees carol add");
        let carol_state = join_from_welcome_impl(&carol.device_state, &add_carol.welcome).expect("carol joins");

        // Alice removes Carol.
        let remove_carol = remove_member_impl(&alice_state, &group_id, &["carol-device-1".to_string()])
            .expect("remove carol");
        alice_state = remove_carol.device_state;
        let bob_state = process_commit_impl(&bob_state, &group_id, &remove_carol.commit).expect("bob sees removal");

        // Alice sends a post-removal message; Bob (still a member) reads it fine.
        let enc = encrypt_impl(&alice_state, &group_id, b"carol should not see this").expect("encrypt");
        let dec = decrypt_impl(&bob_state, &group_id, &enc.ciphertext).expect("bob decrypts");
        assert_eq!(dec.plaintext, b"carol should not see this");

        // Carol's stale group state can no longer produce a working decrypt
        // for the new epoch (her ratchet never advanced past her removal).
        let carol_result = decrypt_impl(&carol_state, &group_id, &enc.ciphertext);
        assert!(carol_result.is_err(), "removed member must not be able to decrypt post-removal traffic");
    }

    #[test]
    fn add_multiple_devices_in_one_commit() {
        // A user with two logged-in devices gets both added to a DM group
        // in a single Commit/epoch bump, as add_member is meant to support.
        let alice = generate_identity_impl("alice-device-1").expect("alice identity");
        let bob_phone = generate_identity_impl("bob-phone").expect("bob phone identity");
        let bob_laptop = generate_identity_impl("bob-laptop").expect("bob laptop identity");

        let group_id = b"test-group-3".to_vec();
        let alice_state = create_group_impl(&alice.device_state, &group_id).expect("create group");

        let framed = frame_bytes_list(&[&bob_phone.key_package, &bob_laptop.key_package]);
        let add_result = add_member_impl(&alice_state, &group_id, &framed).expect("add both bob devices");

        let phone_state =
            join_from_welcome_impl(&bob_phone.device_state, &add_result.welcome).expect("phone joins");
        let laptop_state =
            join_from_welcome_impl(&bob_laptop.device_state, &add_result.welcome).expect("laptop joins");

        let enc = encrypt_impl(&add_result.device_state, &group_id, b"hi both devices").expect("encrypt");
        let dec_phone = decrypt_impl(&phone_state, &group_id, &enc.ciphertext).expect("phone decrypts");
        let dec_laptop = decrypt_impl(&laptop_state, &group_id, &enc.ciphertext).expect("laptop decrypts");
        assert_eq!(dec_phone.plaintext, b"hi both devices");
        assert_eq!(dec_laptop.plaintext, b"hi both devices");
    }

    #[test]
    fn member_labels_and_multi_device_removal() {
        // Membership reconciliation (e.g. "this user left the org, remove
        // all their devices") needs to list current members and remove
        // several in one commit.
        let alice = generate_identity_impl("alice-device-1").expect("alice identity");
        let bob_phone = generate_identity_impl("bob-phone").expect("bob phone identity");
        let bob_laptop = generate_identity_impl("bob-laptop").expect("bob laptop identity");

        let group_id = b"test-group-6".to_vec();
        let alice_state = create_group_impl(&alice.device_state, &group_id).expect("create group");
        let framed = frame_bytes_list(&[&bob_phone.key_package, &bob_laptop.key_package]);
        let add_result = add_member_impl(&alice_state, &group_id, &framed).expect("add both bob devices");

        let mut labels = group_member_labels_impl(&add_result.device_state, &group_id).expect("labels");
        labels.sort();
        assert_eq!(labels, vec!["alice-device-1", "bob-laptop", "bob-phone"]);

        let remove_result = remove_member_impl(
            &add_result.device_state,
            &group_id,
            &["bob-phone".to_string(), "bob-laptop".to_string()],
        )
        .expect("remove both bob devices in one commit");

        let remaining = group_member_labels_impl(&remove_result.device_state, &group_id).expect("labels after");
        assert_eq!(remaining, vec!["alice-device-1"]);
    }

    #[test]
    fn group_exists_reflects_local_state() {
        let alice = generate_identity_impl("alice-device-1").expect("alice identity");
        let group_id = b"test-group-4".to_vec();

        assert!(!group_exists_impl(&alice.device_state, &group_id).expect("check before"));
        let alice_state = create_group_impl(&alice.device_state, &group_id).expect("create group");
        assert!(group_exists_impl(&alice_state, &group_id).expect("check after"));
        assert!(!group_exists_impl(&alice_state, b"some-other-group").expect("check unrelated"));
    }

    #[test]
    fn group_epoch_advances_by_one_per_commit() {
        let alice = generate_identity_impl("alice-device-1").expect("alice identity");
        let bob = generate_identity_impl("bob-device-1").expect("bob identity");
        let group_id = b"test-group-5".to_vec();

        let alice_state = create_group_impl(&alice.device_state, &group_id).expect("create group");
        assert_eq!(group_epoch_impl(&alice_state, &group_id).expect("epoch 0"), 0);

        let framed = frame_bytes_list(&[&bob.key_package]);
        let add_result = add_member_impl(&alice_state, &group_id, &framed).expect("add bob");
        assert_eq!(group_epoch_impl(&add_result.device_state, &group_id).expect("epoch 1"), 1);
    }

    // A device can never decrypt its own sent application message — the
    // sender-ratchet secret used to encrypt isn't retained for decryption on
    // the same leaf. Callers (e.g. a multi-device echo of a message this
    // same device just sent) must recognize their own messages and use the
    // plaintext they already have, rather than calling decrypt at all.
    #[test]
    fn sender_cannot_decrypt_own_message() {
        let alice = generate_identity_impl("alice-device-1").expect("alice identity");
        let group_id = b"self-decrypt-check".to_vec();
        let alice_state = create_group_impl(&alice.device_state, &group_id).expect("create group");

        let enc = encrypt_impl(&alice_state, &group_id, b"hello self").expect("encrypt");
        let result = decrypt_impl(&enc.device_state, &group_id, &enc.ciphertext);
        assert!(result.is_err(), "a device should not be able to decrypt its own sent message");
    }
}
