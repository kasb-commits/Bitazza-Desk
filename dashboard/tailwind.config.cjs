/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: ['attribute', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // ── Surface scale (dark mode defaults, overridden by CSS vars) ──
        surface: {
          0: 'var(--surface-0)',
          1: 'var(--surface-1)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
          4: 'var(--surface-4)',
          5: 'var(--surface-5)',
        },
        // ── Text ──
        text: {
          primary:   'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted:     'var(--text-muted)',
        },
        // ── Brand ──
        brand: {
          DEFAULT: '#00CE80',
          dim:     '#079755',
          subtle:  'rgba(0,206,128,0.08)',
        },
        // ── Status / Accent ──
        accent: {
          blue:  '#528AF1',
          green: '#00CE80',
          amber: '#F4B72A',
          red:   '#EF4150',
        },
      },
      fontFamily: {
        sans: ['"FF Mark Pro"', '"Mark Pro"', '"Noto Sans"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
      },
      fontSize: {
        '2xs': ['10px', { lineHeight: '14px' }],
        'xs':  ['12px', { lineHeight: '16px' }],
        'sm':  ['13px', { lineHeight: '20px' }],
        'base':['14px', { lineHeight: '22px' }],
        'md':  ['15px', { lineHeight: '24px' }],
        'lg':  ['18px', { lineHeight: '28px' }],
        'xl':  ['24px', { lineHeight: '32px' }],
        '2xl': ['32px', { lineHeight: '40px' }],
      },
      boxShadow: {
        card:    'none',
        panel:   'none',
        modal:   'none',
        tooltip: 'none',
      },
      borderRadius: {
        sm:  '8px',
        DEFAULT: '8px',
        md:  '8px',
        lg:  '12px',
        xl:  '16px',
        full: '9999px',
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        'pulse-border': {
          '0%, 100%': { borderLeftColor: '#E63946', opacity: '1' },
          '50%':      { borderLeftColor: '#E63946', opacity: '0.4' },
        },
        'slide-in-right': {
          from: { transform: 'translateX(100%)', opacity: '0' },
          to:   { transform: 'translateX(0)',    opacity: '1' },
        },
        'slide-in-up': {
          from: { transform: 'translateY(8px)', opacity: '0' },
          to:   { transform: 'translateY(0)',   opacity: '1' },
        },
        'scale-in': {
          from: { transform: 'scale(0.95)', opacity: '0' },
          to:   { transform: 'scale(1)',    opacity: '1' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to:   { opacity: '1' },
        },
        ping: {
          '75%, 100%': { transform: 'scale(2)', opacity: '0' },
        },
      },
      animation: {
        'pulse-border':   'pulse-border 2s ease-in-out infinite',
        'slide-in-right': 'slide-in-right 0.25s cubic-bezier(0.16,1,0.3,1)',
        'slide-in-up':    'slide-in-up 0.2s cubic-bezier(0.16,1,0.3,1)',
        'scale-in':       'scale-in 0.15s cubic-bezier(0.16,1,0.3,1)',
        'fade-in':        'fade-in 0.15s ease-out',
      },
    },
  },
  plugins: [],
};
