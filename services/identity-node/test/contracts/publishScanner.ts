// Static scan of every publishEvent(subject, payload) call site in identity-node,
// checked against shared/events/schema.js with the TypeScript compiler API.
//
// Static on purpose: it covers every call site (77+ across 11 controllers)
// without a database, and it can't be dodged by a code path no test reaches.
// What it can read: a literal / template subject, and a payload that is an
// object literal — or an identifier / spread of one declared earlier in the
// same function. Anything else on an SSE subject is reported, so the
// convention stays checkable.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  SSE_EVENTS, isSseSubject, isInternalSubject, subjectMatches,
} from '../../../../shared/events/schema.js';
import type { FieldSpec } from '../../../../shared/events/schema.js';

export interface CallSite {
  file: string;
  line: number;
  subject: string | null;   // pattern, `${…}` → '*'
  kind: 'sse' | 'internal' | 'unknown';
  types: string[];          // literal `type` values (a ternary yields two)
  errors: string[];         // contract violations at this site
}

type Keys = { keys: Map<string, ts.Expression | null>; unresolved: string[] };

const unwrap = (e: ts.Expression): ts.Expression => {
  while (
    ts.isParenthesizedExpression(e) || ts.isAsExpression(e)
    || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)
  ) e = e.expression;
  return e;
};

/** Last `const|let name = <init>` before `at`, in the enclosing functions/file. */
function resolveIdentifier(id: ts.Identifier, at: number): ts.Expression | null {
  let scope: ts.Node | undefined = id.parent;
  while (scope) {
    if (ts.isFunctionLike(scope) || ts.isSourceFile(scope)) {
      let found: ts.Expression | null = null;
      const visit = (n: ts.Node) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === id.text
            && n.initializer && n.pos < at) found = n.initializer;
        ts.forEachChild(n, visit);
      };
      visit(scope);
      if (found) return found;
    }
    scope = scope.parent;
  }
  return null;
}

function resolveObject(e: ts.Expression, at: number, depth = 0): ts.ObjectLiteralExpression | null {
  e = unwrap(e);
  if (ts.isObjectLiteralExpression(e)) return e;
  if (ts.isIdentifier(e) && depth < 5) {
    const init = resolveIdentifier(e, at);
    return init ? resolveObject(init, at, depth + 1) : null;
  }
  return null;
}

function propName(n: ts.PropertyName): string | null {
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
  return null;
}

function objectKeys(obj: ts.ObjectLiteralExpression, at: number, depth = 0): Keys {
  const out: Keys = { keys: new Map(), unresolved: [] };
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p)) {
      const k = propName(p.name);
      if (k) out.keys.set(k, p.initializer); else out.unresolved.push(p.name.getText());
    } else if (ts.isShorthandPropertyAssignment(p)) {
      out.keys.set(p.name.text, p.name);
    } else if (ts.isSpreadAssignment(p)) {
      const inner = depth < 5 ? resolveObject(p.expression, at) : null;
      if (!inner) { out.unresolved.push(`...${p.expression.getText()}`); continue; }
      const sub = objectKeys(inner, at, depth + 1);
      for (const [k, v] of sub.keys) out.keys.set(k, v);
      out.unresolved.push(...sub.unresolved);
    }
  }
  return out;
}

function subjectPattern(e: ts.Expression): string | null {
  e = unwrap(e);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e)) {
    return e.head.text + e.templateSpans.map((s) => `*${s.literal.text}`).join('');
  }
  return null;
}

function literalStrings(e: ts.Expression): string[] | null {
  e = unwrap(e);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isConditionalExpression(e)) {
    const a = literalStrings(e.whenTrue); const b = literalStrings(e.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  return null;
}

/** Required-field check of one static object against one shape's spec. */
function checkSpec(spec: Record<string, FieldSpec>, k: Keys, at: number, prefix: string): string[] {
  const errors: string[] = [];
  for (const [field, fs] of Object.entries(spec)) {
    if (!k.keys.has(field)) {
      errors.push(k.unresolved.length
        ? `${prefix}${field}: not provably present (unresolvable ${k.unresolved.join(', ')} — spread a local object literal instead)`
        : `${prefix}${field}: missing`);
      continue;
    }
    const init = k.keys.get(field) ?? null;
    if (typeof fs === 'string' && fs.startsWith('literal:') && init) {
      const vals = literalStrings(init);
      const want = fs.slice('literal:'.length);
      if (!vals || vals.some((v) => v !== want)) errors.push(`${prefix}${field}: must be the literal '${want}'`);
    } else if (fs && typeof fs === 'object' && !('$array' in fs) && init) {
      const nested = resolveObject(init, at);
      if (!nested) { errors.push(`${prefix}${field}: nested object not statically resolvable`); continue; }
      errors.push(...checkSpec(fs as Record<string, FieldSpec>, objectKeys(nested, at), at, `${prefix}${field}.`));
    }
  }
  return errors;
}

/** Analyse one source text; `file` is only used for reporting. */
export function scanSource(file: string, text: string): CallSite[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const sites: CallSite[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name === 'publishEvent') sites.push(checkCall(sf, n, file));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

function checkCall(sf: ts.SourceFile, call: ts.CallExpression, file: string): CallSite {
  const line = sf.getLineAndCharacterOfPosition(call.getStart()).line + 1;
  const site: CallSite = { file, line, subject: null, kind: 'unknown', types: [], errors: [] };
  const [subjArg, payloadArg] = call.arguments;
  site.subject = subjArg ? subjectPattern(subjArg) : null;
  if (!site.subject) {
    site.errors.push('subject must be a string or template literal');
    return site;
  }
  if (isInternalSubject(site.subject)) { site.kind = 'internal'; return site; }
  if (!isSseSubject(site.subject)) {
    site.errors.push(`subject ${site.subject} is neither an SSE subject nor in INTERNAL_SUBJECTS (shared/events/schema.js)`);
    return site;
  }
  site.kind = 'sse';
  const obj = payloadArg ? resolveObject(payloadArg, call.pos) : null;
  if (!obj) {
    site.errors.push('payload on an SSE subject must be an object literal (or a local const of one)');
    return site;
  }
  const k = objectKeys(obj, call.pos);
  const typeInit = k.keys.get('type');
  const types = typeInit ? literalStrings(typeInit) : null;
  if (!types) {
    site.errors.push('`type` must be a string literal');
    return site;
  }
  site.types = types;
  for (const type of types) {
    const def = SSE_EVENTS[type];
    if (!def) { site.errors.push(`${type}: no entry in shared/events/schema.js SSE_EVENTS`); continue; }
    const shapes = def.shapes.filter((s) => subjectMatches(s.subject, site.subject!));
    if (!shapes.length) {
      site.errors.push(`${type}: not allowed on ${site.subject} (schema: ${def.shapes.map((s) => s.subject).join(', ')})`);
      continue;
    }
    let best: string[] | null = null;
    for (const shape of shapes) {
      const errs = checkSpec(shape.required, k, call.pos, '');
      if (!errs.length) { best = []; break; }
      if (!best || errs.length < best.length) best = errs;
    }
    site.errors.push(...(best ?? []).map((e) => `${type}: ${e}`));
  }
  return site;
}

/** Every .ts file under `dir` except declarations and the test tree. */
export function scanTree(dir: string): CallSite[] {
  const out: CallSite[] = [];
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== 'node_modules' && ent.name !== 'test') walk(p);
      } else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.d.ts')) {
        out.push(...scanSource(path.relative(dir, p).replace(/\\/g, '/'), fs.readFileSync(p, 'utf8')));
      }
    }
  };
  walk(dir);
  return out;
}
