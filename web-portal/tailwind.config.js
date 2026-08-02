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
            terminal: "#33ff00"
          }
        },
        'command-gold': '#ffd700',
        'tactical-cyan': '#00f2ff',
      },
      fontFamily: {
        mono: ['"Consolas"', '"JetBrains Mono"', 'monospace'],
        sans: ['"Bahnschrift"', '"Rajdhani"', '"Segoe UI"', 'system-ui', 'sans-serif'],
      },
      backgroundImage: {
        'grid-pattern': "linear-gradient(to right, rgba(84, 167, 196, 0.16) 1px, transparent 1px), linear-gradient(to bottom, rgba(84, 167, 196, 0.14) 1px, transparent 1px)",
      }
    },
  },
  plugins: [],
}
