/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Design Token mappings - keep in sync with design-tokens.json
        specter: {
          bg: {
            deep: "#020913",
            surface: "#081828",
            panel: "#10263a",
            overlay: "rgba(6, 22, 35, 0.86)"
          },
          primary: {
            cyan: "#06b6d4",
            neon: "#22d3ee",
            dim: "#1d6d86",
            gold: "#ffd700",
          },
          state: {
            success: "#10b981",
            warning: "#f59e0b",
            error: "#ef4444",
            info: "#3b82f6"
          },
          text: {
            main: "#ecf9ff",
            muted: "#b7d1df",
            // Secondary lines (subtitles, hints). 7.19:1 on bg.surface, 6.19:1 on bg.panel.
            subtle: "#86a9bd",
            terminal: "#33ff00"
          },
          border: {
            DEFAULT: "rgba(95, 209, 240, 0.24)",
            strong: "rgba(103, 218, 245, 0.34)",
            divider: "rgba(255, 255, 255, 0.06)",
            focus: "#22d3ee"
          },
          // BRAND (2026-11-12 refresh): the brand pack's palette. `ink` is the
          // strip's panel surface; `cyan` is the accent for active states only.
          // Contrast on ink: text.subtle 7.1:1, steel 5.0:1, error 5.6:1.
          brand: {
            night: "#050B10",   // near-black
            ink: "#0A1A24",     // blue-black: strip panels
            steel: "#7A8B97",   // steel-gray: idle chrome
            cyan: "#00E5FF",    // accent: active / selected
            error: "#FF5266",   // semantic muted / error
            tile: "rgba(122, 139, 151, 0.30)",       // tile border, idle
            "tile-hover": "rgba(122, 139, 151, 0.55)", // tile border, hover
          }
        },
        'command-gold': '#ffd700',
        'tactical-cyan': '#00f2ff',
      },
      fontFamily: {
        mono: ['"Consolas"', '"JetBrains Mono"', 'monospace'],
        sans: ['"Bahnschrift"', '"Rajdhani"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        // Redesign UI face — used by components/ui. Keep `sans`/`mono` for legacy screens.
        ui: ['"Segoe UI Variable"', '"Segoe UI"', 'Inter', 'system-ui', 'sans-serif'],
      },
      // Redesign type scale and radii are namespaced (`ui-*`) so they don't
      // change Tailwind's stock text-xs / rounded-lg etc. that existing screens use.
      fontSize: {
        'ui-xs':   ['12px', { lineHeight: '16px' }],
        'ui-sm':   ['13px', { lineHeight: '18px' }],
        'ui-base': ['14px', { lineHeight: '20px' }],
        'ui-lg':   ['16px', { lineHeight: '22px' }],
        'ui-xl':   ['20px', { lineHeight: '28px' }],
      },
      borderRadius: {
        'ui-sm':  '6px',
        'ui-row': '8px',   // list rows and form controls
        'ui-md':  '10px',
        'ui-lg':  '14px',
        'pill':   '9999px',
      },
      backgroundImage: {
        'grid-pattern': "linear-gradient(to right, rgba(84, 167, 196, 0.16) 1px, transparent 1px), linear-gradient(to bottom, rgba(84, 167, 196, 0.14) 1px, transparent 1px)",
      }
    },
  },
  plugins: [],
}
