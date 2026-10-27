use openmls::prelude::*;
use openmls::prelude::tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::signatures::Signer;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

mod owner;
pub use owner::{device_state_credential, device_state_owner};

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

/// How many past epochs' message secrets every group keeps, so an
/// application message that arrives just after a commit (sent before the
/// sender saw it, or delivered late) still decrypts. Bounded on purpose:
/// keeping old secrets weakens forward secrecy for exactly this window.
const MAX_PAST_EPOCHS: usize = 5;

/// Join config for every group this device holds — create_group_impl, Welcome
/// joins and external joins all use it, and load_group_upgraded() moves
/// groups stored before it existed onto it.
fn join_config() -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder()
        .use_ratchet_tree_extension(true)
        .max_past_epochs(MAX_PAST_EPOCHS)
        .build()
}

const MESSAGE_SECRETS_STORAGE_LABEL: &[u8] = b"MessageSecrets";

/// A loaded group's configured past-epoch window. MlsGroupJoinConfig has no
/// public getter for it, but it is serde-serializable (that's how it's
/// stored), so read it from there.
fn past_epoch_window(group: &MlsGroup) -> usize {
    serde_json::to_value(group.configuration())
        .ok()
        .and_then(|v| v.get("max_past_epochs").and_then(|n| n.as_u64()))
        .unwrap_or(0) as usize
}

/// Loads `gid` for a state-changing operation, first moving a group stored by
/// an older build (max_past_epochs = 0) onto join_config(). OpenMLS only
/// sizes a group's past-secrets store at creation/join (its resize is
/// crate-private) and persists that size inside the serialized
/// MessageSecretsStore, so the stored `max_epochs` is raised directly —
/// exactly what MessageSecretsStore::resize does when growing. The join
/// config is rewritten through the public set_configuration. Idempotent; a
/// no-op for groups already on the current config.
fn load_group_upgraded(provider: &OpenMlsRustCrypto, gid: &GroupId) -> Result<MlsGroup, String> {
    let mut group = MlsGroup::load(provider.storage(), gid)
        .map_err(|e| e.to_string())?
        .ok_or("group not found in device state")?;
    if past_epoch_window(&group) >= MAX_PAST_EPOCHS {
        return Ok(group);
    }

    let gid_json = storage_key_for_group(gid)?;
    {
        let mut values = provider.storage().values.write().unwrap();
        let label_len = MESSAGE_SECRETS_STORAGE_LABEL.len();
        let key = values
            .keys()
            .find(|k| {
                k.starts_with(MESSAGE_SECRETS_STORAGE_LABEL)
                    && k.len() == label_len + gid_json.len() + STORAGE_VERSION_SUFFIX_LEN
                    && k[label_len..k.len() - STORAGE_VERSION_SUFFIX_LEN] == gid_json[..]
            })
            .cloned()
            .ok_or("message secrets missing for group")?;
        let mut store: serde_json::Value = serde_json::from_slice(&values[&key]).map_err(|e| e.to_string())?;
        let max_epochs = store.get_mut("max_epochs").ok_or("unexpected message secrets layout")?;
        if max_epochs.as_u64().unwrap_or(0) < MAX_PAST_EPOCHS as u64 {
            *max_epochs = serde_json::Value::from(MAX_PAST_EPOCHS as u64);
            values.insert(key, serde_json::to_vec(&store).map_err(|e| e.to_string())?);
        }
    }
    group
        .set_configuration(provider.storage(), &join_config())
        .map_err(|e| e.to_string())?;
    drop(group);

    MlsGroup::load(provider.storage(), gid)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "group not found in device state".to_string())
}

/// This device's own MLS credential content (`${userId}:${deviceId}`, see
/// generate_identity's device_label) — lets the caller check a loaded state
/// really belongs to the signed-in account before using it.
fn device_credential_impl(device_state: &[u8]) -> Result<String, String> {
    let state = load_device_state(device_state)?;
    let credential = state.credential.as_ref().ok_or("no credential in device state")?;
    Ok(String::from_utf8_lossy(credential.serialized_content()).into_owned())
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

// openmls_memory_storage (what OpenMlsRustCrypto's storage is) keys every
// entry as `label ++ serde_json(key) ++ u16 BE storage version` (see
// storage_key_for_group for how the GroupId part is obtained). Per-group
// entries embed serde_json(GroupId) in the key; these four labels are the
// only ones that are NOT group-scoped (device-wide key material), and the
// post-delete sweep below must never touch them.
const NON_GROUP_STORAGE_LABELS: &[&[u8]] = &[b"KeyPackage", b"Psk", b"EncryptionKeyPair", b"SignatureKeyPair"];
// Written exactly once per group (MlsGroup::store / every merge) — used to
// enumerate which groups this device holds.
const GROUP_STATE_STORAGE_LABEL: &[u8] = b"GroupState";

const OWN_LEAF_INDEX_STORAGE_LABEL: &[u8] = b"OwnLeafNodeIndex";
const STORAGE_VERSION_SUFFIX_LEN: usize = 2;

fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

/// The exact bytes the storage provider embeds in its keys for `gid`,
/// obtained by asking a scratch instance of the same storage to write one
/// group-keyed entry and reading the key back — so this always matches the
/// pinned openmls_memory_storage's own encoding, without this crate
/// re-implementing it (or depending on serde_json directly).
fn storage_key_for_group(gid: &GroupId) -> Result<Vec<u8>, String> {
    use openmls_traits::storage::StorageProvider as _;
    let scratch = OpenMlsRustCrypto::default();
    scratch
        .storage()
        .write_own_leaf_index(gid, &LeafNodeIndex::new(0))
        .map_err(|e| e.to_string())?;
    let values = scratch.storage().values.read().unwrap();
    let key = values.keys().next().ok_or("storage wrote no key")?;
    if !key.starts_with(OWN_LEAF_INDEX_STORAGE_LABEL)
        || key.len() < OWN_LEAF_INDEX_STORAGE_LABEL.len() + STORAGE_VERSION_SUFFIX_LEN
    {
        return Err("unexpected storage key layout".to_string());
    }
    Ok(key[OWN_LEAF_INDEX_STORAGE_LABEL.len()..key.len() - STORAGE_VERSION_SUFFIX_LEN].to_vec())
}

/// Inverse of storage_key_for_group, for listing. The encoding is
/// `<prefix>b0,b1,...<suffix>` (learned from encoding an empty GroupId);
/// every decoded candidate is re-encoded and compared, so anything that
/// doesn't round-trip exactly is ignored rather than misreported.
fn group_id_from_storage_key(encoded: &[u8], empty_encoding: &[u8]) -> Option<GroupId> {
    // Empty encoding is e.g. `{"value":{"vec":[]}}`: split it around "[]".
    let split = empty_encoding.windows(2).position(|w| w == b"[]")? + 1;
    let (prefix, suffix) = empty_encoding.split_at(split);
    let inner = encoded.strip_prefix(prefix)?.strip_suffix(suffix)?;
    let bytes: Vec<u8> = if inner.is_empty() {
        Vec::new()
    } else {
        std::str::from_utf8(inner)
            .ok()?
            .split(',')
            .map(|n| n.trim().parse::<u8>().ok())
            .collect::<Option<Vec<u8>>>()?
    };
    let gid = GroupId::from_slice(&bytes);
    (storage_key_for_group(&gid).ok()?.as_slice() == encoded).then_some(gid)
}

/// Drops ALL of this device's local state for one group — ratchet tree,
/// group context, epoch secrets, message secrets (secret tree), resumption
/// PSKs, join config, own leaf index/nodes, group state (incl. any pending
/// commit), queued proposals, and this epoch's HPKE leaf/path key pairs —
/// via OpenMLS's own `MlsGroup::delete`, followed by a defensive sweep of any
/// remaining storage entry whose key still embeds this GroupId (e.g. epoch
/// key pairs left behind for some other epoch by an interrupted merge, which
/// `MlsGroup::delete` only removes for the *current* epoch).
///
/// Purpose: self-healing for a device whose local copy of one group has
/// forked / become unusable. After this, `group_exists` is false for the
/// group, so the caller's catch-up path will `join_from_welcome` from a fresh
/// Welcome instead of keeping the broken tree. The device identity (signer,
/// credential), its unused KeyPackages, and every other group are untouched.
///
/// Missing group: a no-op — returns `device_state` unchanged (byte-for-byte),
/// so callers can treat it idempotently.
///
/// Note this is purely local: it does NOT remove this device's leaf from the
/// group as seen by other members. To be re-admitted, another member must
/// add a fresh KeyPackage of this device (typically remove_member of this
/// device's stale leaf + add_member in one or two commits) and the server
/// must deliver the resulting Welcome.
fn delete_group_impl(device_state: &[u8], group_id: &[u8]) -> Result<Vec<u8>, String> {
    let state = load_device_state(device_state)?;
    let provider = provider_from_state(&state);
    let gid = GroupId::from_slice(group_id);

    let mut group = match MlsGroup::load(provider.storage(), &gid).map_err(|e| e.to_string())? {
        Some(group) => group,
        None => return Ok(device_state.to_vec()),
    };
    group.delete(provider.storage()).map_err(|e| e.to_string())?;
    drop(group);

    let gid_json = storage_key_for_group(&gid)?;
    {
        let mut values = provider.storage().values.write().unwrap();
        values.retain(|key, _| {
            NON_GROUP_STORAGE_LABELS.iter().any(|label| key.starts_with(label))
                || !contains_subslice(key, &gid_json)
        });
    }

    let new_state = DeviceState {
        storage_values: provider.storage().values.read().unwrap().clone(),
        signer: state.signer,
        credential: state.credential,
    };
    save_device_state(&new_state)
}

/// Every group this device currently holds local state for, as the group id
/// bytes decoded as UTF-8 (the app's group ids are UTF-8 strings — see
/// mlsSession.js's `new TextEncoder().encode(groupIdStr)`; any non-UTF-8 id
/// is rendered lossily). Sorted, for stable diagnostics output.
fn group_ids_impl(device_state: &[u8]) -> Result<Vec<String>, String> {
    let state = load_device_state(device_state)?;
    let empty_encoding = storage_key_for_group(&GroupId::from_slice(&[]))?;
    let mut ids: Vec<String> = state
        .storage_values
        .keys()
        .filter(|key| {
            key.starts_with(GROUP_STATE_STORAGE_LABEL)
                && key.len() >= GROUP_STATE_STORAGE_LABEL.len() + STORAGE_VERSION_SUFFIX_LEN
        })
        .filter_map(|key| {
            let encoded = &key[GROUP_STATE_STORAGE_LABEL.len()..key.len() - STORAGE_VERSION_SUFFIX_LEN];
            group_id_from_storage_key(encoded, &empty_encoding)
        })
        .map(|gid| String::from_utf8_lossy(gid.as_slice()).into_owned())
        .collect();
    ids.sort();
    Ok(ids)
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
        .max_past_epochs(MAX_PAST_EPOCHS)
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
    /// GroupInfo (with ratchet tree) for the epoch this commit produces —
    /// uploaded with the commit so a device that isn't a member yet can
    /// external-join (see join_external_impl).
    pub group_info: Vec<u8>,
}

/// Signed GroupInfo for `group`'s current epoch, with the ratchet-tree and
/// external-pub extensions, so a joiner needs nothing else.
fn group_info_bytes(group: &MlsGroup, provider: &OpenMlsRustCrypto, signer: &SignatureKeyPair) -> Result<Vec<u8>, String> {
    group
        .export_group_info(provider.crypto(), signer, true)
        .map_err(|e| e.to_string())?
        .tls_serialize_detached()
        .map_err(|e| e.to_string())
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

    let mut group = load_group_upgraded(&provider, &GroupId::from_slice(group_id))?;

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
    let group_info = group_info_bytes(&group, &provider, &signer)?;

    let new_state = state_from_provider(&provider, signer, credential);
    Ok(AddMemberResult {
        device_state: save_device_state(&new_state)?,
        commit: commit_bytes,
        welcome: welcome_bytes,
        group_info,
    })
}

/// Removes one or more devices from a group in a single Commit, each
/// identified by the credential string it advertised at generate_identity
/// time (see group_member_labels_impl to discover current members' labels).
/// Every leaf carrying a listed label is removed (a device that lost its
/// state and external-joined again can briefly hold two leaves), except this
/// device's own leaf — so passing this device's own label removes only its
/// stale duplicates.
fn remove_member_impl(
    device_state: &[u8],
    group_id: &[u8],
    device_labels: &[String],
) -> Result<AddMemberResult, String> {
    let mut state = load_device_state(device_state)?;
    let signer = state.signer.take().ok_or("no signer in device state")?;
    let credential = state.credential.clone().ok_or("no credential in device state")?;
    let provider = provider_from_state(&state);

    let mut group = load_group_upgraded(&provider, &GroupId::from_slice(group_id))?;

    let own_index = group.own_leaf_index();
    let mut leaf_indices: Vec<LeafNodeIndex> = Vec::new();
    for label in device_labels {
        let target_bytes = label.as_bytes();
        let matches: Vec<LeafNodeIndex> = group
            .members()
            .filter(|m| m.credential.serialized_content() == target_bytes && m.index != own_index)
            .map(|m| m.index)
            .collect();
        if matches.is_empty() {
            return Err(format!("device_label '{label}' not found among current group members"));
        }
        for index in matches {
            if !leaf_indices.contains(&index) {
                leaf_indices.push(index);
            }
        }
    }

    let (commit, _welcome_option, _group_info) = group
        .remove_members(&provider, &signer, &leaf_indices)
        .map_err(|e| e.to_string())?;

    group.merge_pending_commit(&provider).map_err(|e| e.to_string())?;

    let commit_bytes = commit.tls_serialize_detached().map_err(|e| e.to_string())?;
    let group_info = group_info_bytes(&group, &provider, &signer)?;

    let new_state = state_from_provider(&provider, signer, credential);
    Ok(AddMemberResult {
        device_state: save_device_state(&new_state)?,
        commit: commit_bytes,
        welcome: Vec::new(),
        group_info,
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

    let staged_welcome = StagedWelcome::new_from_welcome(&provider, &join_config(), welcome, None)
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

    let mut group = load_group_upgraded(&provider, &GroupId::from_slice(group_id))?;

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

    let mut group = load_group_upgraded(&provider, &GroupId::from_slice(group_id))?;

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

    let mut group = load_group_upgraded(&provider, &GroupId::from_slice(group_id))?;

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

/// Signed GroupInfo for the group's current epoch (ratchet tree + external
/// pub included) — what a non-member needs to join_external, and what the
/// server keeps per group (mls_groups.group_info). Read-only: the device
/// state is unchanged.
fn export_group_info_impl(device_state: &[u8], group_id: &[u8]) -> Result<Vec<u8>, String> {
    let state = load_device_state(device_state)?;
    let signer = state.signer.as_ref().ok_or("no signer in device state")?;
    let provider = provider_from_state(&state);
    let group = MlsGroup::load(provider.storage(), &GroupId::from_slice(group_id))
        .map_err(|e| e.to_string())?
        .ok_or("group not found in device state")?;
    group_info_bytes(&group, &provider, signer)
}

pub struct ExternalJoinResult {
    pub device_state: Vec<u8>,
    /// The external Commit (an MLSMessage PublicMessage) — submitted like any
    /// other commit, targeting group_info's epoch + 1.
    pub commit: Vec<u8>,
    /// GroupInfo for the epoch the commit produces.
    pub group_info: Vec<u8>,
}

fn parse_group_info(group_info: &[u8]) -> Result<openmls::messages::group_info::VerifiableGroupInfo, String> {
    let mut reader = group_info;
    let message = MlsMessageIn::tls_deserialize(&mut reader).map_err(|e| e.to_string())?;
    match message.extract() {
        MlsMessageBodyIn::GroupInfo(group_info) => Ok(group_info),
        _ => Err("expected a GroupInfo message".to_string()),
    }
}

/// Joins a group from its GroupInfo by external commit (RFC 9420 §12.4.3.2),
/// with no Welcome and no existing member involved. The device's own leaf
/// is created from its signer/credential; if the tree still holds a leaf
/// with this device's signature key (a resync), OpenMLS removes it in the
/// same commit. `credential` must be the state's own credential — a guard
/// against joining with another account's device state.
///
/// Leaf lifetimes in the received tree are not validated: leaves of members
/// who never updated keep their KeyPackage's lifetime, which an
/// otherwise-healthy long-lived group can outlive, and refusing to join over
/// that would strand this device. Signatures and the tree itself are still
/// fully verified.
///
/// The commit is merged locally right away (OpenMLS's external-commit flow
/// has no pending state): if the server rejects it, the caller must discard
/// the returned device_state.
fn join_external_impl(device_state: &[u8], group_info: &[u8], credential: &str) -> Result<ExternalJoinResult, String> {
    let mut state = load_device_state(device_state)?;
    let signer = state.signer.take().ok_or("no signer in device state")?;
    let own_credential = state.credential.clone().ok_or("no credential in device state")?;
    if own_credential.serialized_content() != credential.as_bytes() {
        return Err("credential does not match this device state".to_string());
    }
    let provider = provider_from_state(&state);

    let verifiable_group_info = parse_group_info(group_info)?;
    let gid = verifiable_group_info.group_id().clone();
    if MlsGroup::load(provider.storage(), &gid).map_err(|e| e.to_string())?.is_some() {
        return Err("group already held locally (use resync_external)".to_string());
    }

    let credential_with_key = CredentialWithKey {
        credential: own_credential.clone(),
        signature_key: signer.public().into(),
    };
    let (group, bundle) = MlsGroup::external_commit_builder()
        .with_config(join_config())
        .skip_lifetime_validation()
        .build_group(&provider, verifiable_group_info, credential_with_key)
        .map_err(|e| e.to_string())?
        .load_psks(provider.storage())
        .map_err(|e| e.to_string())?
        .build(provider.rand(), provider.crypto(), &signer, |_| true)
        .map_err(|e| e.to_string())?
        .finalize(&provider)
        .map_err(|e| e.to_string())?;

    let commit = bundle.commit().tls_serialize_detached().map_err(|e| e.to_string())?;
    let group_info = group_info_bytes(&group, &provider, &signer)?;
    drop(group);

    let new_state = state_from_provider(&provider, signer, own_credential);
    Ok(ExternalJoinResult {
        device_state: save_device_state(&new_state)?,
        commit,
        group_info,
    })
}

/// Self-healing for a device whose copy of `group_id` diverged (can't apply
/// the server's commits, decrypts keep failing): drops all local state for
/// the group (delete_group_impl) and re-joins it by external commit from the
/// server's current GroupInfo. The commit removes this device's old leaf
/// (same signature key), so the group never holds a dead copy of it.
/// Identity and every other group are untouched.
fn resync_external_impl(device_state: &[u8], group_id: &[u8], group_info: &[u8]) -> Result<ExternalJoinResult, String> {
    let verifiable_group_info = parse_group_info(group_info)?;
    if verifiable_group_info.group_id().as_slice() != group_id {
        return Err("GroupInfo is for a different group".to_string());
    }
    let credential = device_credential_impl(device_state)?;
    let cleared = delete_group_impl(device_state, group_id)?;
    join_external_impl(&cleared, group_info, &credential)
}

/// The epoch an MLS message (application message or commit) was sent in,
/// read from its unencrypted header without decrypting or touching any
/// state — lets the caller tell "sent in an epoch I haven't reached yet"
/// (catch up, then retry) from "too old" or "corrupt".
fn message_epoch_impl(message: &[u8]) -> Result<u64, String> {
    let mut reader = message;
    let message_in = MlsMessageIn::tls_deserialize(&mut reader).map_err(|e| e.to_string())?;
    let protocol_message: ProtocolMessage = message_in.try_into_protocol_message().map_err(|e| e.to_string())?;
    Ok(protocol_message.epoch().as_u64())
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
    pub group_info: Vec<u8>,
}
impl From<AddMemberResult> for JsAddMemberResult {
    fn from(r: AddMemberResult) -> Self {
        Self { device_state: r.device_state, commit: r.commit, welcome: r.welcome, group_info: r.group_info }
    }
}

#[wasm_bindgen(getter_with_clone)]
pub struct JsExternalJoinResult {
    pub device_state: Vec<u8>,
    pub commit: Vec<u8>,
    pub group_info: Vec<u8>,
}
impl From<ExternalJoinResult> for JsExternalJoinResult {
    fn from(r: ExternalJoinResult) -> Self {
        Self { device_state: r.device_state, commit: r.commit, group_info: r.group_info }
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
/// Crosses into JS as a `bigint`. Throws "group not found in device state"
/// for a group this device doesn't hold (e.g. right after delete_group) —
/// check group_exists first. Useful for diagnostics: comparing it with the
/// server's latest epoch for the group shows whether this device is behind
/// (missed commits) or forked (same epoch, yet decrypts fail).
#[wasm_bindgen]
pub fn group_epoch(device_state: &[u8], group_id: &[u8]) -> Result<u64, JsValue> {
    group_epoch_impl(device_state, group_id).map_err(|e| JsValue::from_str(&e))
}

/// Removes ALL local state for one group (see delete_group_impl) and returns
/// the new device state to persist. Identity and other groups are
/// unaffected. No-op (returns the input unchanged) if the group isn't held.
/// Local only — other members must re-add this device (fresh KeyPackage →
/// Welcome) for it to rejoin.
#[wasm_bindgen]
pub fn delete_group(device_state: &[u8], group_id: &[u8]) -> Result<Vec<u8>, JsValue> {
    delete_group_impl(device_state, group_id).map_err(|e| JsValue::from_str(&e))
}

/// Every group id this device holds local state for (UTF-8 decoded, sorted)
/// — for diagnostics.
#[wasm_bindgen]
pub fn group_ids(device_state: &[u8]) -> Result<Vec<String>, JsValue> {
    group_ids_impl(device_state).map_err(|e| JsValue::from_str(&e))
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

/// Signed GroupInfo (with ratchet tree) for the group's current epoch — see
/// export_group_info_impl. Read-only.
#[wasm_bindgen]
pub fn export_group_info(device_state: &[u8], group_id: &[u8]) -> Result<Vec<u8>, JsValue> {
    export_group_info_impl(device_state, group_id).map_err(|e| JsValue::from_str(&e))
}

/// Joins a group this device doesn't hold from its GroupInfo, by external
/// commit — see join_external_impl. The returned state already has the
/// commit merged; adopt it only if the server accepts the commit.
#[wasm_bindgen]
pub fn join_external(device_state: &[u8], group_info: &[u8], credential: &str) -> Result<JsExternalJoinResult, JsValue> {
    join_external_impl(device_state, group_info, credential)
        .map(Into::into)
        .map_err(|e| JsValue::from_str(&e))
}

/// Drops this device's diverged copy of `group_id` and re-joins it by an
/// external commit that also removes its old leaf — see resync_external_impl.
/// Same adoption rule as join_external.
#[wasm_bindgen]
pub fn resync_external(device_state: &[u8], group_id: &[u8], group_info: &[u8]) -> Result<JsExternalJoinResult, JsValue> {
    resync_external_impl(device_state, group_id, group_info)
        .map(Into::into)
        .map_err(|e| JsValue::from_str(&e))
}

/// The epoch an MLS message was sent in, without decrypting it. Crosses into
/// JS as a `bigint`.
#[wasm_bindgen]
pub fn message_epoch(message: &[u8]) -> Result<u64, JsValue> {
    message_epoch_impl(message).map_err(|e| JsValue::from_str(&e))
}

/// This device's own credential content (`${userId}:${deviceId}`).
#[wasm_bindgen]
pub fn device_credential(device_state: &[u8]) -> Result<String, JsValue> {
    device_credential_impl(device_state).map_err(|e| JsValue::from_str(&e))
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
    /// Alice and Bob share groups A and B (both created by Alice).
    fn two_shared_groups() -> (Vec<u8>, Vec<u8>, NewIdentity) {
        let alice = generate_identity_impl("alice-device-1").expect("alice identity");
        let bob = generate_identity_impl("bob-device-1").expect("bob identity");
        let bob_kp2 = generate_key_package_impl(&bob.device_state).expect("bob kp 2");

        let mut alice_state = create_group_impl(&alice.device_state, b"group-A").expect("create A");
        alice_state = create_group_impl(&alice_state, b"group-B").expect("create B");

        let add_a = add_member_impl(&alice_state, b"group-A", &frame_bytes_list(&[&bob.key_package])).expect("add bob to A");
        let add_b = add_member_impl(&add_a.device_state, b"group-B", &frame_bytes_list(&[&bob_kp2.key_package]))
            .expect("add bob to B");
        let bob_state = join_from_welcome_impl(&bob_kp2.device_state, &add_a.welcome).expect("bob joins A");
        let bob_state = join_from_welcome_impl(&bob_state, &add_b.welcome).expect("bob joins B");
        (add_b.device_state, bob_state, alice)
    }

    fn keys_mentioning_group(device_state: &[u8], group_id: &[u8]) -> Vec<Vec<u8>> {
        let gid_json = storage_key_for_group(&GroupId::from_slice(group_id)).unwrap();
        load_device_state(device_state)
            .unwrap()
            .storage_values
            .keys()
            .filter(|k| contains_subslice(k, &gid_json))
            .cloned()
            .collect()
    }

    #[test]
    fn delete_group_leaves_identity_and_other_groups_working() {
        let (alice_state, bob_state, alice) = two_shared_groups();
        let pk_before = own_public_key_impl(&alice_state).expect("pk before");
        assert_eq!(group_ids_impl(&alice_state).unwrap(), vec!["group-A", "group-B"]);

        let alice_state = delete_group_impl(&alice_state, b"group-A").expect("delete A");

        assert!(!group_exists_impl(&alice_state, b"group-A").unwrap());
        assert!(group_exists_impl(&alice_state, b"group-B").unwrap());
        assert_eq!(group_ids_impl(&alice_state).unwrap(), vec!["group-B"]);
        assert!(encrypt_impl(&alice_state, b"group-A", b"x").is_err());
        assert!(group_epoch_impl(&alice_state, b"group-A").is_err());

        // Identity unchanged: same public key, signatures still verify.
        assert_eq!(own_public_key_impl(&alice_state).unwrap(), pk_before);
        assert_eq!(pk_before, own_public_key_impl(&alice.device_state).unwrap());
        let sig = sign_bytes_impl(&alice_state, b"frame").unwrap();
        assert!(verify_bytes_impl(&pk_before, b"frame", &sig));

        // Group B still works in both directions...
        let enc = encrypt_impl(&alice_state, b"group-B", b"still here").expect("alice encrypts B");
        let dec = decrypt_impl(&bob_state, b"group-B", &enc.ciphertext).expect("bob decrypts B");
        assert_eq!(dec.plaintext, b"still here");
        let enc2 = encrypt_impl(&dec.device_state, b"group-B", b"hi alice").expect("bob encrypts B");
        let dec2 = decrypt_impl(&enc.device_state, b"group-B", &enc2.ciphertext).expect("alice decrypts B");
        assert_eq!(dec2.plaintext, b"hi alice");

        // ...and still processes commits from another member.
        let carol = generate_identity_impl("carol-device-1").unwrap();
        let add_carol = add_member_impl(&enc2.device_state, b"group-B", &frame_bytes_list(&[&carol.key_package]))
            .expect("bob adds carol to B");
        let alice_state = process_commit_impl(&dec2.device_state, b"group-B", &add_carol.commit).expect("alice sees carol");
        assert_eq!(group_epoch_impl(&alice_state, b"group-B").unwrap(), 2);
        let carol_state = join_from_welcome_impl(&carol.device_state, &add_carol.welcome).expect("carol joins B");
        let enc3 = encrypt_impl(&alice_state, b"group-B", b"welcome carol").unwrap();
        assert_eq!(decrypt_impl(&carol_state, b"group-B", &enc3.ciphertext).unwrap().plaintext, b"welcome carol");
    }

    #[test]
    fn deleted_group_can_be_rejoined_from_fresh_welcome() {
        let (alice_state, bob_state, _alice) = two_shared_groups();
        let alice_state = delete_group_impl(&alice_state, b"group-A").expect("delete A");

        // Re-admission: Alice publishes a fresh KeyPackage; Bob removes her
        // stale leaf and adds the new one; Alice joins from the Welcome.
        let fresh = generate_key_package_impl(&alice_state).expect("fresh kp");
        let removed = remove_member_impl(&bob_state, b"group-A", &["alice-device-1".to_string()])
            .expect("bob removes stale alice leaf");
        let readd = add_member_impl(&removed.device_state, b"group-A", &frame_bytes_list(&[&fresh.key_package]))
            .expect("bob re-adds alice");
        let alice_state = join_from_welcome_impl(&fresh.device_state, &readd.welcome).expect("alice rejoins A");
        assert!(group_exists_impl(&alice_state, b"group-A").unwrap());
        assert_eq!(
            group_epoch_impl(&alice_state, b"group-A").unwrap(),
            group_epoch_impl(&readd.device_state, b"group-A").unwrap()
        );

        let enc = encrypt_impl(&readd.device_state, b"group-A", b"welcome back").expect("bob encrypts A");
        let dec = decrypt_impl(&alice_state, b"group-A", &enc.ciphertext).expect("alice decrypts A");
        assert_eq!(dec.plaintext, b"welcome back");
        let enc2 = encrypt_impl(&dec.device_state, b"group-A", b"thanks").expect("alice encrypts A");
        let bob_dec = decrypt_impl(&enc.device_state, b"group-A", &enc2.ciphertext).expect("bob decrypts A");
        assert_eq!(bob_dec.plaintext, b"thanks");

        // Group B was untouched by the whole dance.
        let enc_b = encrypt_impl(&enc2.device_state, b"group-B", b"B ok").unwrap();
        assert_eq!(decrypt_impl(&bob_dec.device_state, b"group-B", &enc_b.ciphertext).unwrap().plaintext, b"B ok");
    }

    #[test]
    fn delete_missing_group_is_a_byte_identical_noop() {
        let (alice_state, _bob_state, _alice) = two_shared_groups();
        let out = delete_group_impl(&alice_state, b"never-existed").expect("delete missing");
        assert_eq!(out, alice_state);

        // Idempotent: deleting twice == deleting once.
        let once = delete_group_impl(&alice_state, b"group-A").unwrap();
        let twice = delete_group_impl(&once, b"group-A").unwrap();
        assert_eq!(once, twice);

        // Also fine on an identity with no groups at all.
        let fresh = generate_identity_impl("lonely").unwrap();
        assert_eq!(delete_group_impl(&fresh.device_state, b"group-A").unwrap(), fresh.device_state);
        assert!(group_ids_impl(&fresh.device_state).unwrap().is_empty());
    }

    #[test]
    fn deleted_group_secrets_are_gone_from_serialized_state() {
        let (alice_state, _bob_state, _alice) = two_shared_groups();
        let before = load_device_state(&alice_state).unwrap();
        let a_keys = keys_mentioning_group(&alice_state, b"group-A");
        let b_keys = keys_mentioning_group(&alice_state, b"group-B");
        assert!(a_keys.len() >= 8, "expected many per-group entries for A, got {}", a_keys.len());

        // Secret-bearing values for A (epoch secrets, secret tree / message
        // secrets, HPKE epoch key pairs, resumption PSKs) — none may survive.
        // (Non-secret values like the join config are legitimately identical
        // to B's, so they're excluded from the byte search.)
        let secret_labels: [&[u8]; 4] = [b"EpochSecrets", b"MessageSecrets", b"EpochKeyPairs", b"ResumptionPsk"];
        let a_secret_values: Vec<(String, Vec<u8>)> = a_keys
            .iter()
            .filter(|k| secret_labels.iter().any(|l| k.starts_with(l)))
            .map(|k| (String::from_utf8_lossy(k).into_owned(), before.storage_values[k].clone()))
            .collect();
        assert!(a_secret_values.len() >= 3, "expected A's secret entries, got {}", a_secret_values.len());
        let a_export = export_secret_impl(&alice_state, b"group-A", "video", 32).unwrap();

        let after_bytes = delete_group_impl(&alice_state, b"group-A").unwrap();
        let after = load_device_state(&after_bytes).unwrap();

        assert!(keys_mentioning_group(&after_bytes, b"group-A").is_empty(), "storage entries keyed by A remain");
        for (key, value) in &a_secret_values {
            assert!(!contains_subslice(&after_bytes, value), "secret value of {key} survived deletion");
        }
        assert!(!contains_subslice(&after_bytes, &a_export));

        // Everything that is not A's is preserved exactly.
        for (k, v) in &before.storage_values {
            if !a_keys.contains(k) {
                assert_eq!(after.storage_values.get(k), Some(v), "non-A entry changed");
            }
        }
        assert_eq!(after.storage_values.len(), before.storage_values.len() - a_keys.len());
        for k in &b_keys {
            assert!(after.storage_values.contains_key(k));
        }
    }

    #[test]
    fn group_ids_lists_exactly_the_held_groups() {
        let alice = generate_identity_impl("alice-device-1").unwrap();
        let uuid = b"3f1c9a2e-7b4d-4e8a-9c1f-0a2b3c4d5e6f";
        let mut s = create_group_impl(&alice.device_state, uuid).unwrap();
        s = create_group_impl(&s, b"dm:a,b").unwrap();
        // Binary-ish id (comma byte, 0, 255) must still be decoded exactly.
        let binary = [0u8, 44, 255];
        s = create_group_impl(&s, &binary).unwrap();
        let ids = group_ids_impl(&s).unwrap();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&String::from_utf8_lossy(uuid).into_owned()));
        assert!(ids.contains(&"dm:a,b".to_string()));
        assert!(ids.contains(&String::from_utf8_lossy(&binary).into_owned()));
        let gid = GroupId::from_slice(&binary);
        let empty = storage_key_for_group(&GroupId::from_slice(&[])).unwrap();
        let decoded = group_id_from_storage_key(&storage_key_for_group(&gid).unwrap(), &empty).unwrap();
        assert_eq!(decoded.as_slice(), &binary);
    }

    /// Alice creates `gid` and adds Bob; returns (alice_state, bob_state, add result).
    fn alice_and_bob(gid: &[u8]) -> (Vec<u8>, Vec<u8>, AddMemberResult) {
        let alice = generate_identity_impl("alice:dev1").unwrap();
        let bob = generate_identity_impl("bob:dev1").unwrap();
        let alice_state = create_group_impl(&alice.device_state, gid).unwrap();
        let add = add_member_impl(&alice_state, gid, &frame_bytes_list(&[&bob.key_package])).unwrap();
        let bob_state = join_from_welcome_impl(&bob.device_state, &add.welcome).unwrap();
        (add.device_state.clone(), bob_state, add)
    }

    fn labels_sorted(state: &[u8], gid: &[u8]) -> Vec<String> {
        let mut labels = group_member_labels_impl(state, gid).unwrap();
        labels.sort();
        labels
    }

    #[test]
    fn external_join_needs_no_existing_member() {
        let gid = b"ext-join";
        let (alice_state, bob_state, add) = alice_and_bob(gid);
        assert_eq!(group_epoch_impl(&alice_state, gid).unwrap(), 1);

        // The GroupInfo uploaded with Alice's commit is all Carol needs.
        let carol = generate_identity_impl("carol:dev1").unwrap();
        let joined = join_external_impl(&carol.device_state, &add.group_info, "carol:dev1").expect("carol external join");
        assert_eq!(group_epoch_impl(&joined.device_state, gid).unwrap(), 2);
        assert_eq!(message_epoch_impl(&joined.commit).unwrap(), 1, "external commit targets the GroupInfo epoch");

        // Existing members apply it like any other commit.
        let alice_state = process_commit_impl(&alice_state, gid, &joined.commit).expect("alice applies external commit");
        let bob_state = process_commit_impl(&bob_state, gid, &joined.commit).expect("bob applies external commit");
        assert_eq!(labels_sorted(&alice_state, gid), vec!["alice:dev1", "bob:dev1", "carol:dev1"]);

        let enc = encrypt_impl(&joined.device_state, gid, b"hi from carol").unwrap();
        assert_eq!(decrypt_impl(&alice_state, gid, &enc.ciphertext).unwrap().plaintext, b"hi from carol");
        assert_eq!(decrypt_impl(&bob_state, gid, &enc.ciphertext).unwrap().plaintext, b"hi from carol");
        let enc2 = encrypt_impl(&alice_state, gid, b"welcome carol").unwrap();
        assert_eq!(decrypt_impl(&enc.device_state, gid, &enc2.ciphertext).unwrap().plaintext, b"welcome carol");

        // The joiner's own GroupInfo (new epoch) lets a fourth device in too.
        let dave = generate_identity_impl("dave:dev1").unwrap();
        let dave_join = join_external_impl(&dave.device_state, &joined.group_info, "dave:dev1").expect("dave joins");
        process_commit_impl(&enc2.device_state, gid, &dave_join.commit).expect("alice applies dave's join");
    }

    #[test]
    fn external_join_guards() {
        let gid = b"ext-guards";
        let (alice_state, bob_state, add) = alice_and_bob(gid);
        let carol = generate_identity_impl("carol:dev1").unwrap();
        // Another account's credential: refused.
        assert!(join_external_impl(&carol.device_state, &add.group_info, "mallory:dev1").is_err());
        // A device already holding the group must resync instead.
        assert!(join_external_impl(&bob_state, &add.group_info, "bob:dev1").is_err());
        // Garbage / wrong message type.
        assert!(join_external_impl(&carol.device_state, b"nope", "carol:dev1").is_err());
        assert!(join_external_impl(&carol.device_state, &add.commit, "carol:dev1").is_err());
        // A GroupInfo for another group can't be used to resync this one.
        assert!(resync_external_impl(&bob_state, b"some-other-group", &add.group_info).is_err());
        let exported = export_group_info_impl(&alice_state, gid).unwrap();
        assert!(join_external_impl(&carol.device_state, &exported, "carol:dev1").is_ok());
    }

    #[test]
    fn resync_after_divergence_replaces_the_old_leaf() {
        let gid = b"resync";
        let (alice_state, bob_state, _add) = alice_and_bob(gid);
        let carol = generate_identity_impl("carol:dev1").unwrap();
        let dave = generate_identity_impl("dave:dev1").unwrap();

        // Two commits Bob never sees (lost, or his copy forked).
        let add_carol = add_member_impl(&alice_state, gid, &frame_bytes_list(&[&carol.key_package])).unwrap();
        let carol_state = join_from_welcome_impl(&carol.device_state, &add_carol.welcome).unwrap();
        let add_dave = add_member_impl(&add_carol.device_state, gid, &frame_bytes_list(&[&dave.key_package])).unwrap();
        let carol_state = process_commit_impl(&carol_state, gid, &add_dave.commit).unwrap();
        let alice_state = add_dave.device_state.clone();

        // Bob is stuck at epoch 1: the epoch-3 message is ahead of him and the
        // epoch-3 commit doesn't apply.
        let msg = encrypt_impl(&alice_state, gid, b"epoch 3").unwrap();
        assert_eq!(message_epoch_impl(&msg.ciphertext).unwrap(), 3);
        assert_eq!(group_epoch_impl(&bob_state, gid).unwrap(), 1);
        assert!(decrypt_impl(&bob_state, gid, &msg.ciphertext).is_err());
        assert!(process_commit_impl(&bob_state, gid, &add_dave.commit).is_err());

        // Resync from the server's current GroupInfo.
        let resynced = resync_external_impl(&bob_state, gid, &add_dave.group_info).expect("bob resyncs");
        assert_eq!(group_epoch_impl(&resynced.device_state, gid).unwrap(), 4);
        let alice_state = process_commit_impl(&msg.device_state, gid, &resynced.commit).expect("alice applies resync");
        let carol_state = process_commit_impl(&carol_state, gid, &resynced.commit).expect("carol applies resync");
        // Same four devices — Bob's old leaf was removed, not duplicated.
        assert_eq!(labels_sorted(&alice_state, gid), vec!["alice:dev1", "bob:dev1", "carol:dev1", "dave:dev1"]);

        let enc = encrypt_impl(&alice_state, gid, b"bob is back").unwrap();
        assert_eq!(decrypt_impl(&resynced.device_state, gid, &enc.ciphertext).unwrap().plaintext, b"bob is back");
        let enc2 = encrypt_impl(&resynced.device_state, gid, b"thanks").unwrap();
        assert_eq!(decrypt_impl(&carol_state, gid, &enc2.ciphertext).unwrap().plaintext, b"thanks");
    }

    #[test]
    fn stale_duplicate_leaf_is_removed_by_own_label() {
        // A device that lost its state (new signature key, same device id)
        // external-joins; its dead leaf carries the same label.
        let gid = b"dupe";
        let (alice_state, _bob_state, add) = alice_and_bob(gid);
        let bob_again = generate_identity_impl("bob:dev1").unwrap();
        let joined = join_external_impl(&bob_again.device_state, &add.group_info, "bob:dev1").unwrap();
        let alice_state = process_commit_impl(&alice_state, gid, &joined.commit).unwrap();
        assert_eq!(labels_sorted(&joined.device_state, gid), vec!["alice:dev1", "bob:dev1", "bob:dev1"]);

        let cleaned = remove_member_impl(&joined.device_state, gid, &["bob:dev1".to_string()]).expect("remove stale leaf");
        assert_eq!(labels_sorted(&cleaned.device_state, gid), vec!["alice:dev1", "bob:dev1"]);
        let alice_state = process_commit_impl(&alice_state, gid, &cleaned.commit).unwrap();
        let enc = encrypt_impl(&alice_state, gid, b"still you").unwrap();
        assert_eq!(decrypt_impl(&cleaned.device_state, gid, &enc.ciphertext).unwrap().plaintext, b"still you");
    }

    #[test]
    fn past_epoch_messages_still_decrypt_within_the_window() {
        let gid = b"past-epochs";
        let (alice_state, bob_state, _add) = alice_and_bob(gid);
        // Alice sends at epoch 1, then moves the group on.
        let late = encrypt_impl(&alice_state, gid, b"sent at epoch 1").unwrap();
        let mut alice_state = late.device_state.clone();
        let mut bob_state = bob_state;
        for i in 0..2 {
            let other = generate_identity_impl(&format!("extra:{i}")).unwrap();
            let add = add_member_impl(&alice_state, gid, &frame_bytes_list(&[&other.key_package])).unwrap();
            bob_state = process_commit_impl(&bob_state, gid, &add.commit).unwrap();
            alice_state = add.device_state;
        }
        assert_eq!(group_epoch_impl(&bob_state, gid).unwrap(), 3);
        assert_eq!(message_epoch_impl(&late.ciphertext).unwrap(), 1);
        let dec = decrypt_impl(&bob_state, gid, &late.ciphertext).expect("epoch-1 message decrypts at epoch 3");
        assert_eq!(dec.plaintext, b"sent at epoch 1");

        // Beyond the window it's gone (forward secrecy).
        let old = encrypt_impl(&alice_state, gid, b"sent at epoch 3").unwrap();
        let mut alice_state = old.device_state.clone();
        for i in 0..(MAX_PAST_EPOCHS + 1) {
            let other = generate_identity_impl(&format!("more:{i}")).unwrap();
            let add = add_member_impl(&alice_state, gid, &frame_bytes_list(&[&other.key_package])).unwrap();
            bob_state = process_commit_impl(&bob_state, gid, &add.commit).unwrap();
            alice_state = add.device_state;
        }
        assert!(decrypt_impl(&bob_state, gid, &old.ciphertext).is_err());
    }

    #[test]
    fn groups_stored_by_older_builds_gain_the_past_epoch_window() {
        // Recreate exactly what the previous build stored: max_past_epochs 0.
        let gid = b"legacy-config";
        let legacy_join = MlsGroupJoinConfig::builder().use_ratchet_tree_extension(true).build();
        let alice = generate_identity_impl("alice:dev1").unwrap();
        let bob = generate_identity_impl("bob:dev1").unwrap();
        let alice_state = {
            let mut state = load_device_state(&alice.device_state).unwrap();
            let signer = state.signer.take().unwrap();
            let credential = state.credential.clone().unwrap();
            let provider = provider_from_state(&state);
            let config = MlsGroupCreateConfig::builder().ciphersuite(CIPHERSUITE).use_ratchet_tree_extension(true).build();
            let cwk = CredentialWithKey { credential: credential.clone(), signature_key: signer.public().into() };
            MlsGroup::new_with_group_id(&provider, &signer, &config, GroupId::from_slice(gid), cwk).unwrap();
            save_device_state(&state_from_provider(&provider, signer, credential)).unwrap()
        };
        let mut alice_state = alice_state;
        let add = add_member_impl(&alice_state, gid, &frame_bytes_list(&[&bob.key_package])).unwrap();
        alice_state = add.device_state;
        let bob_state = {
            let mut state = load_device_state(&bob.device_state).unwrap();
            let signer = state.signer.take().unwrap();
            let credential = state.credential.clone().unwrap();
            let provider = provider_from_state(&state);
            let mut reader = add.welcome.as_slice();
            let welcome = match MlsMessageIn::tls_deserialize(&mut reader).unwrap().extract() {
                MlsMessageBodyIn::Welcome(w) => w,
                _ => unreachable!(),
            };
            StagedWelcome::new_from_welcome(&provider, &legacy_join, welcome, None).unwrap().into_group(&provider).unwrap();
            save_device_state(&state_from_provider(&provider, signer, credential)).unwrap()
        };
        let legacy_window = |s: &[u8]| {
            let provider = provider_from_state(&load_device_state(s).unwrap());
            past_epoch_window(&MlsGroup::load(provider.storage(), &GroupId::from_slice(gid)).unwrap().unwrap())
        };
        assert_eq!(legacy_window(&bob_state), 0);

        // The stored legacy state still loads and works as before...
        let late = encrypt_impl(&alice_state, gid, b"before the commit").unwrap();
        let carol = generate_identity_impl("carol:dev1").unwrap();
        let add_carol = add_member_impl(&late.device_state, gid, &frame_bytes_list(&[&carol.key_package])).unwrap();
        // ...and the first state-changing call moves it onto the new window, so
        // the commit keeps epoch 1's secrets.
        let bob_state = process_commit_impl(&bob_state, gid, &add_carol.commit).unwrap();
        assert_eq!(legacy_window(&bob_state), MAX_PAST_EPOCHS);
        assert_eq!(decrypt_impl(&bob_state, gid, &late.ciphertext).unwrap().plaintext, b"before the commit");
        // Upgrading is idempotent and leaves current-epoch traffic intact.
        let enc = encrypt_impl(&add_carol.device_state, gid, b"now").unwrap();
        assert_eq!(decrypt_impl(&bob_state, gid, &enc.ciphertext).unwrap().plaintext, b"now");
    }

    #[test]
    fn message_epoch_and_credential_accessors() {
        let gid = b"accessors";
        let (alice_state, _bob_state, add) = alice_and_bob(gid);
        assert_eq!(device_credential_impl(&alice_state).unwrap(), "alice:dev1");
        assert_eq!(message_epoch_impl(&add.commit).unwrap(), 0);
        let enc = encrypt_impl(&alice_state, gid, b"x").unwrap();
        assert_eq!(message_epoch_impl(&enc.ciphertext).unwrap(), 1);
        assert!(message_epoch_impl(b"garbage").is_err());
        assert!(message_epoch_impl(&add.welcome).is_err());
        assert!(device_credential_impl(&[]).is_err());
    }

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
