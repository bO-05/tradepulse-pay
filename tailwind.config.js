/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0fdf4',
          100: '#dcfce7',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
          900: '#14532d',
        },
        slate: {
          750: '#222f44',
          850: '#151f30',
          950: '#0a0f1d',
        },
        // Design-system tokens used by src/ui. Text/background pairs keep WCAG AA contrast on the dark theme.
        surface: {
          sunken: '#0a0f1d',
          DEFAULT: '#0f172a',
          raised: '#1e293b',
          overlay: '#111827',
        },
        line: {
          DEFAULT: '#334155',
          strong: '#475569',
        },
        ink: {
          DEFAULT: '#f1f5f9',
          muted: '#cbd5e1',
          subtle: '#a3b1c6',
        },
        accent: {
          DEFAULT: '#15803d',
          hover: '#166534',
          fg: '#ffffff',
        },
        danger: {
          DEFAULT: '#dc2626',
          hover: '#b91c1c',
          fg: '#fecaca',
        },
        focus: '#38bdf8',
      },
      minHeight: {
        touch: '44px',
      },
      zIndex: {
        dialog: '80',
        toast: '90',
      },
    },
  },
  plugins: [],
}
