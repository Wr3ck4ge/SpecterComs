/* tslint:disable */
/* eslint-disable */

export class JsAddMemberResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    commit: Uint8Array;
    device_state: Uint8Array;
    welcome: Uint8Array;
}

export class JsDecryptResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    device_state: Uint8Array;
    plaintext: Uint8Array;
}

export class JsEncryptResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    ciphertext: Uint8Array;
    device_state: Uint8Array;
}

export class JsNewIdentity {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    device_state: Uint8Array;
    key_package: Uint8Array;
}

/**
 * Adds one or more new devices to an existing group this device is
 * already a member of, in a single Commit. `key_packages_framed` is one or
 * more KeyPackages framed as [4B LE length][bytes] each, concatenated —
 * see frame_key_packages.
 */
export function add_member(device_state: Uint8Array, group_id: Uint8Array, key_packages_framed: Uint8Array): JsAddMemberResult;

/**
 * Creates a brand-new MLS group (this device is the sole initial member),
 * keyed by `group_id` (the app's channel_id / conversation_id, as raw
 * bytes — e.g. the UUID's bytes).
 */
export function create_group(device_state: Uint8Array, group_id: Uint8Array): Uint8Array;

/**
 * Decrypts an incoming MLS application message for `group_id`.
 */
export function decrypt(device_state: Uint8Array, group_id: Uint8Array, ciphertext: Uint8Array): JsDecryptResult;

/**
 * Encrypts `plaintext` as an MLS application message for `group_id`.
 */
export function encrypt(device_state: Uint8Array, group_id: Uint8Array, plaintext: Uint8Array): JsEncryptResult;

/**
 * Derives a fixed-length secret from the group's current epoch via MLS's
 * exporter mechanism (RFC 9420 §8.5) — used to key non-MLS-native traffic
 * (e.g. video frames) with a secret that still rotates every epoch.
 */
export function export_secret(device_state: Uint8Array, group_id: Uint8Array, label: string, length: number): Uint8Array;

/**
 * Frames one or more KeyPackage byte buffers into the format add_member
 * expects, so JS doesn't need to hand-roll the [4B LE length][bytes]
 * encoding itself.
 */
export function frame_key_packages(key_packages: Uint8Array[]): Uint8Array;

/**
 * Generates a fresh MLS device identity (signature keypair + Basic
 * credential) and a KeyPackage advertising it. Call once per device, on
 * first run; persist `device_state` locally (private key material) and
 * publish `key_package` to the server.
 */
export function generate_identity(device_label: string): JsNewIdentity;

/**
 * Generates an additional KeyPackage for an existing device (e.g. to
 * replenish after one is consumed by an add, or when a fresh one is
 * requested).
 */
export function generate_key_package(device_state: Uint8Array): JsNewIdentity;

/**
 * The group's current epoch, as u64 — note the caller submits `epoch + 1`
 * as the *target* epoch when relaying a Commit produced from this state.
 */
export function group_epoch(device_state: Uint8Array, group_id: Uint8Array): bigint;

/**
 * Whether this device already holds local state for `group_id`.
 */
export function group_exists(device_state: Uint8Array, group_id: Uint8Array): boolean;

/**
 * Every current member's credential string — see group_member_labels_impl.
 */
export function group_member_labels(device_state: Uint8Array, group_id: Uint8Array): string[];

/**
 * Processes an incoming Welcome message to join a group as a new member
 * device.
 */
export function join_from_welcome(device_state: Uint8Array, welcome_bytes: Uint8Array): Uint8Array;

/**
 * Applies an incoming Commit (an add or remove authored by another
 * member's device) to this device's copy of the group.
 */
export function process_commit(device_state: Uint8Array, group_id: Uint8Array, commit_bytes: Uint8Array): Uint8Array;

/**
 * Removes one or more devices from a group in a single Commit, each
 * identified by the credential string it advertised at generate_identity
 * time.
 */
export function remove_member(device_state: Uint8Array, group_id: Uint8Array, device_labels: string[]): JsAddMemberResult;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_get_jsaddmemberresult_commit: (a: number) => [number, number];
    readonly __wbg_get_jsaddmemberresult_device_state: (a: number) => [number, number];
    readonly __wbg_get_jsaddmemberresult_welcome: (a: number) => [number, number];
    readonly __wbg_jsaddmemberresult_free: (a: number, b: number) => void;
    readonly __wbg_jsdecryptresult_free: (a: number, b: number) => void;
    readonly __wbg_jsencryptresult_free: (a: number, b: number) => void;
    readonly __wbg_jsnewidentity_free: (a: number, b: number) => void;
    readonly __wbg_set_jsaddmemberresult_commit: (a: number, b: number, c: number) => void;
    readonly __wbg_set_jsaddmemberresult_device_state: (a: number, b: number, c: number) => void;
    readonly __wbg_set_jsaddmemberresult_welcome: (a: number, b: number, c: number) => void;
    readonly add_member: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly create_group: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly decrypt: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly encrypt: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly export_secret: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly frame_key_packages: (a: number, b: number) => [number, number];
    readonly generate_identity: (a: number, b: number) => [number, number, number];
    readonly generate_key_package: (a: number, b: number) => [number, number, number];
    readonly group_epoch: (a: number, b: number, c: number, d: number) => [bigint, number, number];
    readonly group_exists: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly group_member_labels: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly join_from_welcome: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly process_commit: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly remove_member: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly __wbg_get_jsdecryptresult_device_state: (a: number) => [number, number];
    readonly __wbg_get_jsdecryptresult_plaintext: (a: number) => [number, number];
    readonly __wbg_get_jsencryptresult_ciphertext: (a: number) => [number, number];
    readonly __wbg_get_jsencryptresult_device_state: (a: number) => [number, number];
    readonly __wbg_get_jsnewidentity_device_state: (a: number) => [number, number];
    readonly __wbg_get_jsnewidentity_key_package: (a: number) => [number, number];
    readonly __wbg_set_jsdecryptresult_device_state: (a: number, b: number, c: number) => void;
    readonly __wbg_set_jsdecryptresult_plaintext: (a: number, b: number, c: number) => void;
    readonly __wbg_set_jsencryptresult_ciphertext: (a: number, b: number, c: number) => void;
    readonly __wbg_set_jsencryptresult_device_state: (a: number, b: number, c: number) => void;
    readonly __wbg_set_jsnewidentity_device_state: (a: number, b: number, c: number) => void;
    readonly __wbg_set_jsnewidentity_key_package: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
