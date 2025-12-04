/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: '#0f172a',      // slate-900
          surface: '#1e293b', // slate-800
          border: '#334155',  // slate-700
          text: '#e2e8f0',    // slate-200
          muted: '#94a3b8',   // slate-400
          accent: {
            green: '#22c55e',  // green-500
            cyan: '#06b6d4',   // cyan-500
            blue: '#3b82f6',   // blue-500
          },
        },
      },
      fontFamily: {
        mono: ['Roboto Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
