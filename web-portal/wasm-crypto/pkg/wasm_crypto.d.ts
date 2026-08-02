/* tslint:disable */
/* eslint-disable */

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
 * Generates a secure random 32-byte key for group rotation
 */
export function generate_group_key(): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_sframecrypto_free: (a: number, b: number) => void;
    readonly generate_group_key: () => [number, number, number, number];
    readonly sframecrypto_decrypt: (a: number, b: number, c: number) => [number, number, number, number];
    readonly sframecrypto_encrypt: (a: number, b: number, c: number) => [number, number, number, number];
    readonly sframecrypto_new: (a: number, b: number) => [number, number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
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
