/* tslint:disable */
/* eslint-disable */

/**
 * Receive side for one lane under one group secret. Keeps a bounded set of
 * per-(ssrc, session) keys and replay windows — reuse the same instance for
 * as long as the secret is unchanged (see matches_secret), or replay state
 * is lost.
 */
export class RelayAudioReceiver {
    free(): void;
    [Symbol.dispose](): void;
    matches_secret(group_secret: Uint8Array): boolean;
    constructor(group_secret: Uint8Array, is_global_broadcast: boolean);
    /**
     * Authenticate + replay-check + skew-check (vs Date.now()) + decrypt.
     * Errors are one of the stable codes "unsupported-version", "malformed",
     * "replay", "auth-failed", "stale-timestamp".
     */
    open(frame: Uint8Array, ssrc: number): Uint8Array;
    /**
     * open() with an explicit receiver clock — for the harness's skew tests.
     */
    open_at(frame: Uint8Array, ssrc: number, now_ms: number): Uint8Array;
    readonly is_global_broadcast: boolean;
    /**
     * Max accepted |sender timestamp − receiver clock| in ms.
     */
    readonly max_skew_ms: number;
    readonly session_count: number;
}

/**
 * One sending session for one lane (channel 'audio' export, or the event
 * 'audio-cascade' export when `is_global_broadcast`). Draws a fresh random
 * 128-bit session id at construction; owns its sequence counter.
 */
export class RelayAudioSender {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * True when `group_secret` is the secret this session was derived from —
     * lets a same-epoch key refresh keep the running session.
     */
    matches_secret(group_secret: Uint8Array): boolean;
    constructor(group_secret: Uint8Array, is_global_broadcast: boolean);
    /**
     * Returns the v3 wire payload:
     * [0x03 | session_id(16) | seq(8) | ts_ms(8) | ct | tag(16)], stamped
     * with the current wall clock (Date.now()).
     * `ssrc` must be the sender's canonical ssrc (what media-rust stamps).
     */
    seal(payload: Uint8Array, ssrc: number): Uint8Array;
    /**
     * seal() with an explicit sender clock (ms since the Unix epoch) — for
     * the Node harness's skew tests. Still clamped non-decreasing.
     */
    seal_at(payload: Uint8Array, ssrc: number, now_ms: number): Uint8Array;
    readonly is_global_broadcast: boolean;
    readonly session_id: Uint8Array;
}

export class SFrameCrypto {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Decrypt a frame: Expects [12-byte Nonce | Ciphertext | 16-byte Tag]
     */
    decrypt(encrypted_frame: Uint8Array): Uint8Array;
    /**
     * Encrypt a frame: Returns [12-byte Nonce | Ciphertext | 16-byte Tag]
     */
    encrypt(payload: Uint8Array): Uint8Array;
    /**
     * Initialize a new cipher with a 32-byte key
     */
    constructor(key: Uint8Array);
}

/**
 * Receive side for v2 share frames under one 'video' export. Replay windows
 * are per (sharer, kind, session); call reset() when a new subscription
 * starts (media-rust re-sends its cached keyframe to every new viewer).
 */
export class ShareFrameReceiver {
    free(): void;
    [Symbol.dispose](): void;
    matches_secret(video_secret: Uint8Array): boolean;
    constructor(video_secret: Uint8Array);
    /**
     * Authenticate + replay-check + skew-check (vs Date.now()) + decrypt one
     * v2 payload. `outer_flags` / `outer_ts` are the wire unit's (or
     * datagram's) flags byte and u32 timestamp; `sharer_user_id` is the
     * sharer this subscription targets (UUID string). `expected_kind` 0 =
     * any accepted kind, else the frame's kind must equal it. Errors are
     * stable codes: "unsupported-version", "unsupported-kind", "malformed",
     * "bad-user-id", "replay", "auth-failed", "stale-timestamp".
     */
    open(frame: Uint8Array, outer_flags: number, outer_ts: number, sharer_user_id: string, expected_kind: number): Uint8Array;
    /**
     * open() with an explicit receiver clock (tests).
     */
    open_at(frame: Uint8Array, outer_flags: number, outer_ts: number, sharer_user_id: string, expected_kind: number, now_ms: number): Uint8Array;
    reset(): void;
    /**
     * A sender for this user's own share under the same secret (S8), so the
     * JS side never needs to hold the raw export.
     */
    sender(kind: number, sharer_user_id: string): ShareFrameSender;
    readonly max_skew_ms: number;
    readonly session_count: number;
}

/**
 * One sending session for one kind (0x01 video, 0x02 share audio) of one
 * share: fresh random session id, own derived key and 64-bit counter.
 */
export class ShareFrameSender {
    free(): void;
    [Symbol.dispose](): void;
    matches_secret(video_secret: Uint8Array): boolean;
    /**
     * `video_secret`: the 32-byte MLS 'video' export (or the op key);
     * `sharer_user_id`: this user's id (UUID string).
     */
    constructor(video_secret: Uint8Array, kind: number, sharer_user_id: string);
    /**
     * Seals `payload` for the wire unit `[size][outer_flags][outer_ts][payload]`
     * (or the share-audio datagram), stamped with Date.now().
     */
    seal(payload: Uint8Array, outer_flags: number, outer_ts: number): Uint8Array;
    /**
     * seal() with an explicit sender clock (tests).
     */
    seal_at(payload: Uint8Array, outer_flags: number, outer_ts: number, now_ms: number): Uint8Array;
    readonly kind: number;
    readonly session_id: Uint8Array;
}

/**
 * Generates a secure random 32-byte key for group rotation
 */
export function generate_group_key(): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_relayaudioreceiver_free: (a: number, b: number) => void;
    readonly __wbg_relayaudiosender_free: (a: number, b: number) => void;
    readonly __wbg_sframecrypto_free: (a: number, b: number) => void;
    readonly __wbg_shareframereceiver_free: (a: number, b: number) => void;
    readonly __wbg_shareframesender_free: (a: number, b: number) => void;
    readonly generate_group_key: () => [number, number, number, number];
    readonly relayaudioreceiver_is_global_broadcast: (a: number) => number;
    readonly relayaudioreceiver_matches_secret: (a: number, b: number, c: number) => number;
    readonly relayaudioreceiver_max_skew_ms: (a: number) => number;
    readonly relayaudioreceiver_new: (a: number, b: number, c: number) => [number, number, number];
    readonly relayaudioreceiver_open: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly relayaudioreceiver_open_at: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly relayaudioreceiver_session_count: (a: number) => number;
    readonly relayaudiosender_is_global_broadcast: (a: number) => number;
    readonly relayaudiosender_matches_secret: (a: number, b: number, c: number) => number;
    readonly relayaudiosender_new: (a: number, b: number, c: number) => [number, number, number];
    readonly relayaudiosender_seal: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly relayaudiosender_seal_at: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly relayaudiosender_session_id: (a: number) => [number, number];
    readonly sframecrypto_decrypt: (a: number, b: number, c: number) => [number, number, number, number];
    readonly sframecrypto_encrypt: (a: number, b: number, c: number) => [number, number, number, number];
    readonly sframecrypto_new: (a: number, b: number) => [number, number, number];
    readonly shareframereceiver_matches_secret: (a: number, b: number, c: number) => number;
    readonly shareframereceiver_new: (a: number, b: number) => [number, number, number];
    readonly shareframereceiver_open: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly shareframereceiver_open_at: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly shareframereceiver_reset: (a: number) => void;
    readonly shareframereceiver_sender: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly shareframesender_kind: (a: number) => number;
    readonly shareframesender_matches_secret: (a: number, b: number, c: number) => number;
    readonly shareframesender_new: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly shareframesender_seal: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly shareframesender_seal_at: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly shareframesender_session_id: (a: number) => [number, number];
    readonly shareframereceiver_session_count: (a: number) => number;
    readonly shareframereceiver_max_skew_ms: (a: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
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
