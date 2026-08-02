// Re-run this whenever fleetyards or scunpacked-data adds ships, to check
// whether any new ship's default `slug.replace(/-/g,'_')` filename guess
// (see scunpackedSync.ts's fetchShipData) actually 404s against the real
// scunpacked-data ships/ directory, and — if so — whether a confident
// correction can be derived automatically.
//
// Usage: node --loader ts-node/esm src/scripts/verifyShipSlugAliases.ts
//
// This only ever PRINTS a report — it never writes to the database or edits
// scunpackedSync.ts for you. Review the TIER 3 (and any new TIER 1/2)
// results by hand before adding them to SHIP_SLUG_ALIASES; a wrong pairing
// would show one ship's stats under another ship's name, which is worse
// than just showing "no data".
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://specter_admin:admin_password_123@localhost:5433/specter_prod',
});

const SCUNPACKED_SHIPS_DIR_API = 'https://api.github.com/repos/StarCitizenWiki/scunpacked-data/contents/ships';

// Keep this list in sync with SHIP_SLUG_ALIASES in scunpackedSync.ts — used
// here only to report which ships are ALREADY aliased vs newly discovered,
// not to modify anything.
const KNOWN_ALIASES = new Set([
  'crus-a1-spirit', 'rsi-aurora-mk-ii', 'crus-c1-spirit', 'anvl-f7a-hornet-mk-i',
  'anvl-f7a-hornet-mk-ii', 'anvl-f7c-hornet-mk-ii', 'anvl-f8c-lightning',
  'anvl-f7c-hornet-wildfire-mk-i', 'rsi-zeus-mk-ii-cl', 'rsi-zeus-mk-ii-es',
  'orig-600i-explorer', 'drak-dragonfly-black', 'drak-dragonfly-yellowjacket',
  'argo-mpuv-cargo', 'argo-mpuv-personnel', 'argo-mpuv-tractor',
  'misc-reliant-kore', 'aegs-vanguard-warden',
  // See scunpackedSync.ts's SHIP_SLUG_ALIASES for the full explanation of each:
  'krig-l-21-wolf', 'krig-l-22-alpha-wolf', 'krig-p-52-merlin', 'krig-p-72-archimedes',
  'orig-890-jump', 'xnaa-san-tok-yai', 'grey-basher', 'grey-shiv',
  'mrai-fury', 'mrai-fury-lx', 'mrai-fury-mx', 'mrai-razor', 'mrai-razor-ex', 'mrai-razor-lx',
  'espr-blade', 'espr-glaive', 'espr-stinger', 'xnaa-nox', 'xnaa-nox-kue',
  'aegs-gladius-pirate-edition', 'anvl-f8c-lightning-executive-edition',
  'rsi-aurora-mk-i-cl', 'rsi-aurora-mk-i-es', 'rsi-aurora-mk-i-ln',
  'rsi-aurora-mk-i-lx', 'rsi-aurora-mk-i-mr', 'rsi-aurora-mk-i-se',
  'anvl-f7c-hornet-mk-i', 'anvl-f7c-m-super-hornet-mk-i', 'anvl-f7c-m-super-hornet-mk-ii',
  'anvl-f7c-m-super-hornet-heartseeker-mk-i', 'anvl-f7c-r-hornet-tracker-mk-i',
  'anvl-f7c-r-hornet-tracker-mk-ii', 'anvl-f7c-s-hornet-ghost-mk-i', 'anvl-f7c-s-hornet-ghost-mk-ii',
]);

const ROMAN_TO_ARABIC: Record<string, string> = { i: '1', ii: '2', iii: '3', iv: '4', v: '5' };

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[-_]/).filter(Boolean);
}

function normalizeTokens(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    const fused = t.match(/^mk([ivx]+|\d+)$/i);
    if (fused) {
      out.push('mk');
      const num = fused[1].toLowerCase();
      out.push(ROMAN_TO_ARABIC[num] || num);
      continue;
    }
    if (ROMAN_TO_ARABIC[t]) { out.push(ROMAN_TO_ARABIC[t]); continue; }
    out.push(t);
  }
  return out;
}

function tokenSet(tokens: string[]): Set<string> { return new Set(tokens); }
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
function stripMark(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'mk') { i++; continue; }
    out.push(tokens[i]);
  }
  return out;
}

async function main() {
  console.log('Fetching game_ships slugs from the database...');
  const dbRes = await pool.query(`SELECT slug, name FROM game_ships WHERE game = 'star_citizen' ORDER BY slug`);
  const ships: { slug: string; name: string }[] = dbRes.rows;
  console.log(`  ${ships.length} ships in game_ships.`);

  console.log('Fetching scunpacked-data ships/ directory listing...');
  const dirRes = await fetch(SCUNPACKED_SHIPS_DIR_API);
  if (!dirRes.ok) {
    console.error(`GitHub API request failed: ${dirRes.status}`);
    process.exit(1);
  }
  const dirListing = (await dirRes.json()) as { name: string }[];
  const scunpackedFiles = dirListing.filter(f => f.name.endsWith('.json')).map(f => f.name.slice(0, -5));
  const scunpackedFileSet = new Set(scunpackedFiles);
  console.log(`  ${scunpackedFiles.length} files in scunpacked-data/ships.`);

  const scunpackedNormalized = scunpackedFiles.map(f => ({ file: f, tokens: normalizeTokens(tokenize(f)) }));

  const tier1: { slug: string; file: string }[] = [];
  const tier2: { slug: string; file: string }[] = [];
  const tier3: { slug: string; file: string }[] = [];
  const missing: { slug: string; name: string }[] = [];
  const alreadyAliased: string[] = [];
  let ok = 0;

  for (const ship of ships) {
    const { slug, name } = ship;
    if (KNOWN_ALIASES.has(slug)) { alreadyAliased.push(slug); continue; }

    const defaultFile = slug.replace(/-/g, '_');
    if (scunpackedFileSet.has(defaultFile)) { ok++; continue; }

    const shipTokens = normalizeTokens(tokenize(slug));
    const shipSet = tokenSet(shipTokens);

    const tier1Matches = scunpackedNormalized.filter(f => setsEqual(shipSet, tokenSet(f.tokens)));
    if (tier1Matches.length === 1) { tier1.push({ slug, file: tier1Matches[0].file }); continue; }

    const shipSetNoMark = tokenSet(stripMark(shipTokens));
    const tier2Matches = scunpackedNormalized.filter(f => setsEqual(shipSetNoMark, tokenSet(stripMark(f.tokens))));
    if (tier2Matches.length === 1) { tier2.push({ slug, file: tier2Matches[0].file }); continue; }

    const noMarkTokens = stripMark(shipTokens);
    if (noMarkTokens.length > 2) {
      const droppedSet = tokenSet(noMarkTokens.slice(0, -1));
      const prefixMatches = scunpackedNormalized.filter(f => setsEqual(droppedSet, tokenSet(f.tokens)));
      if (prefixMatches.length === 1) { tier3.push({ slug, file: prefixMatches[0].file }); continue; }
    }

    missing.push({ slug, name });
  }

  console.log(`\nAlready aliased (skipped): ${alreadyAliased.length}`);
  console.log(`OK (default filename resolves): ${ok}`);

  console.log(`\n=== NEW TIER 1 matches (exact reorder/numeral-format — safe to add) ===  ${tier1.length}`);
  tier1.forEach(r => console.log(`  '${r.slug}': '${r.file}',`));

  console.log(`\n=== NEW TIER 2 matches (mark stripped entirely — safe to add) ===  ${tier2.length}`);
  tier2.forEach(r => console.log(`  '${r.slug}': '${r.file}',`));

  console.log(`\n=== NEW TIER 3 matches (base-trim guess — REVIEW before adding) ===  ${tier3.length}`);
  tier3.forEach(r => console.log(`  '${r.slug}': '${r.file}',  // verify this is really the base trim`));

  console.log(`\n=== Still no confident match (genuine gap, or needs a hand lookup e.g. codenamed Xi'an/Vanduul ships) ===  ${missing.length}`);
  missing.forEach(r => console.log(`  ${r.slug} | ${r.name}`));

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
