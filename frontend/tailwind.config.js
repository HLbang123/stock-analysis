/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bull: {
          light: '#ef4444',  // Chinese: red = up
          DEFAULT: '#dc2626',
          dark: '#b91c1c',
        },
        bear: {
          light: '#22c55e',   // Chinese: green = down
          DEFAULT: '#16a34a',
          dark: '#15803d',
        },
        surface: {
          DEFAULT: '#0f172a',
          card: '#1e293b',
          border: '#334155',
        },
      },
    },
  },
  plugins: [],
};
