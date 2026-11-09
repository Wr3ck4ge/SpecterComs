// Safe markdown for server-authored content (the strip's server welcome
// panel). Parses a small markdown subset into a plain AST and renders it with
// React.createElement — every piece of text ends up as a React text child, so
// it is escaped. There is NO raw-HTML path at all: `<b>`, `<script>`, `<img
// onerror>` and friends render as the literal characters you typed. No
// dangerouslySetInnerHTML anywhere.
//
// Supported: # headings (1-6), **bold** / __bold__, *italic* / _italic_,
// ~~strike~~, `code`, ``` fenced code ```, > blockquote, 1. numbered and
// - / * / + bulleted lists (nested by indenting), --- horizontal rule,
// [text](url), <https://autolink> and bare https:// URLs, hard line breaks.
// Not supported (shown as text): raw HTML, images, tables, reference links.
//
// Links: only absolute http/https URLs (safeHref) become links; anything else
// (javascript:, data:, vbscript:, relative, user:pass@ tricks) renders as its
// label text only. A link is never followed inside the webview: the element
// has no href, and activating it calls onOpenLink(href) — the strip opens it
// in the system browser (utils/openExternal.js).
import { createElement as h, Fragment } from 'react';

const MAX_DEPTH = 6; // nesting cap for quotes / lists / emphasis

/** An absolute http(s) URL, normalized — or null. */
export function safeHref(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  // The literal scheme check comes first: it rejects relative URLs and any
  // obfuscated scheme ("java\tscript:", "&#106;avascript:") outright.
  if (!/^https?:\/\//i.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null; // https://trusted.com@evil.example
  // A plain DNS name (IDNs arrive punycoded), IPv4 or [IPv6] — nothing odd.
  if (!/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/i.test(u.hostname)) return null;
  return u.href;
}

// ── Block parsing ──────────────────────────────────────────────────────────
const RE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const RE_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_QUOTE = /^ {0,3}> ?/;
const RE_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;

const isBlockStart = (line) => RE_FENCE.test(line) || RE_HEADING.test(line) || RE_HR.test(line)
  || RE_QUOTE.test(line) || RE_ITEM.test(line);
const leading = (line) => line.length - line.trimStart().length;
const dedent = (line, n) => line.slice(Math.min(n, leading(line)));

/**
 * Markdown source → blocks:
 *   { type: 'heading', level, children: inline[] }
 *   { type: 'paragraph', children: inline[] }
 *   { type: 'code', text }
 *   { type: 'blockquote', children: block[] }
 *   { type: 'list', ordered, start, items: block[][] }
 *   { type: 'hr' }
 */
export function parseMarkdown(src, depth = 0) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;

    if ((m = RE_FENCE.exec(line))) {
      const marker = m[1];
      const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence (or past the end)
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    if (RE_HR.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }
    if ((m = RE_HEADING.exec(line))) {
      blocks.push({ type: 'heading', level: m[1].length, children: parseInline(m[2] || '', depth) });
      i++;
      continue;
    }
    if (RE_QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) body.push(lines[i++].replace(RE_QUOTE, ''));
      blocks.push(depth < MAX_DEPTH
        ? { type: 'blockquote', children: parseMarkdown(body.join('\n'), depth + 1) }
        : { type: 'paragraph', children: parseInline(body.join('\n'), depth) });
      continue;
    }
    if ((m = RE_ITEM.exec(line)) && depth < MAX_DEPTH) {
      const ordered = /\d/.test(m[2]);
      const start = ordered ? parseInt(m[2], 10) : 1;
      const items = [];
      while (i < lines.length) {
        const im = RE_ITEM.exec(lines[i]);
        if (!im || /\d/.test(im[2]) !== ordered) break;
        const contentIndent = im[1].length + im[2].length + 1;
        const body = [im[3] || ''];
        i++;
        while (i < lines.length) {
          const next = lines[i];
          if (!next.trim()) {
            // A blank line ends the item unless indented content follows.
            let k = i + 1;
            while (k < lines.length && !lines[k].trim()) k++;
            if (k < lines.length && leading(lines[k]) >= 2 && leading(lines[k]) > im[1].length) {
              for (; i < k; i++) body.push('');
              continue;
            }
            break;
          }
          if (leading(next) >= 2 && leading(next) > im[1].length) { body.push(dedent(next, contentIndent)); i++; continue; }
          if (isBlockStart(next)) break;
          body.push(next.trim()); // lazy continuation of the item's text
          i++;
        }
        items.push(parseMarkdown(body.join('\n'), depth + 1));
        // Blank lines between items keep the list going.
        let k = i;
        while (k < lines.length && !lines[k].trim()) k++;
        const after = k < lines.length ? RE_ITEM.exec(lines[k]) : null;
        if (after && /\d/.test(after[2]) === ordered) i = k; else break;
      }
      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !isBlockStart(lines[i]))) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: 'paragraph', children: parseInline(para.join('\n'), depth) });
  }
  return blocks;
}

// ── Inline parsing ─────────────────────────────────────────────────────────
//   { type: 'text', text } | { type: 'br' } | { type: 'code', text }
//   { type: 'strong' | 'em' | 'del', children } | { type: 'link', href, children }
// A link whose URL isn't safe keeps href: null and renders as its label.
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~>|<]/;
const RE_AUTOLINK = /^<(https?:\/\/[^\s<>]+)>/i;
const RE_BARE_URL = /^https?:\/\/[^\s<>]+/i;

function findClose(text, from, open, close) {
  let d = 0;
  for (let j = from; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') { j++; continue; }
    if (c === open) d++;
    else if (c === close) { if (d === 0) return j; d--; }
  }
  return -1;
}

export function parseInline(text, depth = 0, { noLinks = false } = {}) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } };
  const nest = (s) => parseInline(s, depth + 1, { noLinks });
  const canNest = depth < MAX_DEPTH;
  const s = String(text ?? '');
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (c === '\n') { flush(); out.push({ type: 'br' }); i++; continue; }

    if (c === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      let j = s.indexOf(fence, i + n);
      while (j !== -1 && s[j + n] === '`') j = s.indexOf(fence, j + n + 1);
      if (j === -1) { buf += fence; i += n; continue; }
      flush();
      let code = s.slice(i + n, j).replace(/\n/g, ' ');
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
      out.push({ type: 'code', text: code });
      i = j + n;
      continue;
    }

    const two = s.slice(i, i + 2);
    if (canNest && (two === '**' || two === '__' || two === '~~')) {
      const j = s.indexOf(two, i + 2);
      const okBoundary = two !== '__' || (!/\w/.test(s[i - 1] || '') && !/\w/.test(s[j + 2] || ''));
      if (j > i + 2 && !/\s/.test(s[i + 2]) && !/\s/.test(s[j - 1]) && okBoundary) {
        flush();
        out.push({ type: two === '~~' ? 'del' : 'strong', children: nest(s.slice(i + 2, j)) });
        i = j + 2;
        continue;
      }
    }

    if (canNest && (c === '*' || c === '_') && s[i + 1] && !/\s/.test(s[i + 1]) && !(c === '_' && /\w/.test(s[i - 1] || ''))) {
      let j = i + 1;
      let found = -1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === c && s[j + 1] === c) { j += 2; continue; } // a doubled run belongs to strong
        if (s[j] === c && !/\s/.test(s[j - 1]) && !(c === '_' && /\w/.test(s[j + 1] || ''))) { found = j; break; }
        j++;
      }
      if (found > i + 1) {
        flush();
        out.push({ type: 'em', children: nest(s.slice(i + 1, found)) });
        i = found + 1;
        continue;
      }
    }

    if (!noLinks && c === '[') {
      const close = findClose(s, i + 1, '[', ']');
      if (close !== -1 && s[close + 1] === '(') {
        const end = findClose(s, close + 2, '(', ')');
        if (end !== -1) {
          let target = s.slice(close + 2, end).trim();
          if (target.startsWith('<') && target.includes('>')) target = target.slice(1, target.indexOf('>'));
          else target = target.split(/\s+/)[0] || ''; // drop a "title"
          flush();
          const label = s.slice(i + 1, close);
          out.push({ type: 'link', href: safeHref(target), children: parseInline(label, depth + 1, { noLinks: true }) });
          i = end + 1;
          continue;
        }
      }
    }

    if (!noLinks && c === '<') {
      const m = RE_AUTOLINK.exec(s.slice(i));
      if (m) {
        flush();
        const href = safeHref(m[1]);
        out.push({ type: 'link', href, children: [{ type: 'text', text: m[1] }] });
        i += m[0].length;
        continue;
      }
    }

    if (!noLinks && (c === 'h' || c === 'H') && !/\w/.test(s[i - 1] || '')) {
      const m = RE_BARE_URL.exec(s.slice(i));
      if (m) {
        let url = m[0];
        // Trailing punctuation is the sentence's, not the URL's (keep a ')' that closes a '(' in the URL).
        while (/[.,;:!?'"*_\]]$/.test(url) || (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length)) {
          url = url.slice(0, -1);
        }
        const href = safeHref(url);
        if (href) {
          flush();
          out.push({ type: 'link', href, children: [{ type: 'text', text: url }] });
          i += url.length;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

// ── Rendering ──────────────────────────────────────────────────────────────
// Classes use the strip's design tokens (tailwind.config.js `specter.*`).
const CLS = {
  h: {
    1: 'text-ui-lg font-semibold text-specter-text-main mt-3 mb-1 first:mt-0',
    2: 'text-ui-base font-semibold text-specter-text-main mt-3 mb-1 first:mt-0',
    3: 'text-ui-sm font-semibold text-specter-text-main mt-2.5 mb-0.5 first:mt-0',
  },
  hSmall: 'text-ui-xs font-semibold uppercase tracking-wide text-specter-text-subtle mt-2.5 mb-0.5 first:mt-0',
  p: 'my-1.5 first:mt-0 last:mb-0',
  ul: 'my-1.5 first:mt-0 last:mb-0 pl-5 list-disc space-y-0.5 marker:text-specter-primary-dim',
  ol: 'my-1.5 first:mt-0 last:mb-0 pl-6 list-decimal space-y-0.5 marker:text-specter-primary-neon marker:font-semibold',
  li: 'pl-0.5',
  pre: 'my-2 first:mt-0 last:mb-0 p-2 rounded-ui-sm bg-specter-bg-deep/70 border border-specter-border-divider font-mono text-ui-xs text-specter-text-main overflow-x-auto whitespace-pre',
  code: 'px-1 py-px rounded-ui-sm bg-specter-bg-deep/70 font-mono text-[0.92em] text-specter-primary-neon',
  quote: 'my-2 first:mt-0 last:mb-0 pl-3 border-l-2 border-specter-primary-dim text-specter-text-subtle',
  hr: 'my-3 border-0 border-t border-specter-border-divider',
  a: 'text-specter-primary-neon underline decoration-specter-primary-dim underline-offset-2 hover:decoration-specter-primary-neon cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-specter-border-focus',
  strong: 'font-semibold text-specter-text-main',
  em: 'italic',
  del: 'line-through opacity-80',
};

function renderInline(nodes, ctx, keyBase) {
  return nodes.map((n, idx) => {
    const key = `${keyBase}.${idx}`;
    switch (n.type) {
      case 'text': return h(Fragment, { key }, n.text);
      case 'br': return h('br', { key });
      case 'code': return h('code', { key, className: CLS.code }, n.text);
      case 'strong': return h('strong', { key, className: CLS.strong }, renderInline(n.children, ctx, key));
      case 'em': return h('em', { key, className: CLS.em }, renderInline(n.children, ctx, key));
      case 'del': return h('del', { key, className: CLS.del }, renderInline(n.children, ctx, key));
      case 'link': {
        const kids = renderInline(n.children, ctx, key);
        if (!n.href) return h('span', { key, 'data-link-refused': '' }, kids);
        const open = (e) => { e.preventDefault(); e.stopPropagation(); ctx.onOpenLink?.(n.href); };
        return h('a', {
          key,
          role: 'link',
          tabIndex: 0,
          title: n.href,
          'data-href': n.href,
          className: CLS.a,
          onClick: open,
          onAuxClick: (e) => e.preventDefault(),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') open(e); },
        }, kids);
      }
      default: return null;
    }
  });
}

function renderBlocks(blocks, ctx, keyBase) {
  return blocks.map((b, idx) => {
    const key = `${keyBase}.${idx}`;
    switch (b.type) {
      case 'heading': {
        const tag = `h${Math.min(6, b.level + 2)}`; // # inside a card is a sub-heading
        return h(tag, { key, className: CLS.h[b.level] || CLS.hSmall }, renderInline(b.children, ctx, key));
      }
      case 'paragraph': return h('p', { key, className: CLS.p }, renderInline(b.children, ctx, key));
      case 'code': return h('pre', { key, className: CLS.pre }, h('code', null, b.text));
      case 'blockquote': return h('blockquote', { key, className: CLS.quote }, renderBlocks(b.children, ctx, key));
      case 'hr': return h('hr', { key, className: CLS.hr });
      case 'list': {
        const items = b.items.map((item, j) => {
          const k = `${key}.${j}`;
          // A tight item (one paragraph) renders its text without a <p>.
          const content = item.length === 1 && item[0].type === 'paragraph'
            ? renderInline(item[0].children, ctx, k)
            : renderBlocks(item, ctx, k);
          return h('li', { key: k, className: CLS.li }, content);
        });
        return b.ordered
          ? h('ol', { key, className: CLS.ol, start: b.start !== 1 ? b.start : undefined }, items)
          : h('ul', { key, className: CLS.ul }, items);
      }
      default: return null;
    }
  });
}

/** Markdown source → React nodes. options.onOpenLink(href) opens a link. */
export function renderMarkdown(src, { onOpenLink } = {}) {
  return renderBlocks(parseMarkdown(src), { onOpenLink }, 'md');
}
