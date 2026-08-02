import React, { useState, useEffect } from 'react';

/**
 * Custom window title bar — replaces the native OS title bar when
 * tauri.conf.json has `decorations: false`. Only renders inside the Tauri
 * runtime; returns null in a web browser.
 *
 * The drag region uses `data-tauri-drag-region` so the window can be moved by
 * clicking and dragging the title bar area. Window controls (minimize /
 * maximize / close) call Tauri APIs directly and bypass the now-absent native
 * title bar buttons.
 */
export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const isTauriRuntime = Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__);

  useEffect(() => {
    if (!isTauriRuntime) return;
    let unlisten = null;
    const init = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        setMaximized(await win.isMaximized());
        unlisten = await win.onResized(async () => {
          setMaximized(await win.isMaximized());
        });
      } catch {}
    };
    init();
    return () => { if (unlisten) unlisten(); };
  }, []);

  if (!isTauriRuntime) return null;

  const handleMinimize = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().minimize();
    } catch {}
  };

  const handleMaximize = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().toggleMaximize();
    } catch {}
  };

  const handleClose = async () => {
    // Call the dedicated close_app Rust command — direct AppHandle::exit(0),
    // bypasses all window-event plumbing and plugin indirection.
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('close_app');
    } catch {}
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 28,
        zIndex: 99999,
        display: 'flex',
        alignItems: 'stretch',
        background: 'rgba(2, 8, 16, 0.97)',
        borderBottom: '1px solid #0e2233',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      {/* Drag region — fills the title bar except for the control buttons */}
      <div
        data-tauri-drag-region
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 10,
          cursor: 'default',
        }}
      >
        <span
          data-tauri-drag-region
          style={{
            fontSize: 10,
            color: '#0e4a6e',
            letterSpacing: '0.3em',
            fontFamily: 'monospace',
            pointerEvents: 'none',
          }}
        >
          SPECTERCOMS
        </span>
      </div>

      {/* Window controls */}
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        {/* Minimize */}
        <button
          onClick={handleMinimize}
          tabIndex={-1}
          title="Minimize"
          style={{
            width: 44,
            border: 'none',
            background: 'transparent',
            color: '#4b5563',
            fontSize: 14,
            lineHeight: 1,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; e.currentTarget.style.color = '#e2e8f0'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#4b5563'; }}
        >
          {/* em dash looks cleaner than ─ */}
          &#x2014;
        </button>

        {/* Maximize / Restore */}
        <button
          onClick={handleMaximize}
          tabIndex={-1}
          title="Maximize"
          style={{
            width: 44,
            border: 'none',
            background: 'transparent',
            color: '#4b5563',
            fontSize: 11,
            lineHeight: 1,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; e.currentTarget.style.color = '#e2e8f0'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#4b5563'; }}
        >
          {maximized ? '⧉' : '□'}
        </button>

        {/* Close */}
        <button
          onClick={handleClose}
          tabIndex={-1}
          title="Close"
          style={{
            width: 44,
            border: 'none',
            background: 'transparent',
            color: '#4b5563',
            fontSize: 13,
            lineHeight: 1,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#b91c1c'; e.currentTarget.style.color = '#fff'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#4b5563'; }}
        >
          &#x2715;
        </button>
      </div>
    </div>
  );
}
