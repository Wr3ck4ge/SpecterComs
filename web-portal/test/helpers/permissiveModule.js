// A mock module that answers ANY named export with a recorded async vi.fn,
// so the contract tests survive other packages adding imports to the module
// under test (MR1/MR2 are reshaping mlsSession / messageStore / api). Known
// exports get explicit behaviour via `impl`; everything else resolves to
// `fallback(name, args)`.
import { vi } from 'vitest';

export function permissive(impl = {}, fallback = () => undefined) {
  const fns = new Map(Object.entries(impl));
  const get = (name) => {
    if (!fns.has(name)) fns.set(name, vi.fn(async (...args) => fallback(name, args)));
    return fns.get(name);
  };
  return new Proxy({}, {
    has: (_t, k) => typeof k === 'string' && k !== 'then',
    get: (_t, k) => {
      // Not thenable, not an ES-module default namespace.
      if (typeof k !== 'string' || k === 'then' || k === '__esModule') return undefined;
      return get(k);
    },
    ownKeys: () => [...fns.keys()],
    getOwnPropertyDescriptor: (_t, k) => (typeof k === 'string' && k !== 'then'
      ? { configurable: true, enumerable: true, value: get(k) } : undefined),
  });
}

/** Every recorded call across a permissive object: [{ name, args }]. */
export function callsOf(mod, names) {
  return names.flatMap((n) => (mod[n]?.mock?.calls ?? []).map((args) => ({ name: n, args })));
}
