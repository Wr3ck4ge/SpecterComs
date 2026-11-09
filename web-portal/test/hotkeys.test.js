// Global hotkey wiring (keybinds.js createHotkeyController): native Raw Input
// sink (hotkeys.rs) first, global-shortcut plugin only as a fallback, never
// both; PTT keeps both edges, everything deduped across rebinds. The Rust
// side (scan-code mapping, combo matching, SendInput live test) has its own
// cargo tests in src-tauri/src/hotkeys.rs.
import { describe, it, expect, vi } from 'vitest';
import {
  createHotkeyController, createCooldownGate, readHotkeyBindings, HOTKEY_STORAGE_KEYS, DEFAULT_KEYBINDS,
} from '../src/keybinds.js';

const quietLog = { warn: () => {} };

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null) };
}

function harness({ nativeAvailable = true } = {}) {
  const listeners = {};
  const pluginHandlers = new Map();
  const plugin = {
    register: vi.fn(async (accel, cb) => { pluginHandlers.set(accel, cb); }),
    unregisterAll: vi.fn(async () => { pluginHandlers.clear(); }),
  };
  const invoke = vi.fn(async (cmd, args) => {
    if (!nativeAvailable) throw new Error(`Command ${cmd} not found`);
    return { accepted: Object.keys(args.bindings).filter((k) => args.bindings[k]), rejected: [] };
  });
  const unlisten = vi.fn();
  const listen = vi.fn(async (event, cb) => { listeners[event] = cb; return unlisten; });
  const actions = [];
  const ctl = createHotkeyController({
    invoke, listen, loadPlugin: async () => plugin,
    onAction: (name, pressed) => actions.push([name, pressed]),
    log: quietLog,
  });
  const native = (name, pressed) => listeners['specter://hotkey']?.({ payload: { name, pressed } });
  const pluginKey = (accel, state) => pluginHandlers.get(accel)?.({ state });
  return { ctl, invoke, listen, plugin, pluginHandlers, actions, native, pluginKey, unlisten };
}

const BINDS = { ptt: 'KeyV', channelToggle: 'Alt+KeyQ', streamNext: '', overlayPassthrough: 'Ctrl+Meta+KeyW' };

describe('readHotkeyBindings', () => {
  it('uses defaults for never-set keys, keeps explicit clears, PTT only in PTT mode', () => {
    expect(readHotkeyBindings(fakeStorage())).toEqual({
      ptt: '', channelToggle: DEFAULT_KEYBINDS.channelToggle,
      streamNext: DEFAULT_KEYBINDS.streamNext, overlayPassthrough: DEFAULT_KEYBINDS.overlayPassthrough,
      shareApp: 'Alt+KeyS',
    });
    expect(readHotkeyBindings(fakeStorage({ specter_share_app_key: '' })).shareApp).toBe('');
    const s = fakeStorage({ specter_ptt_key: 'KeyV', specter_stream_next_key: '' });
    expect(readHotkeyBindings(s)).toMatchObject({ ptt: 'KeyV', streamNext: '' });
    const vad = fakeStorage({ specter_ptt_key: 'KeyV', specter_voice_mode: 'voice-activated' });
    expect(readHotkeyBindings(vad).ptt).toBe('');
  });

  it('every storage key it reads triggers a rebind', () => {
    for (const k of ['specter_ptt_key', 'specter_voice_mode', 'specter_channel_toggle_key',
      'specter_stream_next_key', 'specter_overlay_passthrough_key', 'specter_share_app_key']) {
      expect(HOTKEY_STORAGE_KEYS).toContain(k);
    }
  });
});

describe('native path', () => {
  it('sends every binding to the sink and never registers with the plugin', async () => {
    const h = harness();
    expect(await h.ctl.apply(BINDS)).toBe('native');
    expect(h.invoke).toHaveBeenCalledWith('hotkeys_set_bindings', { bindings: BINDS });
    expect(h.plugin.register).not.toHaveBeenCalled();
    // Stale plugin registrations (webview reload) are cleared.
    expect(h.plugin.unregisterAll).toHaveBeenCalledTimes(1);
    // The listener is in place before the bind.
    expect(h.listen.mock.invocationCallOrder[0]).toBeLessThan(h.invoke.mock.invocationCallOrder[0]);
  });

  it('forwards PTT edges and dedupes', async () => {
    const h = harness();
    await h.ctl.apply(BINDS);
    h.native('ptt', true);
    h.native('ptt', true);
    h.native('ptt', false);
    h.native('channelToggle', true);
    h.native('channelToggle', false);
    expect(h.actions).toEqual([['ptt', true], ['ptt', false], ['channelToggle', true], ['channelToggle', false]]);
  });

  it('a rebind while PTT is held releases it, and the next press still works', async () => {
    const h = harness();
    await h.ctl.apply(BINDS);
    h.native('ptt', true);
    await h.ctl.apply({ ...BINDS, ptt: 'KeyB' });
    expect(h.actions).toEqual([['ptt', true], ['ptt', false]]);
    h.native('ptt', false); // the sink's own release for the dropped binding: no-op
    h.native('ptt', true);
    expect(h.actions).toEqual([['ptt', true], ['ptt', false], ['ptt', true]]);
    expect(h.listen).toHaveBeenCalledTimes(1);
    expect(h.plugin.unregisterAll).toHaveBeenCalledTimes(1);
  });

  it('dispose clears the sink, unlistens, and releases a held PTT', async () => {
    const h = harness();
    await h.ctl.apply(BINDS);
    h.native('ptt', true);
    await h.ctl.dispose();
    expect(h.invoke).toHaveBeenLastCalledWith('hotkeys_set_bindings', { bindings: {} });
    expect(h.unlisten).toHaveBeenCalled();
    expect(h.actions.at(-1)).toEqual(['ptt', false]);
    expect(await h.ctl.apply(BINDS)).toBe('disposed');
  });
});

describe('fallback path (older build without the native command)', () => {
  it('registers non-empty bindings with the plugin, spelled the plugin way', async () => {
    const h = harness({ nativeAvailable: false });
    expect(await h.ctl.apply(BINDS)).toBe('plugin');
    expect([...h.pluginHandlers.keys()].sort()).toEqual(['Alt+KeyQ', 'Control+Super+KeyW', 'KeyV']);
  });

  it('dedupes WM_HOTKEY auto-repeat; native events are ignored (no double fire)', async () => {
    const h = harness({ nativeAvailable: false });
    await h.ctl.apply(BINDS);
    h.pluginKey('Alt+KeyQ', 'Pressed');
    h.pluginKey('Alt+KeyQ', 'Pressed');
    h.native('channelToggle', true); // stray native edge must not count
    h.pluginKey('Alt+KeyQ', 'Released');
    expect(h.actions).toEqual([['channelToggle', true], ['channelToggle', false]]);
  });

  it('a rebind while PTT is held does not swallow the next press', async () => {
    const h = harness({ nativeAvailable: false });
    await h.ctl.apply(BINDS);
    h.pluginKey('KeyV', 'Pressed');
    await h.ctl.apply(BINDS);
    h.pluginKey('KeyV', 'Pressed');
    expect(h.actions).toEqual([['ptt', true], ['ptt', false], ['ptt', true]]);
  });

  it('dispose unregisters the plugin', async () => {
    const h = harness({ nativeAvailable: false });
    await h.ctl.apply(BINDS);
    await h.ctl.dispose();
    expect(h.pluginHandlers.size).toBe(0);
  });
});

describe('one-shot cooldown (Alt+E cycling regression)', () => {
  function clocked(nativeAvailable) {
    let t = 1000;
    const listeners = {};
    const handlers = new Map();
    const actions = [];
    const ctl = createHotkeyController({
      invoke: async () => { if (!nativeAvailable) throw new Error('missing'); return { rejected: [] }; },
      listen: async (ev, cb) => { listeners[ev] = cb; return () => {}; },
      loadPlugin: async () => ({
        register: async (a, cb) => { handlers.set(a, cb); },
        unregisterAll: async () => { handlers.clear(); },
      }),
      onAction: (n, p) => actions.push([n, p]),
      log: quietLog,
      now: () => t,
    });
    return {
      ctl, actions,
      advance: (ms) => { t += ms; },
      native: (name, pressed) => listeners['specter://hotkey']({ payload: { name, pressed } }),
      plugin: (accel, state) => handlers.get(accel)({ state }),
    };
  }
  const presses = (actions, name) => actions.filter(([n, p]) => n === name && p).length;

  it('native: a held key (repeated downs) fires once; down-up-down fires twice', async () => {
    const h = clocked(true);
    await h.ctl.apply(BINDS);
    for (let i = 0; i < 30; i++) { h.native('channelToggle', true); h.advance(33); }
    h.native('channelToggle', false);
    expect(presses(h.actions, 'channelToggle')).toBe(1);
    h.advance(300);
    h.native('channelToggle', true);
    h.native('channelToggle', false);
    expect(presses(h.actions, 'channelToggle')).toBe(2);
  });

  it('plugin: spurious Pressed/Released pairs on each auto-repeat fire once per 250 ms', async () => {
    const h = clocked(false);
    await h.ctl.apply(BINDS);
    // A 1 s hold reported as press/release pairs every 33 ms.
    for (let i = 0; i < 30; i++) {
      h.plugin('Alt+KeyQ', 'Pressed'); h.plugin('Alt+KeyQ', 'Released'); h.advance(33);
    }
    expect(presses(h.actions, 'channelToggle')).toBeLessThanOrEqual(4); // was 30
    expect(presses(h.actions, 'channelToggle')).toBeGreaterThanOrEqual(1);
    // Suppressed presses don't emit a dangling release.
    const ups = h.actions.filter(([n, p]) => n === 'channelToggle' && !p).length;
    expect(ups).toBe(presses(h.actions, 'channelToggle'));
  });

  it('PTT is exempt from the cooldown', async () => {
    const h = clocked(true);
    await h.ctl.apply(BINDS);
    for (let i = 0; i < 3; i++) { h.native('ptt', true); h.native('ptt', false); }
    expect(h.actions).toEqual([['ptt', true], ['ptt', false], ['ptt', true], ['ptt', false], ['ptt', true], ['ptt', false]]);
  });
});

describe('createCooldownGate', () => {
  it('passes once per window per key', () => {
    let t = 0;
    const gate = createCooldownGate(250, () => t);
    expect(gate('a')).toBe(true);
    expect(gate('a')).toBe(false); // e.g. a duplicate listener in the same tick
    expect(gate('b')).toBe(true);
    t = 249; expect(gate('a')).toBe(false);
    t = 250; expect(gate('a')).toBe(true);
  });
});

describe('serialisation', () => {
  it('overlapping applies run in order; the last bindings win', async () => {
    const h = harness({ nativeAvailable: false });
    const a = h.ctl.apply(BINDS);
    const b = h.ctl.apply({ ...BINDS, ptt: 'KeyB' });
    await Promise.all([a, b]);
    expect([...h.pluginHandlers.keys()].sort()).toEqual(['Alt+KeyQ', 'Control+Super+KeyW', 'KeyB']);
  });
});
