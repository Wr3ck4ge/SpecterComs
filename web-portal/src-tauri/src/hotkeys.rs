//! Global hotkeys via a Raw Input sink, Discord-style.
//!
//! # Why not RegisterHotKey
//! `tauri-plugin-global-shortcut` is a thin wrapper over `RegisterHotKey`.
//! Games that register their own keyboard Raw Input with `RIDEV_NOHOTKEYS`
//! (Star Citizen does, so do many other titles; exclusive DirectInput has the
//! same effect) make the system stop generating `WM_HOTKEY` while they are in
//! the foreground, so PTT and the other binds only worked after Alt-Tabbing out.
//!
//! # How this works
//! A dedicated thread owns a message-only window (`HWND_MESSAGE`) and registers
//! it for keyboard Raw Input (usage page 1, usage 6) with `RIDEV_INPUTSINK`, so
//! `WM_INPUT` arrives for every keystroke system-wide even while another app is
//! in the foreground. `RIDEV_NOHOTKEYS` is a flag on the *game's* registration;
//! it has no effect on another process's raw input registration.
//!
//! Each `WM_INPUT` is turned into a `KeyboardEvent.code`-style [`Key`] from the
//! scan code (positional, the same vocabulary the settings UI records with —
//! see web-portal/src/keybinds.js), fed into a [`Matcher`] that tracks which
//! keys are down, and only matched edges are emitted to the webviews as
//! `specter://hotkey` `{ name, pressed }`.
//!
//! # Behavioural differences from RegisterHotKey (deliberate)
//! * Raw input is an *observer*: the key is NOT consumed, the focused app sees
//!   it too. That is what PTT wants (Discord behaves the same), but it means an
//!   Alt+W bind will also reach the game / focused window.
//! * Matching is by physical key position (scan code), like KeyboardEvent.code,
//!   rather than by layout-dependent virtual key.
//!
//! # Limits
//! * **UIPI**: raw input generated while an *elevated* (admin) window is in the
//!   foreground is not delivered to this non-elevated process. Nothing is done
//!   to work around that (it is a security boundary); a game run as admin needs
//!   SpecterComs run as admin too. Key-ups lost that way are healed by the
//!   periodic `GetAsyncKeyState` resync, so nothing sticks down.
//! * Secure desktop (lock screen, UAC prompt): no input arrives; session
//!   notifications and the resync reset state.
//! * Raw input registration is per *process* per usage: the most recent
//!   `RegisterRawInputDevices` for the keyboard wins. tao registers its hidden
//!   event-loop window (without INPUTSINK) when the event loop is built; the
//!   sink registers afterwards and so takes the keyboard over (tao only used
//!   it for `DeviceEvent::Key`, which nothing here consumes). The timer
//!   re-checks the registration and reclaims it if something re-registers.
//!
//! No WH_KEYBOARD_LL hook is used, on purpose: low-level hooks are an
//! anti-cheat red flag and Windows silently unhooks slow ones.

use std::collections::HashMap;

// ── Keys ─────────────────────────────────────────────────────────────────────

macro_rules! keys {
    ($($v:ident),* $(,)?) => {
        /// A physical key, named exactly as `KeyboardEvent.code` names it.
        #[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
        #[repr(u8)]
        pub enum Key { $($v),* }

        impl Key {
            pub const ALL: &'static [Key] = &[$(Key::$v),*];
            pub const COUNT: usize = Key::ALL.len();

            #[cfg_attr(not(test), allow(dead_code))] // diagnostics / tests
            pub fn name(self) -> &'static str {
                match self { $(Key::$v => stringify!($v)),* }
            }

            pub fn from_name(s: &str) -> Option<Key> {
                match s { $(stringify!($v) => Some(Key::$v),)* _ => None }
            }
        }
    };
}

keys! {
    Escape,
    Digit0, Digit1, Digit2, Digit3, Digit4, Digit5, Digit6, Digit7, Digit8, Digit9,
    KeyA, KeyB, KeyC, KeyD, KeyE, KeyF, KeyG, KeyH, KeyI, KeyJ, KeyK, KeyL, KeyM,
    KeyN, KeyO, KeyP, KeyQ, KeyR, KeyS, KeyT, KeyU, KeyV, KeyW, KeyX, KeyY, KeyZ,
    F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12,
    F13, F14, F15, F16, F17, F18, F19, F20, F21, F22, F23, F24,
    Numpad0, Numpad1, Numpad2, Numpad3, Numpad4, Numpad5, Numpad6, Numpad7, Numpad8, Numpad9,
    NumpadAdd, NumpadSubtract, NumpadMultiply, NumpadDivide, NumpadDecimal,
    NumpadEnter, NumpadEqual, NumpadComma, NumLock,
    Backquote, Backslash, BracketLeft, BracketRight, Comma, Equal, Minus, Period,
    Quote, Semicolon, Slash, IntlBackslash, IntlRo, IntlYen,
    Backspace, CapsLock, Enter, Space, Tab, Delete, End, Home, Insert,
    PageDown, PageUp, PrintScreen, ScrollLock, Pause,
    ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ContextMenu,
    KanaMode, Convert, NonConvert,
    ShiftLeft, ShiftRight, ControlLeft, ControlRight, AltLeft, AltRight, MetaLeft, MetaRight,
}

pub const MOD_CTRL: u8 = 1;
pub const MOD_ALT: u8 = 2;
pub const MOD_SHIFT: u8 = 4;
pub const MOD_META: u8 = 8;

impl Key {
    /// The modifier this key contributes (either side counts), or 0.
    pub fn modifier_bit(self) -> u8 {
        match self {
            Key::ControlLeft | Key::ControlRight => MOD_CTRL,
            Key::AltLeft | Key::AltRight => MOD_ALT,
            Key::ShiftLeft | Key::ShiftRight => MOD_SHIFT,
            Key::MetaLeft | Key::MetaRight => MOD_META,
            _ => 0,
        }
    }
}

// RAWKEYBOARD.Flags bits.
pub const RI_KEY_BREAK: u16 = 1;
pub const RI_KEY_E0: u16 = 2;
pub const RI_KEY_E1: u16 = 4;

const VK_CANCEL: u16 = 0x03;
const VK_PAUSE: u16 = 0x13;
const VK_SNAPSHOT: u16 = 0x2C;
const VK_NUMLOCK: u16 = 0x90;
/// VKey raw input reports for the fake shifts / escape prefixes the keyboard
/// driver inserts (E0 2A around PrintScreen, around nav keys with NumLock on,
/// the second half of the Pause sequence).
const VK_FAKE: u16 = 0xFF;
/// KEYBOARD_OVERRUN_MAKE_CODE.
const OVERRUN_MAKE: u16 = 0xFF;

/// Scan-code set 1 make code (no prefix) → code. Positional, layout independent.
fn key_from_plain_scan(make: u16) -> Option<Key> {
    use Key::*;
    Some(match make {
        0x01 => Escape,
        0x02 => Digit1, 0x03 => Digit2, 0x04 => Digit3, 0x05 => Digit4, 0x06 => Digit5,
        0x07 => Digit6, 0x08 => Digit7, 0x09 => Digit8, 0x0A => Digit9, 0x0B => Digit0,
        0x0C => Minus, 0x0D => Equal, 0x0E => Backspace, 0x0F => Tab,
        0x10 => KeyQ, 0x11 => KeyW, 0x12 => KeyE, 0x13 => KeyR, 0x14 => KeyT,
        0x15 => KeyY, 0x16 => KeyU, 0x17 => KeyI, 0x18 => KeyO, 0x19 => KeyP,
        0x1A => BracketLeft, 0x1B => BracketRight, 0x1C => Enter, 0x1D => ControlLeft,
        0x1E => KeyA, 0x1F => KeyS, 0x20 => KeyD, 0x21 => KeyF, 0x22 => KeyG,
        0x23 => KeyH, 0x24 => KeyJ, 0x25 => KeyK, 0x26 => KeyL,
        0x27 => Semicolon, 0x28 => Quote, 0x29 => Backquote, 0x2A => ShiftLeft, 0x2B => Backslash,
        0x2C => KeyZ, 0x2D => KeyX, 0x2E => KeyC, 0x2F => KeyV, 0x30 => KeyB,
        0x31 => KeyN, 0x32 => KeyM, 0x33 => Comma, 0x34 => Period, 0x35 => Slash,
        0x36 => ShiftRight, 0x37 => NumpadMultiply, 0x38 => AltLeft, 0x39 => Space, 0x3A => CapsLock,
        0x3B => F1, 0x3C => F2, 0x3D => F3, 0x3E => F4, 0x3F => F5,
        0x40 => F6, 0x41 => F7, 0x42 => F8, 0x43 => F9, 0x44 => F10,
        0x45 => NumLock, 0x46 => ScrollLock,
        // Numpad digits keep their code with NumLock off (VKey then says
        // VK_HOME etc., the scan code does not change) — same as the browser.
        0x47 => Numpad7, 0x48 => Numpad8, 0x49 => Numpad9, 0x4A => NumpadSubtract,
        0x4B => Numpad4, 0x4C => Numpad5, 0x4D => Numpad6, 0x4E => NumpadAdd,
        0x4F => Numpad1, 0x50 => Numpad2, 0x51 => Numpad3, 0x52 => Numpad0, 0x53 => NumpadDecimal,
        // SysRq: what PrintScreen sends while Alt is held.
        0x54 => PrintScreen,
        0x56 => IntlBackslash, 0x57 => F11, 0x58 => F12, 0x59 => NumpadEqual,
        0x64 => F13, 0x65 => F14, 0x66 => F15, 0x67 => F16, 0x68 => F17, 0x69 => F18,
        0x6A => F19, 0x6B => F20, 0x6C => F21, 0x6D => F22, 0x6E => F23, 0x76 => F24,
        0x70 => KanaMode, 0x73 => IntlRo, 0x79 => Convert, 0x7B => NonConvert,
        0x7D => IntlYen, 0x7E => NumpadComma,
        _ => return None,
    })
}

/// E0-prefixed make code → code. `None` for the E0 2A / E0 36 fake shifts and
/// for keys outside the vocabulary (media keys, etc.).
fn key_from_e0_scan(make: u16) -> Option<Key> {
    use Key::*;
    Some(match make {
        0x1C => NumpadEnter, 0x1D => ControlRight, 0x35 => NumpadDivide,
        0x37 => PrintScreen, 0x38 => AltRight, 0x45 => NumLock,
        // Ctrl+Pause sends E0 46 (Break) instead of the E1 sequence.
        0x46 => Pause,
        0x47 => Home, 0x48 => ArrowUp, 0x49 => PageUp, 0x4B => ArrowLeft,
        0x4D => ArrowRight, 0x4F => End, 0x50 => ArrowDown, 0x51 => PageDown,
        0x52 => Insert, 0x53 => Delete,
        0x5B => MetaLeft, 0x5C => MetaRight, 0x5D => ContextMenu,
        _ => return None,
    })
}

/// Virtual key → code, used only when the scan code is missing (some injected
/// input arrives with MakeCode 0). OEM punctuation assumes a US layout here,
/// which is the best a VK can say.
pub fn key_from_vk(vk: u16, e0: bool) -> Option<Key> {
    use Key::*;
    const LETTERS: [Key; 26] = [KeyA, KeyB, KeyC, KeyD, KeyE, KeyF, KeyG, KeyH, KeyI, KeyJ, KeyK, KeyL, KeyM,
        KeyN, KeyO, KeyP, KeyQ, KeyR, KeyS, KeyT, KeyU, KeyV, KeyW, KeyX, KeyY, KeyZ];
    const DIGITS: [Key; 10] = [Digit0, Digit1, Digit2, Digit3, Digit4, Digit5, Digit6, Digit7, Digit8, Digit9];
    const NUMPAD: [Key; 10] = [Numpad0, Numpad1, Numpad2, Numpad3, Numpad4, Numpad5, Numpad6, Numpad7, Numpad8, Numpad9];
    const FKEYS: [Key; 24] = [F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12,
        F13, F14, F15, F16, F17, F18, F19, F20, F21, F22, F23, F24];
    Some(match vk {
        0x41..=0x5A => LETTERS[(vk - 0x41) as usize],
        0x30..=0x39 => DIGITS[(vk - 0x30) as usize],
        0x60..=0x69 => NUMPAD[(vk - 0x60) as usize],
        0x70..=0x87 => FKEYS[(vk - 0x70) as usize],
        0x6A => NumpadMultiply, 0x6B => NumpadAdd, 0x6D => NumpadSubtract,
        0x6E => NumpadDecimal, 0x6F => NumpadDivide,
        0xBA => Semicolon, 0xBB => Equal, 0xBC => Comma, 0xBD => Minus, 0xBE => Period,
        0xBF => Slash, 0xC0 => Backquote, 0xDB => BracketLeft, 0xDC => Backslash,
        0xDD => BracketRight, 0xDE => Quote, 0xE2 => IntlBackslash,
        0x08 => Backspace, 0x09 => Tab,
        0x0D => if e0 { NumpadEnter } else { Enter },
        0x14 => CapsLock, 0x1B => Escape, 0x20 => Space,
        0x21 => PageUp, 0x22 => PageDown, 0x23 => End, 0x24 => Home,
        0x25 => ArrowLeft, 0x26 => ArrowUp, 0x27 => ArrowRight, 0x28 => ArrowDown,
        0x2D => Insert, 0x2E => Delete, 0x91 => ScrollLock,
        VK_PAUSE | VK_CANCEL => Pause, VK_SNAPSHOT => PrintScreen, VK_NUMLOCK => NumLock,
        0x5B => MetaLeft, 0x5C => MetaRight, 0x5D => ContextMenu,
        0x10 | 0xA0 => ShiftLeft, 0xA1 => ShiftRight,
        0x11 => if e0 { ControlRight } else { ControlLeft },
        0xA2 => ControlLeft, 0xA3 => ControlRight,
        0x12 => if e0 { AltRight } else { AltLeft },
        0xA4 => AltLeft, 0xA5 => AltRight,
        _ => return None,
    })
}

/// One RAWKEYBOARD → code. `None` means "not a key we track; ignore it"
/// (fake shifts, escape prefixes, overruns, media keys).
pub fn key_from_raw(make: u16, flags: u16, vkey: u16) -> Option<Key> {
    if vkey == VK_FAKE || make == OVERRUN_MAKE {
        return None;
    }
    let e0 = flags & RI_KEY_E0 != 0;
    // Keys whose scan codes are ambiguous or multi-part are decided by VKey:
    // Pause is E1 1D 45 (raw input: MakeCode 0x1D + RI_KEY_E1, VK_PAUSE, then
    // a VK 0xFF tail dropped above) while NumLock is a bare 45; Ctrl+Pause is
    // E0 46 (VK_CANCEL).
    match vkey {
        VK_PAUSE | VK_CANCEL => return Some(Key::Pause),
        VK_NUMLOCK => return Some(Key::NumLock),
        _ => {}
    }
    if flags & RI_KEY_E1 != 0 {
        return None;
    }
    if make == 0 {
        return key_from_vk(vkey, e0);
    }
    if e0 {
        // E0 2A / E0 36 are the fake shifts; nothing else maps them.
        key_from_e0_scan(make)
    } else {
        key_from_plain_scan(make).or_else(|| key_from_vk(vkey, false))
    }
}

/// The VK to probe with GetAsyncKeyState for a key, given the VK raw input
/// reported for it. Modifiers get their side-specific VK (raw input reports
/// the generic VK_SHIFT / VK_CONTROL / VK_MENU).
pub fn async_vk(key: Key, seen_vk: u16) -> u16 {
    match key {
        Key::ShiftLeft => 0xA0, Key::ShiftRight => 0xA1,
        Key::ControlLeft => 0xA2, Key::ControlRight => 0xA3,
        Key::AltLeft => 0xA4, Key::AltRight => 0xA5,
        Key::MetaLeft => 0x5B, Key::MetaRight => 0x5C,
        Key::Pause => VK_PAUSE,
        Key::NumLock => VK_NUMLOCK,
        _ => seen_vk,
    }
}

// ── Combos ───────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Combo {
    pub mods: u8,
    pub key: Key,
}

/// Older settings stored global-shortcut style keys ("Alt+W", "Ctrl+5",
/// "Space", "Up") rather than KeyboardEvent.code; map those to codes so
/// existing bindings keep working (2.0.10/2.0.11 rejected them and every
/// hotkey went dead for those users).
fn legacy_key_name(k: &str) -> Option<String> {
    let mut chars = k.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphabetic() {
            return Some(format!("Key{}", c.to_ascii_uppercase()));
        }
        if c.is_ascii_digit() {
            return Some(format!("Digit{c}"));
        }
        let punct = match c {
            '`' => "Backquote", '-' => "Minus", '=' => "Equal", '[' => "BracketLeft",
            ']' => "BracketRight", '\\' => "Backslash", ';' => "Semicolon", '\'' => "Quote",
            ',' => "Comma", '.' => "Period", '/' => "Slash",
            _ => return None,
        };
        return Some(punct.to_string());
    }
    let named = match k.to_ascii_lowercase().as_str() {
        "up" => "ArrowUp", "down" => "ArrowDown", "left" => "ArrowLeft", "right" => "ArrowRight",
        "esc" => "Escape", "return" => "Enter", "del" => "Delete", "ins" => "Insert",
        "pgup" => "PageUp", "pgdn" => "PageDown",
        lower => {
            // Case-insensitive match of an exact code ("space", "f5", "enter").
            let mut c = lower.chars();
            let first = c.next()?.to_ascii_uppercase();
            return Some(std::iter::once(first).chain(c).collect());
        }
    };
    Some(named.to_string())
}

/// Parses the accelerator strings keybinds.js stores ("Ctrl+Alt+KeyW").
/// `Ok(None)` for an empty string (unbound). Modifier names are matched
/// case-insensitively and accept the global-shortcut spellings too
/// (Control, Super, Command…); the key must be an exact KeyboardEvent.code.
pub fn parse_combo(s: &str) -> Result<Option<Combo>, String> {
    let s = s.trim();
    if s.is_empty() {
        return Ok(None);
    }
    let parts: Vec<&str> = s.split('+').map(str::trim).collect();
    let (last, mods_part) = parts.split_last().expect("split yields at least one part");
    let mut mods = 0u8;
    for m in mods_part {
        mods |= match m.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "commandorcontrol" | "cmdorctrl" => MOD_CTRL,
            "alt" | "option" => MOD_ALT,
            "shift" => MOD_SHIFT,
            "meta" | "super" | "win" | "cmd" | "command" => MOD_META,
            _ => return Err(format!("unknown modifier {m:?} in {s:?}")),
        };
    }
    let key = Key::from_name(last)
        .or_else(|| legacy_key_name(last).and_then(|n| Key::from_name(&n)))
        .ok_or_else(|| format!("unknown key {last:?} in {s:?}"))?;
    // A bare modifier code as the main key ("ControlRight") is allowed — a
    // common PTT choice — and doesn't also require its own modifier bit.
    Ok(Some(Combo { mods: mods & !key.modifier_bit(), key }))
}

// ── Matcher ──────────────────────────────────────────────────────────────────

struct Binding {
    name: String,
    combo: Combo,
    active: bool,
}

/// Key-state tracker + combo matcher. Pure (no Win32), so it is unit-tested
/// directly; the sink thread drives it. Nothing here allocates on key events.
pub struct Matcher {
    bindings: Vec<Binding>,
    down: [bool; Key::COUNT],
    seen_vk: [u16; Key::COUNT],
    /// Consecutive resync ticks GetAsyncKeyState has called a tracked key up.
    stale: [u8; Key::COUNT],
    down_count: usize,
    /// GetAsyncKeyState has been seen to agree with raw input at least once.
    /// Until then a resync never releases anything: if the API were blind to
    /// another process's input we'd otherwise cut PTT off mid-sentence.
    async_trusted: bool,
}

/// The hold-to-talk binding (keybinds.js `ptt`): the only one that tolerates
/// extra held modifiers.
const HOLD_BINDING: &str = "ptt";

/// Resync ticks a key must read "up" before it is force-released. Two ticks
/// also absorbs the benign race where a quick tap's key-up is still queued.
const STALE_TICKS: u8 = 2;

impl Default for Matcher {
    fn default() -> Self {
        Matcher {
            bindings: Vec::new(),
            down: [false; Key::COUNT],
            seen_vk: [0; Key::COUNT],
            stale: [0; Key::COUNT],
            down_count: 0,
            async_trusted: false,
        }
    }
}

impl Matcher {
    fn mods_except(&self, except: Option<Key>) -> u8 {
        let mut m = 0;
        for k in [Key::ControlLeft, Key::ControlRight, Key::AltLeft, Key::AltRight,
                  Key::ShiftLeft, Key::ShiftRight, Key::MetaLeft, Key::MetaRight] {
            if self.down[k as usize] && Some(k) != except {
                m |= k.modifier_bit();
            }
        }
        m
    }

    pub fn any_down(&self) -> bool {
        self.down_count > 0
    }

    pub fn binding_names(&self) -> Vec<String> {
        self.bindings.iter().map(|b| b.name.clone()).collect()
    }

    /// Replace every binding. Active ones are released first so a held PTT
    /// never outlives its binding.
    pub fn set_bindings(&mut self, bindings: Vec<(String, Combo)>, emit: &mut dyn FnMut(&str, bool)) {
        self.release_all_active(emit);
        self.bindings = bindings
            .into_iter()
            .map(|(name, combo)| Binding { name, combo, active: false })
            .collect();
    }

    fn release_all_active(&mut self, emit: &mut dyn FnMut(&str, bool)) {
        for b in &mut self.bindings {
            if b.active {
                b.active = false;
                emit(&b.name, false);
            }
        }
    }

    /// Forget all key state (session change, device removal). Active
    /// bindings emit their release.
    pub fn reset(&mut self, emit: &mut dyn FnMut(&str, bool)) {
        self.release_all_active(emit);
        self.down = [false; Key::COUNT];
        self.stale = [0; Key::COUNT];
        self.down_count = 0;
    }

    /// One physical key edge. Auto-repeat downs (key already down) are
    /// ignored; only matched binding edges are emitted.
    pub fn key_event(&mut self, key: Key, pressed: bool, vk: u16, emit: &mut dyn FnMut(&str, bool)) {
        let i = key as usize;
        if pressed {
            if self.down[i] {
                return; // typematic repeat
            }
            self.down[i] = true;
            self.down_count += 1;
            self.stale[i] = 0;
            if vk != 0 && vk != VK_FAKE {
                self.seen_vk[i] = vk;
            }
            let mods = self.mods_except(Some(key));
            // PTT matches with EXTRA modifiers held too (Shift = sprint, Ctrl
            // = crouch in most games): requiring them exact made talking fail
            // whenever one was down (owner report 2026-11-08, "spotty"). One-
            // shot actions stay exact, and an exact binding on the same key
            // wins (Alt+Q bound to something else never also keys PTT=Q).
            let exact_exists = self.bindings.iter().any(|b| b.combo.key == key && b.combo.mods == mods);
            for b in &mut self.bindings {
                if b.active || b.combo.key != key {
                    continue;
                }
                let hit = b.combo.mods == mods
                    || (!exact_exists && b.name == HOLD_BINDING && b.combo.mods & !mods == 0);
                if hit {
                    b.active = true;
                    emit(&b.name, true);
                }
            }
        } else {
            if !self.down[i] {
                return;
            }
            self.down[i] = false;
            self.down_count -= 1;
            self.stale[i] = 0;
            let bit = key.modifier_bit();
            let mods_now = if bit != 0 { self.mods_except(None) } else { 0 };
            for b in &mut self.bindings {
                if !b.active {
                    continue;
                }
                // Released when the main key goes up, or when a required
                // modifier is no longer held by either side.
                let lost_mod = bit != 0 && b.combo.mods & bit != 0 && mods_now & bit == 0;
                if b.combo.key == key || lost_mod {
                    b.active = false;
                    emit(&b.name, false);
                }
            }
        }
    }

    /// Reconcile tracked-down keys with the OS async key state, healing
    /// key-ups raw input never delivered (UIPI, secure desktop, focus loss
    /// mid-press). `probe(key, vk)` returns Some(is_down), or None when it
    /// can't tell (no VK known).
    pub fn resync(&mut self, probe: &mut dyn FnMut(Key, u16) -> Option<bool>, emit: &mut dyn FnMut(&str, bool)) {
        if self.down_count == 0 {
            return;
        }
        for &key in Key::ALL {
            let i = key as usize;
            if !self.down[i] {
                continue;
            }
            match probe(key, async_vk(key, self.seen_vk[i])) {
                Some(true) => {
                    self.async_trusted = true;
                    self.stale[i] = 0;
                }
                Some(false) => {
                    self.stale[i] = self.stale[i].saturating_add(1);
                    if self.async_trusted && self.stale[i] >= STALE_TICKS {
                        self.key_event(key, false, 0, emit);
                    }
                }
                None => {}
            }
        }
    }
}

/// Parse a `{ name: combo }` map into matcher bindings. Returns the accepted
/// bindings and `(name, error)` for the rejected ones; empty combos are
/// simply unbound.
pub fn parse_bindings(map: &HashMap<String, String>) -> (Vec<(String, Combo)>, Vec<(String, String)>) {
    let mut ok = Vec::new();
    let mut bad = Vec::new();
    let mut names: Vec<&String> = map.keys().collect();
    names.sort();
    for name in names {
        match parse_combo(&map[name]) {
            Ok(Some(c)) => ok.push((name.clone(), c)),
            Ok(None) => {}
            Err(e) => bad.push((name.clone(), e)),
        }
    }
    (ok, bad)
}

// ── Sink (Windows) ───────────────────────────────────────────────────────────

pub type EdgeSink = Box<dyn Fn(&str, bool) + Send + Sync>;

#[derive(Clone, serde::Serialize)]
pub struct HotkeysStatus {
    pub running: bool,
    pub error: Option<String>,
    pub bindings: Vec<String>,
    /// Keyboard WM_INPUT messages seen since start — non-zero proves input is
    /// arriving.
    pub raw_events: u64,
    /// Times the keyboard registration had to be reclaimed from another
    /// RegisterRawInputDevices call in this process.
    pub reclaims: u64,
}

#[derive(Clone, serde::Serialize)]
pub struct SetBindingsResult {
    pub accepted: Vec<String>,
    pub rejected: Vec<(String, String)>,
}

#[derive(Clone, serde::Serialize)]
struct HotkeyEdge<'a> {
    name: &'a str,
    pressed: bool,
}

#[cfg(windows)]
mod sink {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, MutexGuard, OnceLock};
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION};
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    use windows::Win32::UI::Input::{
        GetRawInputData, GetRegisteredRawInputDevices, RegisterRawInputDevices, HRAWINPUT, RAWINPUT,
        RAWINPUTDEVICE, RAWINPUTHEADER, RIDEV_DEVNOTIFY, RIDEV_INPUTSINK, RID_INPUT, RIM_TYPEKEYBOARD,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, SetTimer,
        TranslateMessage, GIDC_REMOVAL, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_INPUT,
        WM_INPUT_DEVICE_CHANGE, WM_TIMER, WM_WTSSESSION_CHANGE, WNDCLASSW,
    };

    pub(super) struct Shared {
        pub matcher: Mutex<Matcher>,
        pub emit: EdgeSink,
        pub raw_events: AtomicU64,
        pub reclaims: AtomicU64,
    }

    pub(super) static SHARED: OnceLock<Shared> = OnceLock::new();
    /// Ok(()) once the thread is pumping; Err(reason) if it failed to start.
    pub(super) static STARTED: OnceLock<Result<(), String>> = OnceLock::new();

    const TIMER_ID: usize = 1;
    const TICK_MS: u32 = 250;
    /// Every 8 ticks (~2 s) verify we still own the keyboard registration.
    const REG_CHECK_EVERY: u32 = 8;

    pub(super) fn lock(m: &Mutex<Matcher>) -> MutexGuard<'_, Matcher> {
        m.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn keyboard_device(hwnd: HWND) -> RAWINPUTDEVICE {
        RAWINPUTDEVICE {
            usUsagePage: 0x01,
            usUsage: 0x06,
            dwFlags: RIDEV_INPUTSINK | RIDEV_DEVNOTIFY,
            hwndTarget: hwnd,
        }
    }

    unsafe fn register_keyboard(hwnd: HWND) -> windows::core::Result<()> {
        RegisterRawInputDevices(&[keyboard_device(hwnd)], std::mem::size_of::<RAWINPUTDEVICE>() as u32)
    }

    /// Whether the process's keyboard raw input registration still targets
    /// `hwnd` with INPUTSINK.
    unsafe fn owns_keyboard(hwnd: HWND) -> bool {
        let mut devs = [RAWINPUTDEVICE::default(); 8];
        let mut n = devs.len() as u32;
        let got = GetRegisteredRawInputDevices(Some(devs.as_mut_ptr()), &mut n, std::mem::size_of::<RAWINPUTDEVICE>() as u32);
        if got == u32::MAX {
            return true; // can't tell (buffer too small); don't thrash
        }
        devs[..got as usize].iter().any(|d| {
            d.usUsagePage == 0x01 && d.usUsage == 0x06 && d.hwndTarget == hwnd && d.dwFlags.0 & RIDEV_INPUTSINK.0 != 0
        })
    }

    pub(super) fn start(emit: EdgeSink) -> Result<(), String> {
        STARTED
            .get_or_init(|| {
                if SHARED
                    .set(Shared {
                        matcher: Mutex::new(Matcher::default()),
                        emit,
                        raw_events: AtomicU64::new(0),
                        reclaims: AtomicU64::new(0),
                    })
                    .is_err()
                {
                    return Err("hotkey sink state already initialised".into());
                }
                let (tx, rx) = std::sync::mpsc::channel();
                let spawned = std::thread::Builder::new()
                    .name("specter-hotkeys".into())
                    .spawn(move || {
                        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe { run(&tx) }));
                        if r.is_err() {
                            crate::write_setup_error("[hotkeys] sink thread panicked; global hotkeys stopped");
                            let _ = tx.send(Err("sink thread panicked".into()));
                        }
                    });
                if let Err(e) = spawned {
                    return Err(format!("spawn failed: {e}"));
                }
                match rx.recv_timeout(std::time::Duration::from_secs(5)) {
                    Ok(r) => r,
                    Err(_) => Err("sink thread did not report ready within 5s".into()),
                }
            })
            .clone()
    }

    unsafe fn run(ready: &std::sync::mpsc::Sender<Result<(), String>>) {
        let fail = |what: String| {
            crate::write_setup_error(&format!("[hotkeys] {what}"));
            let _ = ready.send(Err(what));
        };
        let hinst = match GetModuleHandleW(None) {
            Ok(h) => h,
            Err(e) => return fail(format!("GetModuleHandleW failed: {e}")),
        };
        let class = w!("SpecterHotkeySink");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: hinst.into(),
            lpszClassName: class,
            ..Default::default()
        };
        // 0 also when the class already exists, which CreateWindowExW below
        // copes with; a real failure surfaces there.
        RegisterClassW(&wc);
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0), class, w!("SpecterHotkeySink"), WINDOW_STYLE(0),
            0, 0, 0, 0, HWND_MESSAGE, None, hinst, None,
        ) {
            Ok(h) => h,
            Err(e) => return fail(format!("CreateWindowExW(HWND_MESSAGE) failed: {e}")),
        };
        if let Err(e) = register_keyboard(hwnd) {
            return fail(format!("RegisterRawInputDevices(keyboard, INPUTSINK) failed: {e}"));
        }
        // Lock/unlock, fast user switching, RDP connect: reset key state.
        // Non-fatal — the async resync covers the same ground more slowly.
        if let Err(e) = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) {
            crate::write_setup_error(&format!("[hotkeys] WTSRegisterSessionNotification failed (non-fatal): {e}"));
        }
        if SetTimer(hwnd, TIMER_ID, TICK_MS, None) == 0 {
            crate::write_setup_error("[hotkeys] SetTimer failed (non-fatal): stuck-key resync disabled");
        }
        crate::write_setup_error("[hotkeys] raw input sink running");
        let _ = ready.send(Ok(()));

        let mut msg = MSG::default();
        loop {
            let r = GetMessageW(&mut msg, None, 0, 0);
            if r.0 == 0 || r.0 == -1 {
                break;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        crate::write_setup_error("[hotkeys] sink message loop exited");
    }

    fn emit_edge(name: &str, pressed: bool) {
        if let Some(s) = SHARED.get() {
            (s.emit)(name, pressed);
        }
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        // Never unwind across the FFI boundary.
        let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle(hwnd, msg, wparam, lparam)));
        if handled.is_err() {
            crate::write_setup_error(&format!("[hotkeys] panic handling message 0x{msg:04X}"));
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    static TICKS: AtomicU64 = AtomicU64::new(0);

    unsafe fn handle(hwnd: HWND, msg: u32, _wparam: WPARAM, lparam: LPARAM) {
        let Some(shared) = SHARED.get() else { return };
        match msg {
            WM_INPUT => {
                // Hot path: one stack buffer, no allocation, emit only on edges.
                let mut raw = RAWINPUT::default();
                let mut size = std::mem::size_of::<RAWINPUT>() as u32;
                let n = GetRawInputData(
                    HRAWINPUT(lparam.0 as *mut _),
                    RID_INPUT,
                    Some(&mut raw as *mut RAWINPUT as *mut core::ffi::c_void),
                    &mut size,
                    std::mem::size_of::<RAWINPUTHEADER>() as u32,
                );
                if n == u32::MAX || n == 0 || raw.header.dwType != RIM_TYPEKEYBOARD.0 {
                    return;
                }
                let kb = raw.data.keyboard;
                shared.raw_events.fetch_add(1, Ordering::Relaxed);
                if let Some(key) = key_from_raw(kb.MakeCode, kb.Flags, kb.VKey) {
                    let pressed = kb.Flags & RI_KEY_BREAK == 0;
                    lock(&shared.matcher).key_event(key, pressed, kb.VKey, &mut emit_edge);
                }
            }
            WM_INPUT_DEVICE_CHANGE => {
                // A keyboard unplugged mid-press never sends its key-ups.
                if _wparam.0 as u32 == GIDC_REMOVAL {
                    lock(&shared.matcher).reset(&mut emit_edge);
                }
            }
            WM_WTSSESSION_CHANGE => {
                lock(&shared.matcher).reset(&mut emit_edge);
            }
            WM_TIMER => {
                let tick = TICKS.fetch_add(1, Ordering::Relaxed) as u32;
                {
                    let mut m = lock(&shared.matcher);
                    if m.any_down() {
                        let mut probe = |_k: Key, vk: u16| -> Option<bool> {
                            if vk == 0 || vk == VK_FAKE {
                                None
                            } else {
                                Some(GetAsyncKeyState(vk as i32) as u16 & 0x8000 != 0)
                            }
                        };
                        m.resync(&mut probe, &mut emit_edge);
                    }
                }
                if tick % REG_CHECK_EVERY == 0 && !owns_keyboard(hwnd) {
                    shared.reclaims.fetch_add(1, Ordering::Relaxed);
                    match register_keyboard(hwnd) {
                        Ok(()) => crate::write_setup_error("[hotkeys] keyboard raw input registration was taken over; reclaimed"),
                        Err(e) => crate::write_setup_error(&format!("[hotkeys] reclaiming keyboard raw input failed: {e}")),
                    }
                }
            }
            _ => {}
        }
    }
}

/// Start the sink (idempotent) with an arbitrary edge callback.
#[cfg(windows)]
pub fn start(emit: EdgeSink) -> Result<(), String> {
    sink::start(emit)
}

#[cfg(not(windows))]
pub fn start(_emit: EdgeSink) -> Result<(), String> {
    Err("raw input hotkeys are Windows-only".into())
}

/// Replace all bindings on the running sink.
pub fn set_bindings(map: &HashMap<String, String>) -> Result<SetBindingsResult, String> {
    let (ok, bad) = parse_bindings(map);
    for (name, e) in &bad {
        crate::write_setup_error(&format!("[hotkeys] binding {name:?} rejected: {e}"));
    }
    let accepted: Vec<String> = ok.iter().map(|(n, _)| n.clone()).collect();
    #[cfg(windows)]
    {
        let shared = sink::SHARED.get().ok_or("hotkey sink not running")?;
        let mut emit = |n: &str, p: bool| (shared.emit)(n, p);
        sink::lock(&shared.matcher).set_bindings(ok, &mut emit);
    }
    #[cfg(not(windows))]
    {
        let _ = ok;
        return Err("raw input hotkeys are Windows-only".into());
    }
    #[allow(unreachable_code)]
    Ok(SetBindingsResult { accepted, rejected: bad })
}

pub fn status() -> HotkeysStatus {
    #[cfg(windows)]
    {
        use std::sync::atomic::Ordering;
        let started = sink::STARTED.get().cloned();
        let shared = sink::SHARED.get();
        return HotkeysStatus {
            running: matches!(started, Some(Ok(()))),
            error: match started {
                Some(Err(e)) => Some(e),
                None => Some("not started".into()),
                _ => None,
            },
            bindings: shared.map(|s| sink::lock(&s.matcher).binding_names()).unwrap_or_default(),
            raw_events: shared.map(|s| s.raw_events.load(Ordering::Relaxed)).unwrap_or(0),
            reclaims: shared.map(|s| s.reclaims.load(Ordering::Relaxed)).unwrap_or(0),
        };
    }
    #[allow(unreachable_code)]
    HotkeysStatus { running: false, error: Some("Windows-only".into()), bindings: vec![], raw_events: 0, reclaims: 0 }
}

// ── Tauri commands ───────────────────────────────────────────────────────────

/// Replace every global hotkey binding: `{ bindings: { [name]: combo } }`, an
/// empty combo meaning unbound. Starts the sink on first use. Errors (so the
/// caller falls back to tauri-plugin-global-shortcut) when the sink can't run.
#[tauri::command]
pub fn hotkeys_set_bindings(app: tauri::AppHandle, bindings: HashMap<String, String>) -> Result<SetBindingsResult, String> {
    use tauri::Emitter;
    let emitter = app.clone();
    let last_action: std::sync::Mutex<HashMap<String, std::time::Instant>> = Default::default();
    // The share-app hotkey needs to know which app was focused before ours.
    crate::share_target::ensure_started();
    start(Box::new(move |name, pressed| {
        if let Err(e) = emitter.emit("specter://hotkey", HotkeyEdge { name, pressed }) {
            crate::write_setup_error(&format!("[hotkeys] emit failed: {e}"));
        }
        // One-shot actions (overlay passthrough, channel toggle, stream next)
        // are dispatched from here, straight to every window, instead of
        // bouncing through the hidden engine webview's JS first: that hop
        // was the part that went missing while another app had focus.
        if pressed {
            if let Some(event) = action_event(name) {
                let mut last = last_action.lock().unwrap_or_else(|p| p.into_inner());
                let now = std::time::Instant::now();
                let fresh = last.get(name).map_or(true, |t| now.duration_since(*t).as_millis() >= 250);
                if fresh {
                    last.insert(name.to_string(), now);
                    crate::write_setup_error(&format!("[hotkeys] action {name} -> {event}"));
                    if let Err(e) = emitter.emit(event, ()) {
                        crate::write_setup_error(&format!("[hotkeys] action emit failed: {e}"));
                    }
                }
            }
        }
    }))?;
    set_bindings(&bindings)
}

/// Event a one-shot hotkey fires. Mirror of HOTKEY_ACTION_EVENTS in
/// web-portal/src/keybinds.js. PTT is not here: it needs both edges, which the
/// webview forwards as specter://ptt-active.
fn action_event(name: &str) -> Option<&'static str> {
    match name {
        "channelToggle" => Some("specter://cycle-freq"),
        "streamNext" => Some("specter://cycle-stream"),
        "overlayPassthrough" => Some("specter://overlay-passthrough"),
        "shareApp" => Some("specter://share-app"),
        _ => None,
    }
}

#[tauri::command]
pub fn hotkeys_status() -> HotkeysStatus {
    status()
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    type Edges = Vec<(String, bool)>;

    fn rec(edges: &mut Edges) -> impl FnMut(&str, bool) + '_ {
        move |n, p| edges.push((n.to_string(), p))
    }

    fn matcher_with(binds: &[(&str, &str)]) -> Matcher {
        let mut m = Matcher::default();
        let map: HashMap<String, String> = binds.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        let (ok, bad) = parse_bindings(&map);
        assert!(bad.is_empty(), "{bad:?}");
        m.set_bindings(ok, &mut |_, _| {});
        m
    }

    fn press(m: &mut Matcher, k: Key, e: &mut Edges) { m.key_event(k, true, 0, &mut rec(e)); }
    fn release(m: &mut Matcher, k: Key, e: &mut Edges) { m.key_event(k, false, 0, &mut rec(e)); }

    /// Mirror of ACCEL_KEY_CODES in web-portal/src/keybinds.js — every code the
    /// settings UI can record must be a Key. Keep in step with that file.
    #[test]
    fn every_recordable_code_is_a_key() {
        let mut codes: Vec<String> = Vec::new();
        codes.extend((b'A'..=b'Z').map(|c| format!("Key{}", c as char)));
        codes.extend((0..10).map(|i| format!("Digit{i}")));
        codes.extend((1..=24).map(|i| format!("F{i}")));
        codes.extend((0..10).map(|i| format!("Numpad{i}")));
        for c in ["NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide",
            "NumpadDecimal", "NumpadEnter", "NumpadEqual", "NumLock",
            "Backquote", "Backslash", "BracketLeft", "BracketRight", "Comma", "Equal",
            "Minus", "Period", "Quote", "Semicolon", "Slash",
            "Backspace", "CapsLock", "Enter", "Space", "Tab", "Delete", "End", "Home",
            "Insert", "PageDown", "PageUp", "PrintScreen", "ScrollLock", "Pause",
            "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "Escape"] {
            codes.push(c.to_string());
        }
        for c in &codes {
            assert!(Key::from_name(c).is_some(), "{c} missing");
        }
    }

    /// And every one of them is reachable from a real scan code.
    #[test]
    fn every_key_reachable_from_a_scan_code() {
        let mut reached = std::collections::HashSet::new();
        for make in 0u16..0x80 {
            if let Some(k) = key_from_raw(make, 0, 1) { reached.insert(k); }
            if let Some(k) = key_from_raw(make, RI_KEY_E0, 1) { reached.insert(k); }
        }
        reached.insert(key_from_raw(0x1D, RI_KEY_E1, VK_PAUSE).unwrap());
        for &k in Key::ALL {
            assert!(reached.contains(&k), "{} has no scan code", k.name());
        }
    }

    #[test]
    fn scan_code_mapping() {
        assert_eq!(key_from_raw(0x11, 0, 0x57), Some(Key::KeyW));
        assert_eq!(key_from_raw(0x10, 0, 0x41), Some(Key::KeyQ)); // AZERTY: positional
        assert_eq!(key_from_raw(0x02, 0, 0x31), Some(Key::Digit1));
        assert_eq!(key_from_raw(0x0B, 0, 0x30), Some(Key::Digit0));
        // Left/right modifiers.
        assert_eq!(key_from_raw(0x1D, 0, 0x11), Some(Key::ControlLeft));
        assert_eq!(key_from_raw(0x1D, RI_KEY_E0, 0x11), Some(Key::ControlRight));
        assert_eq!(key_from_raw(0x38, 0, 0x12), Some(Key::AltLeft));
        assert_eq!(key_from_raw(0x38, RI_KEY_E0, 0x12), Some(Key::AltRight));
        assert_eq!(key_from_raw(0x2A, 0, 0x10), Some(Key::ShiftLeft));
        assert_eq!(key_from_raw(0x36, 0, 0x10), Some(Key::ShiftRight));
        assert_eq!(key_from_raw(0x5B, RI_KEY_E0, 0x5B), Some(Key::MetaLeft));
        // Numpad vs extended navigation cluster.
        assert_eq!(key_from_raw(0x47, 0, 0x67), Some(Key::Numpad7));
        assert_eq!(key_from_raw(0x47, 0, 0x24), Some(Key::Numpad7)); // NumLock off: VK_HOME
        assert_eq!(key_from_raw(0x47, RI_KEY_E0, 0x24), Some(Key::Home));
        assert_eq!(key_from_raw(0x1C, 0, 0x0D), Some(Key::Enter));
        assert_eq!(key_from_raw(0x1C, RI_KEY_E0, 0x0D), Some(Key::NumpadEnter));
        assert_eq!(key_from_raw(0x35, RI_KEY_E0, 0x6F), Some(Key::NumpadDivide));
        assert_eq!(key_from_raw(0x35, 0, 0xBF), Some(Key::Slash));
        assert_eq!(key_from_raw(0x37, 0, 0x6A), Some(Key::NumpadMultiply));
        assert_eq!(key_from_raw(0x53, RI_KEY_E0, 0x2E), Some(Key::Delete));
        assert_eq!(key_from_raw(0x53, 0, 0x6E), Some(Key::NumpadDecimal));
        assert_eq!(key_from_raw(0x48, RI_KEY_E0, 0x26), Some(Key::ArrowUp));
        // F keys incl. the F13–F24 block.
        assert_eq!(key_from_raw(0x57, 0, 0x7A), Some(Key::F11));
        assert_eq!(key_from_raw(0x64, 0, 0x7C), Some(Key::F13));
        assert_eq!(key_from_raw(0x76, 0, 0x87), Some(Key::F24));
    }

    #[test]
    fn special_sequences() {
        // Pause: E1 1D 45 → first event VK_PAUSE, tail VK 0xFF ignored.
        assert_eq!(key_from_raw(0x1D, RI_KEY_E1, VK_PAUSE), Some(Key::Pause));
        assert_eq!(key_from_raw(0x45, 0, VK_FAKE), None);
        // Ctrl+Pause (Break) = E0 46 / VK_CANCEL.
        assert_eq!(key_from_raw(0x46, RI_KEY_E0, VK_CANCEL), Some(Key::Pause));
        // NumLock reported as bare 45 with VK_NUMLOCK (sometimes E0-flagged).
        assert_eq!(key_from_raw(0x45, 0, VK_NUMLOCK), Some(Key::NumLock));
        assert_eq!(key_from_raw(0x45, RI_KEY_E0, VK_NUMLOCK), Some(Key::NumLock));
        // ScrollLock is a plain 46 and must not become Pause.
        assert_eq!(key_from_raw(0x46, 0, 0x91), Some(Key::ScrollLock));
        // PrintScreen: E0 2A (fake shift, VK 0xFF) E0 37; Alt+PrtSc = 54.
        assert_eq!(key_from_raw(0x2A, RI_KEY_E0, VK_FAKE), None);
        assert_eq!(key_from_raw(0x2A, RI_KEY_E0, 0x10), None); // fake shift even if VK says shift
        assert_eq!(key_from_raw(0x36, RI_KEY_E0, 0x10), None);
        assert_eq!(key_from_raw(0x37, RI_KEY_E0, VK_SNAPSHOT), Some(Key::PrintScreen));
        assert_eq!(key_from_raw(0x54, 0, VK_SNAPSHOT), Some(Key::PrintScreen));
        // Overrun and unknown media keys.
        assert_eq!(key_from_raw(OVERRUN_MAKE, 0, 0), None);
        assert_eq!(key_from_raw(0x22, RI_KEY_E0, 0xB3), None); // Play/Pause
    }

    #[test]
    fn vk_fallback_when_scan_code_missing() {
        assert_eq!(key_from_raw(0, 0, 0x57), Some(Key::KeyW));
        assert_eq!(key_from_raw(0, 0, 0x87), Some(Key::F24));
        assert_eq!(key_from_raw(0, RI_KEY_E0, 0x11), Some(Key::ControlRight));
        assert_eq!(key_from_raw(0, 0, 0xA1), Some(Key::ShiftRight));
        assert_eq!(key_from_raw(0, RI_KEY_E0, 0x0D), Some(Key::NumpadEnter));
        assert_eq!(key_from_raw(0, 0, 0x07), None);
    }

    #[test]
    fn combo_parsing() {
        assert_eq!(parse_combo(""), Ok(None));
        assert_eq!(parse_combo("  "), Ok(None));
        assert_eq!(parse_combo("Alt+KeyW"), Ok(Some(Combo { mods: MOD_ALT, key: Key::KeyW })));
        assert_eq!(parse_combo("Ctrl+Alt+Shift+Meta+F24"),
            Ok(Some(Combo { mods: MOD_CTRL | MOD_ALT | MOD_SHIFT | MOD_META, key: Key::F24 })));
        assert_eq!(parse_combo("Control+Super+NumpadAdd"),
            Ok(Some(Combo { mods: MOD_CTRL | MOD_META, key: Key::NumpadAdd })));
        assert_eq!(parse_combo("Backquote"), Ok(Some(Combo { mods: 0, key: Key::Backquote })));
        assert_eq!(parse_combo("ControlRight"), Ok(Some(Combo { mods: 0, key: Key::ControlRight })));
        assert_eq!(parse_combo("Ctrl+ControlRight"), Ok(Some(Combo { mods: 0, key: Key::ControlRight })));
        // Legacy letter spellings are accepted (see legacy_combo_spellings_parse).
        assert_eq!(parse_combo("Alt+w"), Ok(Some(Combo { mods: MOD_ALT, key: Key::KeyW })));
        assert!(parse_combo("Alt+Wx").is_err());
        assert!(parse_combo("Hyper+KeyA").is_err());
        assert!(parse_combo("Ctrl+").is_err());
        assert!(parse_combo("Ctrl+Alt").is_err());
    }

    #[test]
    fn exact_modifiers_and_edges() {
        let mut m = matcher_with(&[("overlay", "Alt+KeyW"), ("ptt", "KeyV")]);
        let mut e = Edges::new();
        // Plain W: nothing.
        press(&mut m, Key::KeyW, &mut e);
        release(&mut m, Key::KeyW, &mut e);
        assert!(e.is_empty());
        // Alt (either side) + W: pressed then released on W up.
        press(&mut m, Key::AltRight, &mut e);
        press(&mut m, Key::KeyW, &mut e);
        assert_eq!(e, vec![("overlay".into(), true)]);
        release(&mut m, Key::KeyW, &mut e);
        assert_eq!(e.last(), Some(&("overlay".into(), false)));
        release(&mut m, Key::AltRight, &mut e);
        assert_eq!(e.len(), 2);
        // Ctrl+Alt+W does not match Alt+W (exact modifiers).
        e.clear();
        press(&mut m, Key::ControlLeft, &mut e);
        press(&mut m, Key::AltLeft, &mut e);
        press(&mut m, Key::KeyW, &mut e);
        assert!(e.is_empty());
        for k in [Key::KeyW, Key::AltLeft, Key::ControlLeft] { release(&mut m, k, &mut e); }
        // Shift+V (sprinting) DOES key an unmodified PTT: PTT tolerates
        // extra modifiers, one-shots (Alt+W above) don't.
        press(&mut m, Key::ShiftLeft, &mut e);
        press(&mut m, Key::KeyV, &mut e);
        assert_eq!(e, vec![("ptt".into(), true)]);
        release(&mut m, Key::KeyV, &mut e);
        assert_eq!(e.last(), Some(&("ptt".into(), false)));
        release(&mut m, Key::ShiftLeft, &mut e);
        assert!(!m.any_down());
    }

    #[test]
    fn ptt_with_extra_modifiers_but_exact_binding_wins() {
        let mut m = matcher_with(&[("ptt", "KeyQ"), ("streamNext", "Alt+KeyQ"), ("channelToggle", "KeyZ")]);
        let mut e = Edges::new();
        // Ctrl+Shift held (crouch + sprint) still talks.
        press(&mut m, Key::ControlLeft, &mut e);
        press(&mut m, Key::ShiftLeft, &mut e);
        press(&mut m, Key::KeyQ, &mut e);
        release(&mut m, Key::KeyQ, &mut e);
        assert_eq!(e, vec![("ptt".into(), true), ("ptt".into(), false)]);
        for k in [Key::ShiftLeft, Key::ControlLeft] { release(&mut m, k, &mut e); }
        // Alt+Q is someone else's exact combo: it doesn't also key PTT.
        e.clear();
        press(&mut m, Key::AltLeft, &mut e);
        press(&mut m, Key::KeyQ, &mut e);
        assert_eq!(e, vec![("streamNext".into(), true)]);
        release(&mut m, Key::KeyQ, &mut e);
        release(&mut m, Key::AltLeft, &mut e);
        // A one-shot stays exact: Shift+Z is not Z.
        e.clear();
        press(&mut m, Key::ShiftLeft, &mut e);
        press(&mut m, Key::KeyZ, &mut e);
        assert!(e.is_empty());
    }

    #[test]
    fn auto_repeat_is_ignored() {
        let mut m = matcher_with(&[("ptt", "KeyV")]);
        let mut e = Edges::new();
        for _ in 0..20 { press(&mut m, Key::KeyV, &mut e); }
        release(&mut m, Key::KeyV, &mut e);
        release(&mut m, Key::KeyV, &mut e); // stray extra up
        assert_eq!(e, vec![("ptt".into(), true), ("ptt".into(), false)]);
    }

    /// Alt+E regression: a held one-shot key (typematic repeats = repeated
    /// make codes, no break) fires once; down-up-down fires twice.
    #[test]
    fn one_shot_held_fires_once_tapped_twice_fires_twice() {
        let mut m = matcher_with(&[("streamNext", "Alt+KeyE")]);
        let mut e = Edges::new();
        press(&mut m, Key::AltLeft, &mut e);
        for _ in 0..30 { press(&mut m, Key::AltLeft, &mut e); press(&mut m, Key::KeyE, &mut e); }
        assert_eq!(e, vec![("streamNext".into(), true)]);
        release(&mut m, Key::KeyE, &mut e);
        press(&mut m, Key::KeyE, &mut e);
        release(&mut m, Key::KeyE, &mut e);
        let presses = e.iter().filter(|(_, p)| *p).count();
        assert_eq!(presses, 2);
        assert_eq!(e.len(), 4);
    }

    #[test]
    fn modifier_release_ends_binding_but_other_side_keeps_it() {
        let mut m = matcher_with(&[("ptt", "Ctrl+KeyB")]);
        let mut e = Edges::new();
        press(&mut m, Key::ControlLeft, &mut e);
        press(&mut m, Key::KeyB, &mut e);
        press(&mut m, Key::ControlRight, &mut e);
        release(&mut m, Key::ControlLeft, &mut e); // right Ctrl still held
        assert_eq!(e, vec![("ptt".into(), true)]);
        release(&mut m, Key::ControlRight, &mut e);
        assert_eq!(e, vec![("ptt".into(), true), ("ptt".into(), false)]);
        // B still down: no re-press until B goes down again.
        press(&mut m, Key::ControlLeft, &mut e);
        assert_eq!(e.len(), 2);
    }

    #[test]
    fn extra_modifier_while_held_does_not_release() {
        let mut m = matcher_with(&[("ptt", "KeyV")]);
        let mut e = Edges::new();
        press(&mut m, Key::KeyV, &mut e);
        press(&mut m, Key::ShiftLeft, &mut e); // sprint while talking
        release(&mut m, Key::ShiftLeft, &mut e);
        assert_eq!(e, vec![("ptt".into(), true)]);
        release(&mut m, Key::KeyV, &mut e);
        assert_eq!(e.last(), Some(&("ptt".into(), false)));
    }

    #[test]
    fn modifier_as_main_key() {
        let mut m = matcher_with(&[("ptt", "ControlRight")]);
        let mut e = Edges::new();
        press(&mut m, Key::ControlLeft, &mut e);
        assert!(e.is_empty());
        release(&mut m, Key::ControlLeft, &mut e);
        press(&mut m, Key::ControlRight, &mut e);
        release(&mut m, Key::ControlRight, &mut e);
        assert_eq!(e, vec![("ptt".into(), true), ("ptt".into(), false)]);
    }

    #[test]
    fn two_bindings_same_key_different_mods() {
        let mut m = matcher_with(&[("a", "KeyQ"), ("b", "Alt+KeyQ")]);
        let mut e = Edges::new();
        press(&mut m, Key::AltLeft, &mut e);
        press(&mut m, Key::KeyQ, &mut e);
        release(&mut m, Key::KeyQ, &mut e);
        assert_eq!(e, vec![("b".into(), true), ("b".into(), false)]);
    }

    #[test]
    fn rebinding_releases_held_binding() {
        let mut m = matcher_with(&[("ptt", "KeyV")]);
        let mut e = Edges::new();
        press(&mut m, Key::KeyV, &mut e);
        m.set_bindings(vec![], &mut rec(&mut e));
        assert_eq!(e, vec![("ptt".into(), true), ("ptt".into(), false)]);
        // Key state survives: the eventual up is a no-op, no phantom edges.
        release(&mut m, Key::KeyV, &mut e);
        assert_eq!(e.len(), 2);
    }

    #[test]
    fn reset_releases_and_clears() {
        let mut m = matcher_with(&[("ptt", "Alt+KeyV")]);
        let mut e = Edges::new();
        press(&mut m, Key::AltLeft, &mut e);
        press(&mut m, Key::KeyV, &mut e);
        m.reset(&mut rec(&mut e));
        assert_eq!(e, vec![("ptt".into(), true), ("ptt".into(), false)]);
        assert!(!m.any_down());
        // A fresh press works again after reset.
        press(&mut m, Key::AltLeft, &mut e);
        press(&mut m, Key::KeyV, &mut e);
        assert_eq!(e.last(), Some(&("ptt".into(), true)));
    }

    #[test]
    fn resync_heals_lost_key_up_only_once_trusted() {
        let mut m = matcher_with(&[("ptt", "KeyV")]);
        let mut e = Edges::new();
        m.key_event(Key::KeyV, true, 0x56, &mut rec(&mut e));
        // Untrusted async state: never release, however long it reads up.
        for _ in 0..10 { m.resync(&mut |_, _| Some(false), &mut rec(&mut e)); }
        assert_eq!(e, vec![("ptt".into(), true)]);
        // One agreeing read establishes trust...
        let mut probed = Vec::new();
        m.resync(&mut |k, vk| { probed.push((k, vk)); Some(true) }, &mut rec(&mut e));
        assert_eq!(probed, vec![(Key::KeyV, 0x56)]);
        // ...then a lost key-up heals after STALE_TICKS consecutive "up" reads.
        m.resync(&mut |_, _| Some(false), &mut rec(&mut e));
        assert_eq!(e.len(), 1);
        m.resync(&mut |_, _| Some(false), &mut rec(&mut e));
        assert_eq!(e, vec![("ptt".into(), true), ("ptt".into(), false)]);
        assert!(!m.any_down());
    }

    #[test]
    fn resync_probes_side_specific_modifier_vks() {
        let mut m = matcher_with(&[]);
        let mut e = Edges::new();
        m.key_event(Key::ShiftRight, true, 0x10, &mut rec(&mut e));
        m.key_event(Key::ControlLeft, true, 0x11, &mut rec(&mut e));
        let mut vks = Vec::new();
        m.resync(&mut |_, vk| { vks.push(vk); None }, &mut rec(&mut e));
        vks.sort();
        assert_eq!(vks, vec![0xA1, 0xA2]);
    }

    /// The bindings a real 2.0.11 install had saved ("Ctrl+Q", "Alt+W",
    /// "Alt+E") were all rejected, killing every hotkey. Legacy forms must
    /// parse to the same combos as their KeyboardEvent.code spellings.
    #[test]
    fn legacy_combo_spellings_parse() {
        for (legacy, code) in [
            ("Ctrl+Q", "Ctrl+KeyQ"), ("Alt+W", "Alt+KeyW"), ("Alt+E", "Alt+KeyE"),
            ("alt+w", "Alt+KeyW"), ("Ctrl+5", "Ctrl+Digit5"), ("Shift+Space", "Shift+Space"),
            ("space", "Space"), ("f5", "F5"), ("Up", "ArrowUp"), ("Ctrl+-", "Ctrl+Minus"),
            ("Alt+;", "Alt+Semicolon"), ("Esc", "Escape"),
        ] {
            assert_eq!(parse_combo(legacy).unwrap(), parse_combo(code).unwrap(), "{legacy} vs {code}");
        }
        assert!(parse_combo("Alt+NotAKey").is_err());
    }

    #[test]
    fn rejected_bindings_are_reported() {
        let map: HashMap<String, String> = [("a", "Alt+KeyW"), ("b", ""), ("c", "Alt+Nope")]
            .iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        let (ok, bad) = parse_bindings(&map);
        assert_eq!(ok.len(), 1);
        assert_eq!(ok[0].0, "a");
        assert_eq!(bad.len(), 1);
        assert_eq!(bad[0].0, "c");
    }

    /// Live end-to-end check of the real sink: injects Ctrl+Alt+Shift+F24 with
    /// SendInput (harmless; nothing binds it) and waits for the matched edges.
    /// Run with: cargo test --lib hotkeys::tests::live_sendinput -- --ignored
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn live_sendinput() {
        use std::sync::mpsc;
        use std::time::Duration;
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, VIRTUAL_KEY,
        };
        let (tx, rx) = mpsc::channel::<(String, bool)>();
        let tx = std::sync::Mutex::new(tx);
        start(Box::new(move |n, p| { let _ = tx.lock().unwrap().send((n.to_string(), p)); })).expect("sink start");
        let map: HashMap<String, String> = [("probe".to_string(), "Ctrl+Alt+Shift+F24".to_string())].into();
        set_bindings(&map).expect("set bindings");

        let key = |scan: u16, vk: u16, up: bool, by_scan: bool| {
            let mut flags = KEYBD_EVENT_FLAGS(0);
            if by_scan { flags |= KEYEVENTF_SCANCODE; }
            if up { flags |= KEYEVENTF_KEYUP; }
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(if by_scan { 0 } else { vk }), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0,
                } },
            }
        };
        for by_scan in [true, false] {
            let seq = [
                key(0x1D, 0xA2, false, by_scan), // LCtrl
                key(0x38, 0xA4, false, by_scan), // LAlt
                key(0x2A, 0xA0, false, by_scan), // LShift
                key(0x76, 0x87, false, by_scan), // F24 down
                key(0x76, 0x87, false, by_scan), // repeat (ignored)
                key(0x76, 0x87, true, by_scan),  // F24 up
                key(0x2A, 0xA0, true, by_scan),
                key(0x38, 0xA4, true, by_scan),
                key(0x1D, 0xA2, true, by_scan),
            ];
            let sent = unsafe { SendInput(&seq, std::mem::size_of::<INPUT>() as i32) };
            assert_eq!(sent as usize, seq.len(), "SendInput blocked (UIPI / secure desktop?)");
            let a = rx.recv_timeout(Duration::from_secs(2)).expect(&format!("no press edge (by_scan={by_scan}), status: {:?}", status().raw_events));
            let b = rx.recv_timeout(Duration::from_secs(2)).expect("no release edge");
            assert_eq!(a, ("probe".to_string(), true), "by_scan={by_scan}");
            assert_eq!(b, ("probe".to_string(), false), "by_scan={by_scan}");
            assert!(rx.recv_timeout(Duration::from_millis(300)).is_err(), "unexpected extra edge");
        }
        assert!(status().running);
    }
}
