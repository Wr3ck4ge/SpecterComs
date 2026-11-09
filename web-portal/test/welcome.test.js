// Server welcome panel, client side: the safe markdown renderer
// (src/utils/safeMarkdown.js) — HTML and script are inert, only http(s)
// links survive — and the "show once per update" model
// (src/components/strip/welcome/welcomeModel.js).
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseMarkdown, parseInline, renderMarkdown, safeHref } from '../src/utils/safeMarkdown.js';
import {
  WELCOME_LIMITS, WELCOME_SEEN_KEY, welcomeSeenAt, markWelcomeSeen, shouldAutoShowWelcome,
  draftFrom, draftError, moveSection, sectionFromLanding, counterVisible,
} from '../src/components/strip/welcome/welcomeModel.js';

const html = (src, opts) => renderToStaticMarkup(createElement('div', null, renderMarkdown(src, opts)));
const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
};

describe('safeMarkdown: no raw HTML', () => {
  it('HTML tags and script render as inert text', () => {
    const out = html('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n**<b>hi</b>**');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<img/i);
    expect(out).not.toMatch(/<b>/);
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(out).toContain('<strong class="font-semibold text-specter-text-main">&lt;b&gt;hi&lt;/b&gt;</strong>');
  });

  it('no event-handler or style attributes can be injected through any construct', () => {
    const nasty = [
      '# <svg onload=alert(1)>',
      '- <iframe src=javascript:alert(1)>',
      '> <a href="javascript:alert(1)">x</a>',
      '`<script>`',
      '```\n</code></pre><script>alert(1)</script>\n```',
      '[<img src=x onerror=alert(1)>](https://ok.example)',
      '[x](https://ok.example" onmouseover="alert(1))',
    ].join('\n\n');
    const out = html(nasty);
    // Text content is escaped (&lt;), so every real '<' starts an element we made.
    const tags = [...out.matchAll(/<([a-z0-9]+)((?:\s[^>]*)?)\/?>/gi)];
    const ELEMENTS = new Set(['div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'hr', 'br', 'a', 'span', 'strong', 'em', 'del']);
    const ATTRS = new Set(['class', 'role', 'tabindex', 'title', 'data-href', 'data-link-refused', 'start']);
    for (const [, tag, attrs] of tags) {
      expect(ELEMENTS.has(tag.toLowerCase()), tag).toBe(true);
      for (const [, name] of attrs.matchAll(/\s([a-z-]+)=/gi)) expect(ATTRS.has(name.toLowerCase()), name).toBe(true);
    }
    // (no `href` in ATTRS: links never carry one at all)
    expect(out).toContain('&lt;svg onload=alert(1)&gt;');
    // The quote-breakout URL is refused outright.
    expect(out).not.toContain('onmouseover="');
  });
});

describe('safeMarkdown: links', () => {
  it.each([
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)',
    'javascript&#58;alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)',
    'file:///C:/Windows/win.ini', '/relative/path', '//evil.example/x', 'https://trusted.example@evil.example/',
    'mailto:a@b.c', 'https://', '', 'https://ok.example"onmouseover=x', null,
  ])('refuses %j', (url) => {
    expect(safeHref(url)).toBeNull();
  });

  it('accepts and normalizes http/https', () => {
    expect(safeHref('https://spectercoms.net/x?y=1#z')).toBe('https://spectercoms.net/x?y=1#z');
    expect(safeHref('HTTP://Example.com')).toBe('http://example.com/');
  });

  it('a javascript: link renders as plain label text, not a link', () => {
    const out = html('[click me](javascript:alert(document.cookie))');
    expect(out).toContain('click me');
    expect(out).not.toMatch(/javascript/i);
    expect(out).not.toMatch(/<a\b/);
    expect(out).toContain('data-link-refused');
  });

  it('a safe link has no href and opens through onOpenLink only', () => {
    const blocks = parseMarkdown('[Site](https://spectercoms.net "title")');
    expect(blocks[0].children[0]).toMatchObject({ type: 'link', href: 'https://spectercoms.net/' });
    const nodes = renderMarkdown('[Site](https://spectercoms.net)', { onOpenLink: vi.fn() });
    const a = nodes[0].props.children[0];
    expect(a.type).toBe('a');
    expect(a.props.href).toBeUndefined();
    expect(a.props['data-href']).toBe('https://spectercoms.net/');
    const onOpenLink = vi.fn();
    const live = renderMarkdown('[Site](https://spectercoms.net)', { onOpenLink })[0].props.children[0];
    const ev = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    live.props.onClick(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(onOpenLink).toHaveBeenCalledWith('https://spectercoms.net/');
  });

  it('autolinks and bare URLs (trailing punctuation stays outside)', () => {
    const inl = parseInline('See <https://a.example/x> and https://b.example/y.');
    const links = inl.filter((n) => n.type === 'link').map((n) => n.href);
    expect(links).toEqual(['https://a.example/x', 'https://b.example/y']);
    expect(inl[inl.length - 1]).toEqual({ type: 'text', text: '.' });
  });
});

describe('safeMarkdown: supported syntax', () => {
  it('headings, emphasis, code, quote, rule', () => {
    const out = html('# Title\n### Small\n**bold** *it* _it2_ ~~gone~~ `x<y`\n\n> quoted\n\n---\n\n```\ncode <b>\n```');
    expect(out).toMatch(/<h3[^>]*>Title<\/h3>/); // "#" in a card is a sub-heading
    expect(out).toMatch(/<h5[^>]*>Small<\/h5>/);
    expect(out).toMatch(/<strong[^>]*>bold<\/strong>/);
    expect(out).toMatch(/<em[^>]*>it<\/em>/);
    expect(out).toMatch(/<em[^>]*>it2<\/em>/);
    expect(out).toMatch(/<del[^>]*>gone<\/del>/);
    expect(out).toMatch(/<code[^>]*>x&lt;y<\/code>/);
    expect(out).toMatch(/<blockquote[^>]*><p[^>]*>quoted<\/p><\/blockquote>/);
    expect(out).toMatch(/<hr[^>]*\/>/);
    expect(out).toMatch(/<pre[^>]*><code>code &lt;b&gt;<\/code><\/pre>/);
  });

  it('numbered rules list keeps its start number; bullets nest', () => {
    const blocks = parseMarkdown('3. three\n4. four\n\n- a\n  - a1\n- b');
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: true, start: 3 });
    expect(blocks[0].items).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ type: 'list', ordered: false });
    expect(blocks[1].items).toHaveLength(2);
    expect(blocks[1].items[0][1]).toMatchObject({ type: 'list', ordered: false });
    const out = html('1. Be nice\n2. **No** spam');
    expect(out).toMatch(/<ol[^>]*><li[^>]*>Be nice<\/li><li[^>]*><strong[^>]*>No<\/strong> spam<\/li><\/ol>/);
    expect(html('3. x')).toContain('start="3"');
  });

  it('snake_case and 2*3*4 are not emphasis; escapes work', () => {
    expect(html('snake_case_name')).toContain('snake_case_name');
    expect(html('\\*not italic\\*')).toContain('*not italic*');
    expect(html('a * b * c')).not.toMatch(/<em/);
  });

  it('newlines inside a paragraph are line breaks', () => {
    expect(html('one\ntwo')).toMatch(/one<br\/>two/);
  });

  it('survives pathological input quickly', () => {
    const t = Date.now();
    html(`${'> '.repeat(50)}deep\n${'*'.repeat(4000)}\n${'[('.repeat(1000)}`);
    html(`${'- '.repeat(200)}x`);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('welcome: show once per update', () => {
  const org = { id: 'org-1', welcome_updated_at: '2026-10-31T10:00:00.000Z' };

  it('shows for unseen content, then not again until the next edit', () => {
    const storage = memStorage();
    expect(shouldAutoShowWelcome({ org, userId: 'u1', storage })).toBe(true);
    markWelcomeSeen('u1', org.id, org.welcome_updated_at, storage);
    expect(shouldAutoShowWelcome({ org, userId: 'u1', storage })).toBe(false);
    const edited = { ...org, welcome_updated_at: '2026-10-31T11:00:00.000Z' };
    expect(shouldAutoShowWelcome({ org: edited, userId: 'u1', storage })).toBe(true);
  });

  it('is per user and per org', () => {
    const storage = memStorage();
    markWelcomeSeen('u1', org.id, org.welcome_updated_at, storage);
    expect(shouldAutoShowWelcome({ org, userId: 'u2', storage })).toBe(true);
    expect(shouldAutoShowWelcome({ org: { ...org, id: 'org-2' }, userId: 'u1', storage })).toBe(true);
    expect(welcomeSeenAt('u1', org.id, storage)).toBe(org.welcome_updated_at);
    expect(JSON.parse(storage.getItem(WELCOME_SEEN_KEY))).toEqual({ u1: { 'org-1': org.welcome_updated_at } });
  });

  it('never for a server without welcome content, or with a blocker up', () => {
    const storage = memStorage();
    expect(shouldAutoShowWelcome({ org: { id: 'x', welcome_updated_at: null }, userId: 'u1', storage })).toBe(false);
    for (const b of ['overlayOpen', 'sharing', 'viewerOpen', 'pickerOpen', 'cabinetOpen']) {
      expect(shouldAutoShowWelcome({ org, userId: 'u1', storage, blockers: { [b]: true } }), b).toBe(false);
    }
    expect(shouldAutoShowWelcome({ org, userId: null, storage })).toBe(false);
  });

  it('tolerates broken or missing storage', () => {
    const broken = { getItem: () => '{nope', setItem: () => { throw new Error('quota'); } };
    expect(shouldAutoShowWelcome({ org, userId: 'u1', storage: broken })).toBe(true);
    expect(() => markWelcomeSeen('u1', org.id, org.welcome_updated_at, broken)).not.toThrow();
    expect(shouldAutoShowWelcome({ org, userId: 'u1', storage: null })).toBe(true);
  });

  it('keeps at most 100 servers per user (oldest dropped)', () => {
    const storage = memStorage();
    for (let i = 0; i < 105; i++) markWelcomeSeen('u1', `o${i}`, 't', storage);
    const mine = JSON.parse(storage.getItem(WELCOME_SEEN_KEY)).u1;
    expect(Object.keys(mine)).toHaveLength(100);
    expect(mine.o0).toBeUndefined();
    expect(mine.o104).toBe('t');
  });
});

describe('welcome: editor model', () => {
  it('limits match the server', () => {
    expect(WELCOME_LIMITS).toEqual({ subtitle: 200, sectionTitle: 80, sectionBody: 4000, maxSections: 10 });
  });

  it('draft validation mirrors the server messages', () => {
    const d = draftFrom({ subtitle: 'hi', sections: [{ id: 'a', title: 'Rules', body: '1. x' }] });
    expect(draftError(d)).toBeNull();
    expect(draftError({ ...d, subtitle: 's'.repeat(201) })).toMatch(/Subtitle/);
    expect(draftError({ ...d, sections: [{ id: 'a', title: ' ', body: '' }] })).toMatch(/needs a title or some text/);
    expect(draftError({ ...d, sections: Array.from({ length: 11 }, (_, i) => ({ id: `${i}`, title: 't', body: '' })) })).toMatch(/at most 10/);
  });

  it('reorders, copies the public page, and shows counters near the limit', () => {
    const s = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(moveSection(s, 0, 1).map((x) => x.id)).toEqual(['b', 'a', 'c']);
    expect(moveSection(s, 0, -1)).toBe(s);
    expect(sectionFromLanding('  We fly at night.\r\n ')).toMatchObject({ title: 'About us', body: 'We fly at night.' });
    expect(sectionFromLanding('')).toBeNull();
    expect(sectionFromLanding('x'.repeat(5000)).body).toHaveLength(4000);
    expect(counterVisible(159, 200)).toBe(false);
    expect(counterVisible(160, 200)).toBe(true);
  });
});
