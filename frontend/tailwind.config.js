/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand:    { DEFAULT: '#1d4ed8', light: '#dbeafe', dark: '#1e3a8a' },
        success:  { DEFAULT: '#15803d', light: '#dcfce7', dark: '#14532d' },
        danger:   { DEFAULT: '#b91c1c', light: '#fee2e2', dark: '#7f1d1d' },
        warning:  { DEFAULT: '#b45309', light: '#fef3c7' },
        neutral:  { DEFAULT: '#374151', light: '#f1f5f9' },
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      boxShadow: {
        card:  '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        panel: '0 4px 24px rgba(0,0,0,0.08)',
      },
      borderRadius: { xl2: '1rem', xl3: '1.25rem' },
    },
  },
  plugins: [],
}
