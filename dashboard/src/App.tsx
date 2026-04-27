import { useState, useEffect, useRef } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { PermissionProvider } from './PermissionContext';
import type { Ticket, InboxView, StatusFilter, AgentStatus, WSEvent, Role, Notification } from './types';
import { api, createWS } from './api';
import { NotificationPanel } from './components/NotificationPanel';
import { ToastContainer } from './components/ToastContainer';
import type { Toast } from './components/ToastContainer';
import ConversationList from './components/ConversationList';
import MessageThread from './components/MessageThread';
import PropertiesPanel from './components/PropertiesPanel';
import SupervisorDashboard from './components/SupervisorDashboard';
import AnalyticsDashboard from './components/AnalyticsDashboard';
import AdminSettings from './components/AdminSettings';
import AIStudio from './components/AIStudio';
import MetricsDashboard from './components/MetricsDashboard';
import InsightsDashboard from './components/InsightsDashboard';
import HomeDashboard from './components/HomeDashboard';
import KnowledgeBase from './components/KnowledgeBase';
import User360 from './components/User360';

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  name: string;
  email?: string;
  role: Role;
  team?: string;
  token: string;
  permissions: string[];
}

function getAuthUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem('auth_user');
    if (!raw) return null;
    const u = JSON.parse(raw) as AuthUser;
    if (!u.permissions || u.permissions.length === 0) {
      localStorage.removeItem('auth_user');
      return null;
    }
    return u;
  } catch { return null; }
}

function setAuthUser(u: AuthUser | null) {
  if (u) localStorage.setItem('auth_user', JSON.stringify(u));
  else localStorage.removeItem('auth_user');
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function getTheme(): 'dark' | 'light' {
  return (localStorage.getItem('theme') as 'dark' | 'light') ?? 'dark';
}

function applyTheme(t: 'dark' | 'light') {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
}

// ── Permission guard ──────────────────────────────────────────────────────────

function PermissionGuard({ permission, user, children }: { permission: string; user: AuthUser | null; children: React.ReactNode }) {
  if (!user) return <Navigate to="/login" replace />;
  if (!(user.permissions ?? []).includes(permission)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function hasPerm(user: AuthUser | null, permission: string): boolean {
  return (user?.permissions ?? []).includes(permission);
}

// ── Login ─────────────────────────────────────────────────────────────────────

function LoginPage({ onLogin }: { onLogin: (u: AuthUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email || !password) { setError('Enter your email and password to continue.'); return; }
    setLoading(true);
    try {
      const data = await api.login(email.trim().toLowerCase(), password);
      onLogin({ ...data.user, role: data.user.role as Role, token: data.token, permissions: (data.user as { permissions?: string[] }).permissions ?? [] });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-0 relative overflow-hidden">
      {/* Ambient background texture */}
      <svg className="absolute bottom-0 right-0 opacity-[0.04] pointer-events-none" width="600" height="400" viewBox="0 0 600 400" fill="none">
        <polyline points="0,300 60,250 120,280 180,200 240,220 300,160 360,180 420,120 480,140 540,80 600,100" stroke="#E63946" strokeWidth="2" fill="none"/>
        <polyline points="0,350 60,310 120,330 180,260 240,275 300,210 360,230 420,170 480,185 540,130 600,150" stroke="#E63946" strokeWidth="1.5" fill="none"/>
        <polyline points="0,380 60,355 120,365 180,320 240,330 300,285 360,295 420,250 480,260 540,215 600,230" stroke="#E63946" strokeWidth="1" fill="none"/>
      </svg>

      <form
        onSubmit={handleSubmit}
        className="w-96 bg-surface-3 ring-1 ring-surface-5 shadow-modal rounded-xl p-8 relative z-10 animate-scale-in"
      >
        {/* Logo */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-8 h-8 rounded-md bg-brand flex items-center justify-center shrink-0">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
                d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 01-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 011-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 011.52 0C14.51 3.81 17 5 19 5a1 1 0 011 1z"/>
            </svg>
          </div>
          <div>
            <div className="text-text-primary font-bold text-md leading-tight">Bitazza Help Desk</div>
            <div className="text-text-muted text-xs">Customer Support Platform</div>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="flex items-start gap-2.5 bg-red-950/60 ring-1 ring-red-800/60 rounded-md p-3 mb-5">
            <svg className="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
            </svg>
            <p className="text-red-300 text-xs leading-relaxed">{error}</p>
          </div>
        )}

        {/* Email field */}
        <label className="block text-xs font-medium text-text-secondary mb-1.5">Email address</label>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          className="w-full bg-surface-2 ring-1 ring-surface-5 text-text-primary px-3 py-2.5 text-sm mb-4 rounded-md outline-none focus:ring-brand transition-all placeholder:text-text-muted"
          placeholder="agent@bitazza.com"
          autoComplete="email"
        />

        {/* Password field */}
        <label className="block text-xs font-medium text-text-secondary mb-1.5">Password</label>
        <div className="relative mb-6">
          <input
            type={showPwd ? 'text' : 'password'}
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full bg-surface-2 ring-1 ring-surface-5 text-text-primary px-3 py-2.5 pr-10 text-sm rounded-md outline-none focus:ring-brand transition-all"
            autoComplete="current-password"
          />
          <button
            type="button"
            onClick={() => setShowPwd(v => !v)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
            tabIndex={-1}
          >
            {showPwd ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"/>
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
              </svg>
            )}
          </button>
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-brand hover:bg-brand-dim text-white text-sm py-2.5 rounded-md transition-colors font-semibold flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {loading && (
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
          )}
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

// ── Agent state toggle ────────────────────────────────────────────────────────

const AGENT_STATES: AgentStatus[] = ['Available', 'Busy', 'Break', 'Offline'];

const STATE_DOT: Record<string, string> = {
  Available: 'bg-accent-green',
  Busy:      'bg-accent-amber',
  Break:     'bg-text-muted',
  Offline:   'bg-brand',
};

const STATE_LABEL: Record<AgentStatus, string> = {
  Available: 'Available', Busy: 'Busy', Break: 'Break', Offline: 'Offline',
  away: 'Away', after_call_work: 'ACW',
};

const STATE_DESC: Record<AgentStatus, string> = {
  Available: 'Ready to receive tickets',
  Busy: 'In a conversation, limited availability',
  Break: 'On break, tickets remain assigned',
  Offline: 'Offline, tickets will be re-queued',
  away: 'Away temporarily',
  after_call_work: 'Post-call wrap-up',
};

interface AgentToggleProps {
  status: AgentStatus;
  activeChats: number;
  onChange: (s: AgentStatus) => void;
}

function AgentStateToggle({ status, activeChats, onChange }: AgentToggleProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<AgentStatus | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelect = (s: AgentStatus) => {
    setOpen(false);
    if (s === status) return;
    if (s === 'Offline' && activeChats > 0) { setPending(s); return; }
    onChange(s);
  };

  return (
    <>
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-2 px-3 h-9 rounded-md ring-1 ring-surface-5 bg-surface-3 hover:bg-surface-4 transition-colors text-xs"
        >
          <span className={`w-2 h-2 rounded-full shrink-0 ${STATE_DOT[status] ?? 'bg-text-muted'} ${status === 'Available' ? 'relative' : ''}`}>
            {status === 'Available' && (
              <span className="absolute inset-0 rounded-full bg-accent-green animate-ping opacity-75" />
            )}
          </span>
          <span className="text-text-primary font-medium">{STATE_LABEL[status]}</span>
          <svg className="w-3 h-3 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {open && (
          <div className="absolute right-0 top-full mt-1.5 w-52 bg-surface-3 ring-1 ring-surface-5 rounded-lg shadow-panel overflow-hidden z-50 animate-slide-in-up">
            {AGENT_STATES.map(s => (
              <button key={s} onClick={() => handleSelect(s)}
                className={`w-full flex items-start gap-3 px-3.5 py-2.5 text-xs hover:bg-surface-4 transition-colors text-left ${s === status ? 'bg-surface-4' : ''}`}
              >
                <span className={`w-2 h-2 rounded-full mt-1 shrink-0 ${STATE_DOT[s]}`} />
                <div>
                  <div className={`font-medium ${s === status ? 'text-text-primary' : 'text-text-secondary'}`}>{STATE_LABEL[s]}</div>
                  <div className="text-text-muted text-[11px] mt-0.5">{STATE_DESC[s]}</div>
                </div>
                {s === status && (
                  <svg className="w-3.5 h-3.5 text-brand ml-auto mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/>
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Offline confirmation modal */}
      {pending && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 animate-fade-in">
          <div className="bg-surface-3 ring-1 ring-surface-5 p-6 w-80 rounded-xl shadow-modal animate-scale-in">
            <div className="w-10 h-10 rounded-full bg-brand/10 ring-1 ring-brand/20 flex items-center justify-center mb-4">
              <svg className="w-5 h-5 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
              </svg>
            </div>
            <h3 className="font-bold text-sm mb-1.5 text-text-primary">Go Offline?</h3>
            <p className="text-sm text-text-secondary mb-5 leading-relaxed">
              You have <strong className="text-text-primary font-semibold">{activeChats}</strong> active chat{activeChats !== 1 ? 's' : ''}. Going offline will re-queue them for other agents.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setPending(null)}
                className="px-4 py-1.5 text-sm ring-1 ring-surface-5 rounded-md hover:bg-surface-4 transition-colors text-text-secondary active:scale-[0.98]">
                Cancel
              </button>
              <button onClick={() => { onChange(pending); setPending(null); }}
                className="px-4 py-1.5 text-sm bg-brand text-white rounded-md hover:bg-brand-dim transition-colors active:scale-[0.98]">
                Go Offline
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────────

const Icons = {
  home: (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-[18px] h-[18px]">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M3 9.75L12 3l9 6.75V21a.75.75 0 01-.75.75H15v-6H9v6H3.75A.75.75 0 013 21V9.75z" />
    </svg>
  ),
  inbox: (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-[18px] h-[18px]">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859M3 7.5h18M3 12h18" />
    </svg>
  ),
  analytics: (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-[18px] h-[18px]">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
    </svg>
  ),
  supervisor: (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-[18px] h-[18px]">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
    </svg>
  ),
  metrics: (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-[18px] h-[18px]">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M7.5 14.25v2.25m3-4.5v4.5m3-6.75v6.75m3-9v9M6 20.25h12A2.25 2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 2.25 0 006 20.25z" />
    </svg>
  ),
  insights: (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-[18px] h-[18px]">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
    </svg>
  ),
  studio: (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-[18px] h-[18px]">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25zm.75-12h9v9h-9v-9z" />
    </svg>
  ),
  knowledge: (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-[18px] h-[18px]">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.966 8.966 0 00-6 2.292m0-14.25v14.25" />
    </svg>
  ),
  users: (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-[18px] h-[18px]">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/>
    </svg>
  ),
  admin: (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-[18px] h-[18px]">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
  chevronLeft: (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.75 19.5L8.25 12l7.5-7.5" />
    </svg>
  ),
  chevronRight: (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  ),
  bell: (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-[18px] h-[18px]">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
    </svg>
  ),
  sun: (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
    </svg>
  ),
  moon: (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
    </svg>
  ),
  search: (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
    </svg>
  ),
};

// ── Sidebar ───────────────────────────────────────────────────────────────────

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  permission: string;
  shortcut?: string;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/',           label: 'Home',       icon: Icons.home,       permission: 'section.home',       shortcut: '⌘2' },
  { to: '/inbox',      label: 'Inbox',      icon: Icons.inbox,      permission: 'section.inbox',      shortcut: '⌘1' },
  { to: '/supervisor', label: 'Supervisor', icon: Icons.supervisor, permission: 'section.supervisor', shortcut: '⌘3' },
  { to: '/insights',   label: 'Insights',   icon: Icons.insights,   permission: 'section.analytics',  shortcut: '⌘4' },
  { to: '/knowledge',  label: 'Knowledge Base',  icon: Icons.knowledge,  permission: 'section.knowledge' },
  { to: '/users',      label: 'User360',    icon: Icons.users,      permission: 'section.users' },
  { to: '/studio',     label: 'Workflow Studio',  icon: Icons.studio,     permission: 'section.studio' },
  { to: '/admin',      label: 'Admin',      icon: Icons.admin,      permission: 'section.admin' },
];

const PAGE_TITLES: Record<string, string> = {
  '/':           'Home',
  '/inbox':      'Inbox',
  '/supervisor': 'Supervisor',
  '/insights':   'Insights',
  '/knowledge':  'Knowledge Base',
  '/users':      'User360',
  '/studio':     'Workflow Studio',
  '/admin':      'Admin',
};

// Auto-generate avatar color from name (consistent per name)
function nameToColor(name: string): string {
  const colors = ['#E63946','#3B82F6','#22C55E','#F59E0B','#8B5CF6','#EC4899','#14B8A6','#F97316'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

interface SidebarProps {
  user: AuthUser;
  collapsed: boolean;
  onToggle: () => void;
  onLogout: () => void;
  theme: 'dark' | 'light';
  onThemeToggle: () => void;
}

function Sidebar({ user, collapsed, onToggle, onLogout, theme, onThemeToggle }: SidebarProps) {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const visibleItems = NAV_ITEMS.filter(n => (user.permissions ?? []).includes(n.permission));
  const initials = user.name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const avatarColor = nameToColor(user.name);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowUserMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <aside
      className="flex flex-col bg-surface-1 shrink-0 border-r border-surface-5 transition-all duration-200 ease-out-expo"
      style={{ width: collapsed ? 56 : 220 }}
    >
      {/* Logo */}
      <div className={`flex items-center gap-3 px-3.5 h-12 border-b border-surface-5 shrink-0 ${collapsed ? 'justify-center' : ''}`}>
        <div className="w-7 h-7 rounded-md bg-brand flex items-center justify-center shrink-0">
          <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
              d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 01-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 011-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 011.52 0C14.51 3.81 17 5 19 5a1 1 0 011 1z"/>
          </svg>
        </div>
        {!collapsed && (
          <span className="text-text-primary font-bold text-sm whitespace-nowrap">Help Desk</span>
        )}
      </div>

      {/* Nav items */}
      <nav className="flex-1 py-2 overflow-y-auto overflow-x-hidden">
        {visibleItems.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            title={collapsed ? `${item.label}${item.shortcut ? '  ' + item.shortcut : ''}` : undefined}
            className={({ isActive }) =>
              `flex items-center gap-3 mx-2 px-2.5 py-2.5 rounded-md mb-0.5 transition-colors duration-100
               ${isActive
                 ? 'bg-brand-subtle text-text-primary border-l-2 border-brand pl-[9px]'
                 : 'text-text-secondary hover:text-text-primary hover:bg-surface-4'
               }`
            }
          >
            <span className="shrink-0">{item.icon}</span>
            {!collapsed && (
              <span className="text-sm font-medium whitespace-nowrap flex-1">{item.label}</span>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Bottom: theme + user + collapse */}
      <div className="border-t border-surface-5 py-2 shrink-0">
        {/* Theme toggle */}
        <button
          onClick={onThemeToggle}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className={`w-full flex items-center gap-3 px-3 py-2 mx-0 text-text-muted hover:text-text-secondary hover:bg-surface-4 transition-colors ${collapsed ? 'justify-center' : 'mx-2'}`}
          style={{ width: collapsed ? undefined : 'calc(100% - 16px)', marginLeft: collapsed ? 0 : 8 }}
        >
          <span className="shrink-0">{theme === 'dark' ? Icons.sun : Icons.moon}</span>
          {!collapsed && <span className="text-xs">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>}
        </button>

        {/* User menu */}
        <div ref={menuRef} className="relative mx-2 mt-1">
          <button
            onClick={() => setShowUserMenu(o => !o)}
            className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md hover:bg-surface-4 transition-colors ${collapsed ? 'justify-center' : ''}`}
          >
            <div
              className="w-7 h-7 rounded-full text-white text-[11px] font-bold flex items-center justify-center shrink-0 ring-2"
              style={{ backgroundColor: avatarColor, '--tw-ring-color': avatarColor + '40' } as React.CSSProperties}
            >
              {initials}
            </div>
            {!collapsed && (
              <div className="min-w-0 text-left">
                <div className="text-text-primary text-xs font-medium truncate">{user.name}</div>
                <div className="text-text-muted text-[10px] capitalize truncate">{user.role.replace('_', ' ')}</div>
              </div>
            )}
          </button>

          {showUserMenu && (
            <div className={`absolute ${collapsed ? 'left-full ml-2 bottom-0' : 'bottom-full mb-1 left-0 right-0'} bg-surface-3 ring-1 ring-surface-5 rounded-lg shadow-panel overflow-hidden z-50 w-40 animate-slide-in-up`}>
              <div className="px-4 py-2.5 border-b border-surface-5">
                <div className="text-text-primary text-xs font-medium truncate">{user.name}</div>
                <div className="text-text-muted text-[10px] truncate">{user.email}</div>
              </div>
              <button onClick={onLogout}
                className="w-full px-4 py-2.5 text-left text-xs text-brand hover:bg-surface-4 transition-colors flex items-center gap-2">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
                </svg>
                Sign out
              </button>
            </div>
          )}
        </div>

        {/* Collapse toggle */}
        <button
          onClick={onToggle}
          style={{ width: 'calc(100% - 16px)' }}
          className={`flex items-center gap-3 px-2.5 py-2 mx-2 mt-1 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-4 transition-colors ${collapsed ? 'justify-center' : ''}`}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <span className="shrink-0">{collapsed ? Icons.chevronRight : Icons.chevronLeft}</span>
          {!collapsed && <span className="text-xs">Collapse</span>}
        </button>
      </div>
    </aside>
  );
}

// ── Top Bar ───────────────────────────────────────────────────────────────────

interface TopBarProps {
  myStatus: AgentStatus;
  activeChats: number;
  onStatusChange: (s: AgentStatus) => void;
  onSearchOpen: () => void;
  unreadNotifCount: number;
  onNotificationsOpen: () => void;
}

function TopBar({ myStatus, activeChats, onStatusChange, onSearchOpen, unreadNotifCount, onNotificationsOpen }: TopBarProps) {
  const location = useLocation();
  const title = PAGE_TITLES[location.pathname] ?? 'Help Desk';

  return (
    <div className="h-12 bg-surface-2 border-b border-surface-5 flex items-center px-5 shrink-0 gap-4">
      <h1 className="text-md font-semibold text-text-primary shrink-0">{title}</h1>

      {/* Center search bar */}
      <div className="flex-1 flex justify-center">
        <button
          onClick={onSearchOpen}
          className="flex items-center gap-2 h-8 w-full max-w-xl px-3 rounded-md ring-1 ring-surface-5 bg-surface-3 hover:bg-surface-4 transition-colors text-text-muted text-xs"
          title="Search (⌘K)"
        >
          {Icons.search}
          <span className="flex-1 text-left">Search tickets, messages, name, email…</span>
          <kbd className="text-[10px] bg-surface-4 px-1.5 py-0.5 rounded text-text-muted font-mono">⌘K</kbd>
        </button>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onNotificationsOpen}
          className="w-8 h-8 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-4 transition-colors relative"
          title="Notifications"
        >
          {Icons.bell}
          {unreadNotifCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-brand text-white text-[9px] font-bold leading-none">
              {unreadNotifCount > 99 ? '99+' : unreadNotifCount}
            </span>
          )}
        </button>
        <AgentStateToggle status={myStatus} activeChats={activeChats} onChange={onStatusChange} />
      </div>
    </div>
  );
}

// ── Global Search Modal ───────────────────────────────────────────────────────

function SearchModal({ onClose, onSelectTicket }: { onClose: () => void; onSelectTicket: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Debounced search
  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const raw = await api.getTickets('all', query.trim());
        const tickets: Ticket[] = Array.isArray(raw) ? raw : (raw as { tickets: Ticket[] }).tickets ?? [];
        setResults(tickets);
        setActiveIdx(0);
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && results[activeIdx]) { onSelectTicket(results[activeIdx].id); onClose(); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center pt-24 animate-fade-in" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-surface-3 ring-1 ring-surface-5 rounded-xl shadow-modal overflow-hidden animate-scale-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-5">
          {Icons.search}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search tickets, messages, name, email…"
            className="flex-1 bg-transparent text-text-primary text-sm outline-none placeholder:text-text-muted"
          />
          <kbd className="text-[10px] text-text-muted bg-surface-4 px-2 py-1 rounded font-mono">ESC</kbd>
        </div>

        {/* Results */}
        {!query.trim() ? (
          <div className="p-4 text-text-muted text-xs text-center">
            Search tickets, messages, customer name, email, or UID
          </div>
        ) : loading ? (
          <div className="p-4 text-text-muted text-xs text-center">Searching…</div>
        ) : results.length === 0 ? (
          <div className="p-4 text-text-muted text-xs text-center">No results for "{query}"</div>
        ) : (
          <ul className="max-h-80 overflow-y-auto py-1">
            {results.map((t, i) => (
              <li key={t.id}>
                <button
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-4 transition-colors ${i === activeIdx ? 'bg-surface-4' : ''}`}
                  onClick={() => { onSelectTicket(t.id); onClose(); }}
                  onMouseEnter={() => setActiveIdx(i)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-text-muted truncate">{t.id.slice(0, 8)}</span>
                      <span className="text-xs font-medium text-text-primary truncate">{t.customer?.name || '—'}</span>
                    </div>
                    <div className="text-xs text-text-muted truncate mt-0.5">
                      {t.customer?.email && <span className="mr-2">{t.customer.email}</span>}
                      {t.customer?.user_id && t.customer.user_id !== t.customer.id && <span className="text-text-muted/60">{t.customer.user_id}</span>}
                    </div>
                  </div>
                  <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ${
                    t.status === 'Open_Live' ? 'bg-accent-green/10 text-accent-green' :
                    t.status === 'In_Progress' ? 'bg-accent-blue/10 text-accent-blue' :
                    t.status === 'Escalated' ? 'bg-brand/10 text-brand' :
                    'bg-surface-5 text-text-muted'
                  }`}>{t.status.replace('_', ' ')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Workspace (3-panel) ───────────────────────────────────────────────────────

interface WorkspaceProps {
  ws: WebSocket | null;
  tickets: Ticket[];
  ticketStats: { open: number; active: number; escalated: number };
  selectedId: string | null;
  view: InboxView;
  search: string;
  statusFilter: StatusFilter;
  onSelect: (id: string) => void;
  onViewChange: (v: InboxView) => void;
  onSearchChange: (s: string) => void;
  onStatusFilterChange: (f: StatusFilter) => void;
  onRefresh: () => void;
}

function Workspace({ ws, tickets, ticketStats, selectedId, view, search, statusFilter, onSelect, onViewChange, onSearchChange, onStatusFilterChange, onRefresh }: WorkspaceProps) {
  const selectedTicket = tickets.find(t => t.id === selectedId) ?? null;
  const [pendingDraft, setPendingDraft] = useState<string | null>(null);
  const [composeReply, setComposeReply] = useState('');

  // Reset compose reply when ticket changes
  useEffect(() => { setComposeReply(''); }, [selectedId]);

  return (
    <div className="flex flex-1 overflow-hidden">
      <ConversationList
        tickets={tickets} ticketStats={ticketStats} selectedId={selectedId} view={view} search={search}
        statusFilter={statusFilter}
        onSelect={onSelect} onViewChange={onViewChange}
        onSearchChange={onSearchChange} onStatusFilterChange={onStatusFilterChange} onRefresh={onRefresh}
      />
      <div className="flex-1 overflow-hidden">
        {selectedId
          ? <MessageThread
              ticketId={selectedId}
              ws={ws}
              onStatusChange={onRefresh}
              pendingDraft={pendingDraft}
              onDraftConsumed={() => setPendingDraft(null)}
              onReplyChange={setComposeReply}
            />
          : (
            <div className="flex flex-col items-center justify-center h-full bg-surface-0 gap-4">
              <div className="w-12 h-12 rounded-full bg-surface-3 ring-1 ring-surface-5 flex items-center justify-center">
                {Icons.inbox}
              </div>
              <div className="text-center">
                <p className="text-text-primary text-sm font-medium">Select a conversation</p>
                <p className="text-text-muted text-xs mt-1">Choose a ticket from the list to start</p>
              </div>
            </div>
          )
        }
      </div>
      {selectedTicket && (
        <PropertiesPanel
          ticket={selectedTicket}
          onUpdate={onRefresh}
          partialDraft={composeReply}
          onAcceptDraft={(text) => setPendingDraft(text)}
          onSelectTicket={onSelect}
        />
      )}
    </div>
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(getAuthUser);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar_collapsed') === 'true');
  const [theme, setTheme] = useState<'dark' | 'light'>(getTheme);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketStats, setTicketStats] = useState({ open: 0, active: 0, escalated: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(() => sessionStorage.getItem('selectedId'));
  const [view, setView] = useState<InboxView>(() => (sessionStorage.getItem('inboxView') as InboxView) ?? 'all_open');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => (sessionStorage.getItem('inboxStatusFilter') as StatusFilter) ?? 'all');
  const [search, setSearch] = useState(() => sessionStorage.getItem('inboxSearch') ?? '');
  const [myStatus, setMyStatus] = useState<AgentStatus>('Available');
  const [activeChats, setActiveChats] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [notifPanelOpen, setNotifPanelOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const [wsSocket, setWsSocket] = useState<WebSocket | null>(null);
  const loadTicketsRef = useRef<() => void>(() => {});

  // Load real agent status from DB on mount
  useEffect(() => {
    if (!user) return;
    api.getAgents().then(agents => {
      const me = agents.find(a => a.id === user?.id);
      if (me) setMyStatus((me.state ?? me.status ?? 'Available') as AgentStatus);
    }).catch(() => {});
  }, []);

  // Load notifications on mount
  useEffect(() => {
    if (!user) return;
    api.getNotifications().then(setNotifications).catch(() => {});
  }, [user]);

  // Handle token expiry without a hard browser reload
  useEffect(() => {
    const handler = () => { setAuthUser(null); setUser(null); sessionStorage.clear(); };
    window.addEventListener('auth:expired', handler);
    return () => window.removeEventListener('auth:expired', handler);
  }, []);

  // Apply theme on mount and change
  useEffect(() => { applyTheme(theme); }, [theme]);

  // Cmd+K global shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const loadTickets = async () => {
    try {
      const raw = await api.getTickets(search ? 'all' : view, search, statusFilter);
      // Backend wraps the list: { tickets: [...] } — unwrap if needed
      const data: Ticket[] = Array.isArray(raw) ? raw : (raw as { tickets: Ticket[] }).tickets ?? [];
      setTickets(data);
      if (!selectedId && data.length > 0) handleSelect(data[0].id);
    } catch { /* backend stub — silent */ }
    // Load stats independently so a failure doesn't block the ticket list
    try {
      const stats = await api.getTicketStats();
      setTicketStats({ open: stats.open, active: stats.active, escalated: stats.escalated });
    } catch { /* stats endpoint may not be available — use defaults */ }
  };
  loadTicketsRef.current = loadTickets;

  useEffect(() => { if (user) loadTickets(); }, [view, search, statusFilter, user]);

  useEffect(() => {
    if (!user) return;
    const connect = () => {
      const ws = createWS((event) => {
        const e = event as WSEvent;

        if (e.type === 'new_ticket') {
          // Prepend the new ticket to the top of the inbox without a full reload
          setTickets(prev => {
            if (prev.some(t => t.id === e.ticket.id)) return prev;
            return [e.ticket as import('./types').Ticket, ...prev];
          });
          return;
        }

        if (e.type === 'new_message') {
          // Patch the ticket's last_message and updated_at in place — no API call
          setTickets(prev => prev.map(t => {
            if (t.id !== e.conversation_id) return t;
            return {
              ...t,
              last_message: e.message.content,
              last_message_at: e.message.created_at,
              updated_at: e.message.created_at,
            };
          }));
          return;
        }

        if (e.type === 'status_change') {
          // Patch status in state; if the ticket disappears from current view, full reload will clean it up
          setTickets(prev => prev.map(t =>
            t.id === e.conversation_id ? { ...t, status: e.status } : t,
          ));
          return;
        }

        if (e.type === 'ticket_assigned') {
          setTickets(prev => prev.map(t =>
            t.id === e.conversation_id
              ? { ...t, assigned_agent_id: e.agent_id ?? null, assigned_agent_name: e.agent_name ?? null }
              : t,
          ));
          return;
        }

        if (e.type === 'notification:new') {
          const n = e.notification;
          setNotifications(prev => [n, ...prev]);
          // Play alert sound for all new notifications
          try {
            const ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            // Short two-tone chime: higher pitch for critical/high
            const freq = (n.priority === 'critical' || n.priority === 'high') ? 880 : 660;
            osc.frequency.setValueAtTime(freq, ctx.currentTime);
            osc.frequency.setValueAtTime(freq * 1.25, ctx.currentTime + 0.08);
            gain.gain.setValueAtTime(0.18, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.35);
            osc.onended = () => ctx.close();
          } catch { /* AudioContext blocked (e.g. no user gesture yet) — silent */ }
          if (n.priority === 'critical' || n.priority === 'high') {
            setToasts(prev => {
              // Prepend new toast; deduplicate by id; keep newest 5 (drop oldest)
              const next = [{ id: n.id, notification: n }, ...prev.filter(t => t.id !== n.id)];
              return next.slice(0, 5);
            });
          }
          return;
        }
      });
      ws.onclose = () => { setWsSocket(null); setTimeout(connect, 3000); };
      wsRef.current = ws;
      setWsSocket(ws);
    };
    connect();

    // 30-second polling fallback — use ref so interval always calls the latest loadTickets
    // (which closes over the current selectedId, preventing stale-closure jump to first ticket)
    const pollInterval = setInterval(() => { loadTicketsRef.current(); }, 30_000);

    return () => {
      wsRef.current?.close();
      clearInterval(pollInterval);
    };
  }, [user]);

  useEffect(() => {
    setActiveChats(tickets.filter(t => t.status === 'Open_Live' || t.status === 'In_Progress').length);
  }, [tickets]);

  const handleStatusChange = async (s: AgentStatus) => {
    setMyStatus(s);
    try { await api.setMyStatus(s); } catch { /* silent */ }
  };

  const handleToggleSidebar = () => {
    setCollapsed(c => {
      const next = !c;
      localStorage.setItem('sidebar_collapsed', String(next));
      return next;
    });
  };

  const handleThemeToggle = () => {
    setTheme(t => t === 'dark' ? 'light' : 'dark');
  };

  const navigate = useNavigate();
  const handleSelect = (id: string) => { sessionStorage.setItem('selectedId', id); setSelectedId(id); };
  const handleSelectAndNavigate = (id: string) => { handleSelect(id); navigate('/inbox'); };
  const handleViewChange = (v: InboxView) => { sessionStorage.setItem('inboxView', v); setView(v); };
  const handleStatusFilterChange = (f: StatusFilter) => { sessionStorage.setItem('inboxStatusFilter', f); setStatusFilter(f); };
  const handleNavigateInbox = (v: InboxView, f: StatusFilter) => { handleViewChange(v); handleStatusFilterChange(f); navigate('/inbox'); };
  const handleSearchChange = (s: string) => { sessionStorage.setItem('inboxSearch', s); setSearch(s); };
  const handleLogin = (u: AuthUser) => { setAuthUser(u); setUser(u); };
  const handleLogout = () => { setAuthUser(null); setUser(null); sessionStorage.clear(); };

  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage onLogin={handleLogin} />} />
      </Routes>
    );
  }

  return (
    <PermissionProvider value={user.permissions ?? []}>
      <div className="flex h-screen bg-surface-0 overflow-hidden">
        {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} onSelectTicket={id => { handleSelectAndNavigate(id); setSearchOpen(false); }} />}

        {notifPanelOpen && (
          <NotificationPanel
            notifications={notifications}
            onClose={() => setNotifPanelOpen(false)}
            onMarkRead={(id) => setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n))}
            onMarkUnread={(id) => setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: false } : n))}
            onMarkAllRead={() => setNotifications(prev => prev.map(n => ({ ...n, read: true })))}
            onBulkMark={(ids, read) => setNotifications(prev => prev.map(n => ids.includes(n.id) ? { ...n, read } : n))}
            onOpenTicket={handleSelectAndNavigate}
          />
        )}

        <ToastContainer
          toasts={toasts}
          onDismiss={(id) => setToasts(prev => prev.filter(t => t.id !== id))}
          onOpenTicket={handleSelectAndNavigate}
        />

        <Sidebar
          user={user}
          collapsed={collapsed}
          onToggle={handleToggleSidebar}
          onLogout={handleLogout}
          theme={theme}
          onThemeToggle={handleThemeToggle}
        />

        <div className="flex flex-col flex-1 overflow-hidden">
          <TopBar
            myStatus={myStatus}
            activeChats={activeChats}
            onStatusChange={handleStatusChange}
            onSearchOpen={() => setSearchOpen(true)}
            unreadNotifCount={notifications.filter(n => !n.read).length}
            onNotificationsOpen={() => setNotifPanelOpen(p => !p)}
          />

          <div className="flex flex-1 overflow-hidden">
            <Routes>
              <Route path="/" element={
                <HomeDashboard onSelectTicket={handleSelect} onNavigateInbox={handleNavigateInbox} />
              } />
              <Route path="/inbox" element={
                <Workspace
                  ws={wsSocket}
                  tickets={tickets} ticketStats={ticketStats} selectedId={selectedId} view={view} search={search}
                  statusFilter={statusFilter}
                  onSelect={handleSelect} onViewChange={handleViewChange}
                  onSearchChange={handleSearchChange} onStatusFilterChange={handleStatusFilterChange} onRefresh={loadTickets}
                />
              } />
              <Route path="/supervisor" element={
                <PermissionGuard permission="section.supervisor" user={user}>
                  <SupervisorDashboard />
                </PermissionGuard>
              } />
              <Route path="/analytics" element={
                <PermissionGuard permission="section.analytics" user={user}>
                  <AnalyticsDashboard />
                </PermissionGuard>
              } />
              <Route path="/admin" element={
                <PermissionGuard permission="section.admin" user={user}>
                  <AdminSettings currentUser={user} />
                </PermissionGuard>
              } />
              <Route path="/admin/:tab" element={
                <PermissionGuard permission="section.admin" user={user}>
                  <AdminSettings currentUser={user} />
                </PermissionGuard>
              } />
              <Route path="/studio" element={
                <PermissionGuard permission="section.studio" user={user}>
                  <AIStudio />
                </PermissionGuard>
              } />
              <Route path="/metrics" element={
                <PermissionGuard permission="section.metrics" user={user}>
                  <MetricsDashboard />
                </PermissionGuard>
              } />
              <Route path="/insights" element={
                <PermissionGuard permission="section.analytics" user={user}>
                  <InsightsDashboard />
                </PermissionGuard>
              } />
              <Route path="/knowledge" element={
                <PermissionGuard permission="section.knowledge" user={user}>
                  <KnowledgeBase currentUser={user} />
                </PermissionGuard>
              } />
              <Route path="/users" element={
                <PermissionGuard permission="section.users" user={user}>
                  <User360 />
                </PermissionGuard>
              } />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </div>
      </div>
    </PermissionProvider>
  );
}
