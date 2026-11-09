// ESM loader hooks for scripts/test-chat-engine.mjs: load src/engine/
// useChannelChat.js under plain node with its app dependencies (React, the
// API client, IndexedDB message store, MLS session) swapped for the
// in-memory stubs next to this file, and Vite-style extensionless relative
// imports resolved to .js.
const STUBS = {
  react: './react.mjs',
  '../api': './api.mjs',
  '../messageStore': './messageStore.mjs',
  '../mlsSession': './mlsSession.mjs',
};

export async function resolve(specifier, context, next) {
  if (context.parentURL?.includes('/src/engine/useChannelChat.js') && STUBS[specifier]) {
    return { url: new URL(STUBS[specifier], import.meta.url).href, shortCircuit: true };
  }
  if (/^\.\.?\//.test(specifier) && !/\.[cm]?js$/.test(specifier) && context.parentURL?.includes('/src/')) {
    return next(`${specifier}.js`, context);
  }
  return next(specifier, context);
}
