import { useState } from 'react';

interface Props {
  primaryColor: string;
  onSubmit: (name: string, email: string) => void;
}

export default function GuestIdentityForm({ onSubmit }: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [focusedField, setFocusedField] = useState<'name' | 'email' | null>(null);

  const handleStart = () => onSubmit(name.trim(), email.trim());
  const handleSkip = () => onSubmit('', '');

  const inputStyle = (field: 'name' | 'email'): React.CSSProperties => ({
    width: '100%',
    boxSizing: 'border-box',
    border: `1.5px solid ${focusedField === field ? '#00CE80' : '#EDEDF8'}`,
    borderRadius: 12,
    padding: '10px 14px',
    fontSize: 14,
    outline: 'none',
    background: focusedField === field ? '#ffffff' : '#FCFCFE',
    color: '#1B1A18',
    transition: 'border-color 0.18s, background 0.18s',
    boxShadow: 'none',
    fontFamily: '"FF Mark Pro","Mark Pro","Noto Sans","Inter",system-ui,sans-serif',
    letterSpacing: 0,
  });

  return (
    <div style={{
      margin: '4px 0 8px',
      background: '#ffffff',
      border: '1px solid #EDEDF8',
      borderRadius: 12,
      borderBottomLeftRadius: 4,
      boxShadow: 'none',
      padding: '20px 18px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
      animation: 'csbot-msg-in 0.22s ease-out',
      fontFamily: '"FF Mark Pro","Mark Pro","Noto Sans","Inter",system-ui,sans-serif',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          background: '#F0FEF8',
          boxShadow: 'inset 0 0 0 1px #00CE80',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
          color: '#079755',
        }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        </div>
        <div>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1B1A18', lineHeight: 1.3 }}>
            Before we begin
          </p>
          <p style={{ margin: 0, fontSize: 12, color: 'rgba(27,26,24,0.5)', lineHeight: 1.3 }}>
            ก่อนเริ่มต้น · optional / ไม่บังคับ
          </p>
        </div>
      </div>

      {/* Fields */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'rgba(27,26,24,0.75)', letterSpacing: 0 }}>
            Name / ชื่อ
          </label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. John"
            style={inputStyle('name')}
            onFocus={() => setFocusedField('name')}
            onBlur={() => setFocusedField(null)}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'rgba(27,26,24,0.75)', letterSpacing: 0 }}>
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com"
            style={inputStyle('email')}
            onFocus={() => setFocusedField('email')}
            onBlur={() => setFocusedField(null)}
            onKeyDown={e => { if (e.key === 'Enter') handleStart(); }}
          />
        </div>
      </div>

      {/* Buttons */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          onClick={handleSkip}
          style={{
            flex: 1,
            padding: '9px 12px',
            borderRadius: 8,
            border: '1.5px solid #EDEDF8',
            background: 'transparent',
            color: 'rgba(27,26,24,0.5)',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'border-color 0.15s, color 0.15s',
            fontFamily: 'inherit',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#EDEDF8'; e.currentTarget.style.color = 'rgba(27,26,24,0.75)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#EDEDF8'; e.currentTarget.style.color = 'rgba(27,26,24,0.5)'; }}
        >
          Skip
        </button>
        <button
          onClick={handleStart}
          style={{
            flex: 2,
            padding: '9px 12px',
            borderRadius: 8,
            border: 'none',
            background: '#00CE80',
            color: '#1B1A18',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: 'none',
            transition: 'background 0.15s',
            fontFamily: 'inherit',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '5px',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#079755'; }}
          onMouseLeave={e => { e.currentTarget.style.background = '#00CE80'; }}
        >
          Start Chat
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
