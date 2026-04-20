/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: {
          DEFAULT: '#F5F1E8',
          raised: '#FBF8F1',
          deep: '#EDE7D6',
        },
        ink: {
          DEFAULT: '#1A1A1A',
          soft: '#3D3A36',
          muted: '#847F74',
        },
        rule: {
          DEFAULT: '#D9D2BE',
          strong: '#BFB69D',
        },
        accent: {
          DEFAULT: '#5C6B3E',
          soft: '#E8EAD8',
          warm: '#A8583A',
          'warm-soft': '#F3DFCF',
        },
        amber: {
          soft: '#C89B3C',
          'soft-bg': '#F4E6C2',
        },
      },
      fontFamily: {
        display: ['"Fraunces"', 'ui-serif', 'Georgia', 'serif'],
        sans: ['"Geist"', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      letterSpacing: {
        caps: '0.18em',
      },
      boxShadow: {
        hairline: '0 1px 0 rgba(26,26,26,0.06)',
      },
      keyframes: {
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        fadeInUp: 'fadeInUp 500ms ease-out both',
      },
    },
  },
  plugins: [],
};
