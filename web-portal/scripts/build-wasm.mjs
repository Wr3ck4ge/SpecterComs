// Rebuilds the committed WASM packages (web-portal/mls-crypto/pkg and
// web-portal/wasm-crypto/pkg) the way they have always been built:
//
//   cargo build --release --target wasm32-unknown-unknown
//   wasm-bindgen 0.2.126 --target web --out-dir pkg
//   wasm-opt -O            (npm wasm-opt@2.0.1 = binaryen 132)
//
// plus one addition: local paths are stripped. Without it, panic-location
// strings from dependencies embed the absolute crates.io registry path
// (e.g. C:\Users\<name>\.cargo\registry\src\...) in the .wasm, which leaks the
// build machine's user name into a file that is committed and published.
// --remap-path-prefix rewrites those to stable, user-independent prefixes;
// code generation is otherwise unchanged.
//
// Passed via CARGO_ENCODED_RUSTFLAGS (not RUSTFLAGS) because the repo path may
// contain spaces. Respects CARGO_TARGET_DIR if set.
//
// Run from anywhere:  node web-portal/scripts/build-wasm.mjs [mls-crypto|wasm-crypto]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WASM_BINDGEN_VERSION = '0.2.126';
const WASM_OPT_NPM = 'wasm-opt@2.0.1';

const webPortal = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(webPortal, '..');
const home = homedir();
const cargoHome = process.env.CARGO_HOME || path.join(home, '.cargo');
const isWin = process.platform === 'win32';

const crates = process.argv.slice(2).length ? process.argv.slice(2) : ['mls-crypto', 'wasm-crypto'];

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  // npx is a .cmd shim on Windows and needs a shell; quote args there since
  // the repo path may contain spaces.
  const shell = isWin && cmd === 'npx';
  const finalArgs = shell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
  execFileSync(cmd, finalArgs, { stdio: 'inherit', shell, ...opts });
}

const bindgenVersion = execFileSync('wasm-bindgen', ['--version'], { encoding: 'utf8' }).trim();
if (!bindgenVersion.endsWith(WASM_BINDGEN_VERSION)) {
  throw new Error(`need wasm-bindgen ${WASM_BINDGEN_VERSION} (cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION}), found "${bindgenVersion}"`);
}

// Later prefixes win when several match, so most specific last.
const remaps = [
  [home, '/home'],
  [cargoHome, '/cargo'],
  [repoRoot, '/specter'],
];
const existing = process.env.CARGO_ENCODED_RUSTFLAGS
  ? process.env.CARGO_ENCODED_RUSTFLAGS.split('\x1f')
  : (process.env.RUSTFLAGS || '').split(/\s+/).filter(Boolean);
const rustflags = [...existing, ...remaps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`)];
const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: rustflags.join('\x1f') };
delete env.RUSTFLAGS;

const targetDir = process.env.CARGO_TARGET_DIR || null;

for (const crate of crates) {
  const crateDir = path.join(webPortal, crate);
  const manifest = path.join(crateDir, 'Cargo.toml');
  if (!existsSync(manifest)) throw new Error(`no crate at ${crateDir}`);
  const libName = crate.replace(/-/g, '_');

  run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', manifest], { env });

  const outRoot = targetDir || path.join(crateDir, 'target');
  const rawWasm = path.join(outRoot, 'wasm32-unknown-unknown', 'release', `${libName}.wasm`);
  const pkg = path.join(crateDir, 'pkg');
  run('wasm-bindgen', ['--target', 'web', '--out-dir', pkg, rawWasm]);

  const bg = path.join(pkg, `${libName}_bg.wasm`);
  run('npx', ['-y', WASM_OPT_NPM, '-O', bg, '-o', bg]);

  const bytes = readFileSync(bg).toString('latin1');
  for (const [from] of remaps) {
    if (bytes.includes(from)) throw new Error(`${bg} still contains local path ${from}`);
  }
  console.log(`ok: ${path.relative(repoRoot, pkg)}`);
}
