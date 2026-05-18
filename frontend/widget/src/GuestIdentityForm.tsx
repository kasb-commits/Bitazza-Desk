import { useState } from 'react';

interface Props {
  primaryColor: string;
  onSubmit: (name: string, email: string) => void;
}

export default function GuestIdentityForm({ primaryColor, onSubmit }: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [focusedField, setFocusedField] = useState<'name' | 'email' | null>(null);

  const handleStart = () => onSubmit(name.trim(), email.trim());
  const handleSkip = () => onSubmit('', '');

  const inputStyle = (field: 'name' | 'email'): React.CSSProperties => ({
    width: '100%',
    boxSizing: 'border-box',
    border: `1.5px solid ${focusedField === field ? primaryColor : '#e8eaf0'}`,
    borderRadius: '12px',
    padding: '10px 14px',
    fontSize: '13.5px',
    outline: 'none',
    background: focusedField === field ? '#fff' : '#f8f9fc',
    color: '#1e293b',
    transition: 'border-color 0.18s, background 0.18s, box-shadow 0.18s',
    boxShadow: focusedField === field
      ? `0 0 0 3px ${primaryColor}18, 0 1px 4px rgba(0,0,0,0.05)`
      : '0 1px 2px rgba(0,0,0,0.04)',
    fontFamily: 'inherit',
  });

  return (
    <div style={{
      margin: '4px 0 8px',
      background: '#ffffff',
      border: '1px solid rgba(0,0,0,0.06)',
      borderRadius: '18px',
      borderBottomLeftRadius: '4px',
      boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
      padding: '20px 18px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
      animation: 'csbot-msg-in 0.22s ease-out',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{
          width: '32px', height: '32px', borderRadius: '50%',
          background: `linear-gradient(135deg, ${primaryColor}22, ${primaryColor}44)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={primaryColor} strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        </div>
        <div>
          <p style={{ margin: 0, fontSize: '13.5px', fontWeight: 600, color: '#1e293b', lineHeight: 1.3 }}>
            Before we begin
          </p>
          <p style={{ margin: 0, fontSize: '11.5px', color: '#94a3b8', lineHeight: 1.3 }}>
            ก่อนเริ่มต้น · optional / ไม่บังคับ
          </p>
        </div>
      </div>

      {/* Fields */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <label style={{ fontSize: '11.5px', fontWeight: 600, color: '#64748b', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
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
          <label style={{ fontSize: '11.5px', fontWeight: 600, color: '#64748b', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
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
            borderRadius: '10px',
            border: '1.5px solid #e8eaf0',
            background: 'transparent',
            color: '#94a3b8',
            fontSize: '13px',
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'border-color 0.15s, color 0.15s',
            fontFamily: 'inherit',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#cbd5e1'; e.currentTarget.style.color = '#64748b'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#e8eaf0'; e.currentTarget.style.color = '#94a3b8'; }}
        >
          Skip
        </button>
        <button
          onClick={handleStart}
          style={{
            flex: 2,
            padding: '9px 12px',
            borderRadius: '10px',
            border: 'none',
            background: `linear-gradient(135deg, ${primaryColor}, ${primaryColor}cc)`,
            color: 'white',
            fontSize: '13px',
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: `0 2px 8px ${primaryColor}44`,
            transition: 'opacity 0.15s, box-shadow 0.15s',
            fontFamily: 'inherit',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '5px',
          }}
          onMouseEnter={e => { e.currentTarget.style.opacity = '0.9'; e.currentTarget.style.boxShadow = `0 4px 12px ${primaryColor}55`; }}
          onMouseLeave={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.boxShadow = `0 2px 8px ${primaryColor}44`; }}
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
