/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        specter: {
          bg: {
            deep: "#020617",
            surface: "#0f172a",
            panel: "#1e293b",
            overlay: "rgba(15, 23, 42, 0.8)"
          },
          primary: {
            cyan: "#06b6d4",
            neon: "#22d3ee",
            dim: "#155e75",
            gold: "#ffd700",
          },
          state: {
            success: "#10b981",
            warning: "#f59e0b",
            error: "#ef4444",
            info: "#3b82f6"
          },
          text: {
            main: "#f8fafc",
            muted: "#cbd5e1",
            terminal: "#33ff00"
          }
        },
        'command-gold': '#ffd700',
        'tactical-cyan': '#00f2ff',
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      backgroundImage: {
        'grid-pattern': "linear-gradient(to right, #1e293b 1px, transparent 1px), linear-gradient(to bottom, #1e293b 1px, transparent 1px)",
      }
    },
  },
  plugins: [],
}
