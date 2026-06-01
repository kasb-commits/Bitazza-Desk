import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Agent, AgentRole, NotificationChannelConfig, PropertyDefinition, PropertyOption, PropertyFieldType } from '../types';
import type { AuthUser } from '../App';
import { api } from '../api';
import { Avatar } from './ui/Avatar';
import { Spinner } from './ui/Spinner';
import { useToast } from './ui/Toast';

// ── Design tokens ─────────────────────────────────────────────────────────────
const BR   = '#6366f1';
const T1   = '#1a1d2e';
const T2   = '#4b5563';
const TM   = '#9ca3af';
const SEP  = 'rgba(0,0,0,0.06)';

const TABS = ['Agents', 'Roles', 'Tags', 'Ticket Properties', 'Canned Responses', 'Assignment Rules', 'SLA Targets', 'Bot Config', 'Announcements', 'Report Settings'] as const;
type Tab = typeof TABS[number];

const TAB_SLUG: Record<Tab, string> = {
  'Agents':            'agents',
  'Roles':             'roles',
  'Tags':              'tags',
  'Ticket Properties': 'ticket-properties',
  'Canned Responses':  'canned-responses',
  'Assignment Rules':  'assignment-rules',
  'SLA Targets':       'sla-targets',
  'Bot Config':        'bot-config',
  'Announcements':     'announcements',
  'Report Settings':   'report-settings',
};
const SLUG_TAB: Record<string, Tab> = Object.fromEntries(
  Object.entries(TAB_SLUG).map(([tab, slug]) => [slug, tab as Tab])
);

const TAB_ICONS: Record<Tab, string> = {
  'Agents':            'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z',
  'Roles':             'M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z',
  'Tags':              'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z',
  'Ticket Properties': 'M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75',
  'Canned Responses':  'M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z',
  'Assignment Rules':  'M4 6h16M4 10h16M4 14h16M4 18h16',
  'SLA Targets':       'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  'Bot Config':        'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17H4a2 2 0 01-2-2V5a2 2 0 012-2h16a2 2 0 012 2v10a2 2 0 01-2 2h-1',
  'Announcements':     'M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z',
  'Report Settings':   'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
};

interface Props { currentUser: AuthUser; }

const TAB_DESCRIPTIONS: Record<Tab, string> = {
  'Agents':            'Manage agent accounts, roles, and capacity.',
  'Roles':             'Configure role permissions for dashboard access.',
  'Tags':              'Manage global ticket tags available to all agents.',
  'Ticket Properties': 'Define dynamic properties for ticket classification and routing.',
  'Canned Responses':  'Pre-written replies for common customer scenarios.',
  'Assignment Rules':  'Configure routing logic per channel and category.',
  'SLA Targets':       'Set response and resolution time targets per priority tier.',
  'Bot Config':        'Configure bot persona, greeting, and fallback behavior.',
  'Announcements':     'Publish banners shown to widget users before they pick a category.',
  'Report Settings':   'Configure daily and weekly report delivery channels.',
};

const ADMIN_GROUPS: { label: string; desc: string; color: string; icon: string; items: Tab[] }[] = [
  {
    label: 'Team',
    desc:  'Manage the people and permissions that power your support operation.',
    color: '#6366f1',
    icon:  'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
    items: ['Agents', 'Roles', 'Tags'],
  },
  {
    label: 'Automation',
    desc:  'Define how tickets are routed, prioritized, and escalated across your team.',
    color: '#0ea5e9',
    icon:  'M13 10V3L4 14h7v7l9-11h-7z',
    items: ['Assignment Rules', 'SLA Targets'],
  },
  {
    label: 'Content',
    desc:  'Build and maintain the templates and data structures your agents rely on.',
    color: '#10b981',
    icon:  'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    items: ['Canned Responses', 'Ticket Properties'],
  },
  {
    label: 'Platform',
    desc:  'Configure the AI bot behaviour and report delivery channels.',
    color: '#f59e0b',
    icon:  'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17H4a2 2 0 01-2-2V5a2 2 0 012-2h16a2 2 0 012 2v10a2 2 0 01-2 2h-1',
    items: ['Bot Config', 'Announcements', 'Report Settings'],
  },
];

export default function AdminSettings({ currentUser }: Props) {
  const { tab: tabSlug } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const tab: Tab | null = (tabSlug && SLUG_TAB[tabSlug]) ? SLUG_TAB[tabSlug] : null;

  // ── Overview (no tab selected) ───────────────────────────────────────────────
  if (!tab) {
    return (
      <div className="flex-1 overflow-y-auto" style={{ background: '#f4f5f9' }}>

        {/* Hero banner */}
        <div className="relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #6366f1 0%, #818cf8 60%, #a5b4fc 100%)' }}>
          {/* Decorative circles */}
          <div className="absolute -top-16 -right-16 w-64 h-64 rounded-full opacity-20" style={{ background: 'white' }} />
          <div className="absolute -bottom-10 right-48 w-40 h-40 rounded-full opacity-10" style={{ background: 'white' }} />
          <div className="px-8 py-8 flex items-center justify-between relative z-10">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: 'rgba(255,255,255,0.55)' }}>
                Bitazza CS · Workspace
              </p>
              <h1 className="text-xl font-bold text-white mb-1">Admin Settings</h1>
              <p className="text-xs" style={{ color: 'rgba(255,255,255,0.65)' }}>
                Configure your team, automation, content, and platform.
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div className="text-right">
                <p className="text-sm font-semibold text-white">{currentUser.name ?? currentUser.email}</p>
                <p className="text-xs capitalize" style={{ color: 'rgba(255,255,255,0.6)' }}>{currentUser.role}</p>
              </div>
              <Avatar name={currentUser.name ?? currentUser.email} size="md" />
            </div>
          </div>
        </div>

        {/* Setting groups — two-column: context left, rows right */}
        <div className="px-8 py-7 space-y-4">
          {ADMIN_GROUPS.map(group => (
            <div key={group.label} className="grid gap-4" style={{ gridTemplateColumns: '260px 1fr' }}>

              {/* Left: group context panel */}
              <div className="rounded-2xl p-6 flex flex-col justify-between"
                   style={{ background: `linear-gradient(145deg, ${group.color}14 0%, ${group.color}06 100%)`, border: `1px solid ${group.color}22` }}>
                <div>
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
                       style={{ background: group.color }}>
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d={group.icon} />
                    </svg>
                  </div>
                  <p className="text-sm font-bold mb-1.5" style={{ color: T1 }}>{group.label}</p>
                  <p className="text-xs leading-relaxed" style={{ color: T2 }}>{group.desc}</p>
                </div>
                <p className="text-[10px] font-semibold uppercase tracking-widest mt-5"
                   style={{ color: `${group.color}99` }}>
                  {group.items.length} {group.items.length === 1 ? 'section' : 'sections'}
                </p>
              </div>

              {/* Right: setting rows */}
              <div className="rounded-2xl overflow-hidden bg-white flex flex-col"
                   style={{ border: `1px solid ${SEP}`, boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
                {group.items.map((t, i) => (
                  <button
                    key={t}
                    onClick={() => navigate(`/admin/${TAB_SLUG[t]}`)}
                    className="group flex-1 flex items-center gap-4 px-6 py-4 text-left transition-colors hover:bg-[#f9fafb]"
                    style={i > 0 ? { borderTop: `1px solid ${SEP}` } : {}}
                  >
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                         style={{ background: `${group.color}12` }}>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                           style={{ color: group.color }}>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d={TAB_ICONS[t]} />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold" style={{ color: T1 }}>{t}</p>
                      <p className="text-xs mt-0.5" style={{ color: TM }}>{TAB_DESCRIPTIONS[t]}</p>
                    </div>
                    <svg className="w-4 h-4 shrink-0 transition-transform group-hover:translate-x-0.5"
                         fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: TM }}>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                ))}
              </div>

            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Section view ─────────────────────────────────────────────────────────────
  const groupColor = ADMIN_GROUPS.find(g => g.items.includes(tab))?.color ?? BR;

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: '#f4f5f9' }}>

      {/* Breadcrumb bar */}
      <div className="sticky top-0 z-10 px-8 py-3 flex items-center gap-2"
           style={{ background: 'rgba(244,245,249,0.9)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', borderBottom: `1px solid ${SEP}` }}>
        <button
          onClick={() => navigate('/admin')}
          className="flex items-center gap-1.5 text-xs transition-opacity hover:opacity-70"
          style={{ color: T2 }}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Admin
        </button>
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: TM }}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-xs font-medium" style={{ color: T1 }}>{tab}</span>
      </div>

      {/* Section header */}
      <div className="px-8 pt-7 pb-5 flex items-center gap-4">
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0"
             style={{ background: `${groupColor}18` }}>
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"
               style={{ color: groupColor }}>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d={TAB_ICONS[tab]} />
          </svg>
        </div>
        <div>
          <h1 className="text-xl font-bold" style={{ color: T1 }}>{tab}</h1>
          <p className="text-sm mt-0.5" style={{ color: TM }}>{TAB_DESCRIPTIONS[tab]}</p>
        </div>
      </div>

      {/* Tab content — full width */}
      <div className="px-8 pb-8">
        {tab === 'Agents'            && <AgentsTab currentUser={currentUser} />}
        {tab === 'Roles'             && <RolesTab currentUser={currentUser} />}
        {tab === 'Tags'              && <TagsTab />}
        {tab === 'Ticket Properties' && <TicketPropertiesTab />}
        {tab === 'Canned Responses'  && <CannedResponsesTab />}
        {tab === 'Assignment Rules'  && <AssignmentRulesTab />}
        {tab === 'SLA Targets'       && <StubTab label="SLA Targets" description="Set SLA response and resolution time targets per tier: VIP 1 min · EA 3 min · Standard 10 min." />}
        {tab === 'Bot Config'        && <StubTab label="Bot Config" description="Configure bot persona, greeting, fallback message, and business hours. Use Workflow Studio for flow editing." />}
        {tab === 'Announcements'     && <AnnouncementsTab />}
        {tab === 'Report Settings'   && <NotificationsTab />}
      </div>
    </div>
  );
}

// ── Role ceiling helper ───────────────────────────────────────────────────────

function getAllowedRoles(_callerRole: string, allRoles: AgentRole[]): AgentRole[] {
  return allRoles.filter(r => r.name !== 'super_admin');
}

// ── Agents tab ────────────────────────────────────────────────────────────────

function AgentsTab({ currentUser }: { currentUser: AuthUser }) {
  const [agents, setAgents]             = useState<Agent[]>([]);
  const [roles, setRoles]               = useState<AgentRole[]>([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [showAdd, setShowAdd]           = useState(false);
  const [editAgent, setEditAgent]       = useState<Agent | null>(null);
  const [resetAgent, setResetAgent]     = useState<Agent | null>(null);
  const [avatarAgent, setAvatarAgent]   = useState<Agent | null>(null);

  const load = async (inactive = showInactive) => {
    try {
      const [agentData, roleData] = await Promise.all([
        api.getAgents(inactive),
        api.getRoles(),
      ]);
      setAgents(agentData);
      setRoles(roleData.roles ?? roleData);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggleInactive = () => { const next = !showInactive; setShowInactive(next); load(next); };

  const handleDeactivate = async (a: Agent) => {
    if (!confirm(`Deactivate ${a.name}?`)) return;
    try { await api.deactivateAgent(a.id); load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
  };

  const handleReactivate = async (a: Agent) => {
    try { await api.reactivateAgent(a.id); load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
  };

  if (loading) return (
    <div className="flex items-center gap-2" style={{ fontSize: 13, color: TM }}>
      <Spinner size="sm" /> Loading agents…
    </div>
  );

  // ── Derived stats ────────────────────────────────────────────────────────────
  const onlineCount = agents.filter(a => a.active !== false && (a.state ?? a.status) === 'Available').length;
  const busyCount   = agents.filter(a => a.active !== false && (a.state ?? a.status) === 'Busy').length;
  const uniqueRoles = [...new Set(agents.filter(a => a.active !== false).map(a => a.role).filter(Boolean))].length;

  const ROLE_COLORS: Record<string, string> = {
    super_admin: '#8b5cf6', admin: BR, supervisor: '#0ea5e9', agent: '#10b981',
  };
  const getRoleColor = (role: string) => ROLE_COLORS[role] ?? BR;

  return (
    <div className="space-y-6">
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* Stats strip */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        {([
          { label: 'Total Agents', value: agents.length,  icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z', color: BR },
          { label: 'Available',    value: onlineCount,     icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',  color: '#10b981' },
          { label: 'Busy',         value: busyCount,       icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',   color: '#f59e0b' },
          { label: 'Roles',        value: uniqueRoles,     icon: 'M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z', color: '#0ea5e9' },
        ] as { label: string; value: number; icon: string; color: string }[]).map(s => (
          <div key={s.label} className="rounded-2xl bg-white flex items-center gap-4 px-5 py-4"
               style={{ border: `1px solid ${SEP}`, boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${s.color}14` }}>
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: s.color, width: 18, height: 18 }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d={s.icon} />
              </svg>
            </div>
            <div>
              <p style={{ fontSize: 22, fontWeight: 700, color: T1, lineHeight: 1 }}>{s.value}</p>
              <p style={{ fontSize: 11, color: TM, marginTop: 3 }}>{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2.5 cursor-pointer select-none">
          <div onClick={toggleInactive} className="relative cursor-pointer shrink-0"
               style={{ width: 32, height: 18, borderRadius: 9, background: showInactive ? BR : '#d1d5db', transition: 'background 0.2s' }}>
            <div style={{ position: 'absolute', top: 2, left: showInactive ? 14 : 2, width: 14, height: 14, borderRadius: '50%', background: 'white', boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'left 0.15s' }} />
          </div>
          <span style={{ fontSize: 12, color: T2 }}>Show inactive agents</span>
        </label>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5"
          style={{ fontSize: 12, fontWeight: 600, padding: '7px 16px', background: BR, color: 'white', borderRadius: 10, border: 'none', cursor: 'pointer' }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
          onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
          </svg>
          Add Agent
        </button>
      </div>

      {/* Agent card grid */}
      {agents.length === 0 ? (
        <div className="rounded-2xl bg-white flex flex-col items-center justify-center py-16"
             style={{ border: `1px solid ${SEP}` }}>
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ width: 40, height: 40, color: TM, opacity: 0.3, marginBottom: 12 }}>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <p style={{ fontSize: 13, color: TM }}>No agents found</p>
        </div>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {agents.map(a => {
            const state      = a.state ?? a.status ?? 'Offline';
            const active     = a.active_chats ?? a.active_conversation_count ?? 0;
            const max        = a.max_chats ?? a.max_capacity ?? 3;
            const isInactive = a.active === false;
            const stateColor = state === 'Available' ? '#10b981' : state === 'Offline' ? '#9ca3af' : '#f59e0b';
            const rc         = getRoleColor(a.role ?? '');
            const utilPct    = Math.min(100, Math.round((active / Math.max(1, max)) * 100));

            return (
              <div key={a.id} className="rounded-2xl bg-white flex flex-col overflow-hidden"
                   style={{ border: `1px solid ${SEP}`, boxShadow: '0 1px 6px rgba(0,0,0,0.05)', opacity: isInactive ? 0.55 : 1 }}>

                {/* Top — gradient band with avatar */}
                <div className="relative flex flex-col items-center pb-4 pt-5"
                     style={{ background: `linear-gradient(145deg, ${rc}18 0%, ${rc}08 100%)`, borderBottom: `1px solid ${rc}18` }}>
                  {isInactive && (
                    <span className="absolute top-3 right-3"
                          style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', background: `${BR}15`, color: BR, padding: '2px 7px', borderRadius: 20 }}>
                      INACTIVE
                    </span>
                  )}
                  <button onClick={() => setAvatarAgent(a)} className="relative group mb-3" title="Change avatar"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                    <Avatar name={a.name} size="lg" src={a.avatar_url ?? undefined} />
                    <span className="absolute inset-0 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                          style={{ background: 'rgba(0,0,0,0.45)' }}>
                      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ width: 16, height: 16, color: 'white' }}>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </span>
                  </button>
                  <p style={{ fontSize: 14, fontWeight: 700, color: T1, textAlign: 'center' }}>{a.name}</p>
                  <span className="mt-1.5"
                        style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'capitalize', background: `${rc}18`, color: rc, padding: '3px 10px', borderRadius: 20 }}>
                    {a.role ?? 'agent'}
                  </span>
                </div>

                {/* Body */}
                <div className="flex flex-col gap-3 px-4 py-4 flex-1">
                  {/* Status + email */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <div style={{ width: 7, height: 7, borderRadius: '50%', background: stateColor, flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: T2 }}>{state}</span>
                    </div>
                    <span style={{ fontSize: 11, color: TM, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.email?.split('@')[0] ?? '—'}
                    </span>
                  </div>

                  {/* Capacity bar */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span style={{ fontSize: 10, color: TM }}>Chat capacity</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: T2 }}>{active} / {max}</span>
                    </div>
                    <div style={{ height: 4, borderRadius: 4, background: '#f0f0f0', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${utilPct}%`, borderRadius: 4, background: utilPct > 80 ? '#ef4444' : utilPct > 50 ? '#f59e0b' : '#10b981', transition: 'width 0.4s' }} />
                    </div>
                  </div>

                  {/* Skills */}
                  {(a.skills ?? []).length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {(a.skills ?? []).map(s => (
                        <span key={s} style={{ fontSize: 10, background: '#f3f4f6', color: TM, padding: '2px 7px', borderRadius: 5 }}>{s}</span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Action footer */}
                <div className="flex" style={{ borderTop: `1px solid ${SEP}` }}>
                  {([
                    { label: 'Edit',      color: BR,        fn: () => setEditAgent(a) },
                    { label: 'Reset PW',  color: TM,        fn: () => setResetAgent(a) },
                    isInactive
                      ? { label: 'Reactivate', color: '#10b981', fn: () => handleReactivate(a) }
                      : { label: 'Deactivate', color: '#ef4444', fn: () => handleDeactivate(a) },
                  ] as { label: string; color: string; fn: () => void }[]).map((action, i, arr) => (
                    <button key={action.label} onClick={action.fn}
                      className="flex-1 py-2.5"
                      style={{ fontSize: 11, fontWeight: 600, color: action.color, background: 'none', border: 'none', cursor: 'pointer', borderRight: i < arr.length - 1 ? `1px solid ${SEP}` : 'none', transition: 'background 0.12s' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                      {action.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAdd    && <AgentModal roles={getAllowedRoles(currentUser.role, roles)} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} />}
      {editAgent  && <AgentModal agent={editAgent} roles={getAllowedRoles(currentUser.role, roles)} onClose={() => setEditAgent(null)} onSaved={() => { setEditAgent(null); load(); }} />}
      {resetAgent && <ResetPasswordModal agent={resetAgent} onClose={() => setResetAgent(null)} onSaved={() => setResetAgent(null)} />}
      {avatarAgent && (
        <AvatarModal
          agent={avatarAgent}
          currentUserId={currentUser.id}
          currentUserRole={currentUser.role}
          onClose={() => setAvatarAgent(null)}
          onSaved={(url) => { setAgents(prev => prev.map(a => a.id === avatarAgent.id ? { ...a, avatar_url: url } : a)); setAvatarAgent(null); }}
        />
      )}
    </div>
  );
}

// ── Add / Edit Agent modal ────────────────────────────────────────────────────

function AgentModal({ agent, roles, onClose, onSaved }: { agent?: Agent; roles: AgentRole[]; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!agent;
  const [form, setForm] = useState({
    name:      agent?.name ?? '',
    email:     agent?.email ?? '',
    password:  '',
    role:      agent?.role ?? (roles[0]?.name ?? 'agent'),
    team:      (agent as Agent & { team?: string })?.team ?? 'cs',
    max_chats: String(agent?.max_chats ?? agent?.max_capacity ?? 3),
    skills:    (agent?.skills ?? []).join(', '),
    shift:     agent?.shift ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const save = async () => {
    if (!form.name.trim()) { setError('Name is required'); return; }
    if (!isEdit && !form.email.trim()) { setError('Email is required'); return; }
    if (!isEdit && form.password.length < 8) { setError('Password must be at least 8 characters'); return; }
    setSaving(true); setError('');
    try {
      const skillsArr = form.skills.split(',').map(s => s.trim()).filter(Boolean);
      if (isEdit) {
        await api.updateAgent(agent!.id, { name: form.name.trim(), role: form.role, team: form.team, max_chats: parseInt(form.max_chats), skills: skillsArr, shift: form.shift || undefined });
      } else {
        await api.createAgent({ name: form.name.trim(), email: form.email.trim().toLowerCase(), password: form.password, role: form.role, team: form.team, max_chats: parseInt(form.max_chats), skills: skillsArr, shift: form.shift || undefined });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally { setSaving(false); }
  };

  return (
    <ModalShell title={isEdit ? 'Edit Agent' : 'Add Agent'} onClose={onClose} width="w-[480px]">
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <Field label="Name *">
        <AdminInput value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="Jane Smith" />
      </Field>
      {!isEdit && (
        <>
          <Field label="Email *">
            <AdminInput type="email" value={form.email} onChange={v => setForm(f => ({ ...f, email: v }))} placeholder="jane@bitazza.com" />
          </Field>
          <Field label="Temporary Password *">
            <AdminInput type="password" value={form.password} onChange={v => setForm(f => ({ ...f, password: v }))} placeholder="Min 8 characters" />
          </Field>
        </>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Role *">
          <AdminSelect value={form.role} onChange={v => setForm(f => ({ ...f, role: v }))} options={roles.map(r => ({ value: r.name, label: r.name + (r.is_preset ? '' : ' (custom)') }))} />
        </Field>
        <Field label="Team">
          <AdminInput value={form.team} onChange={v => setForm(f => ({ ...f, team: v }))} placeholder="cs" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Max Chats (1–20)">
          <AdminInput type="number" value={form.max_chats} onChange={v => setForm(f => ({ ...f, max_chats: v }))} />
        </Field>
        <Field label="Shift">
          <AdminInput value={form.shift} onChange={v => setForm(f => ({ ...f, shift: v }))} placeholder="Morning" />
        </Field>
      </div>
      <Field label="Skills (comma-separated)">
        <AdminInput value={form.skills} onChange={v => setForm(f => ({ ...f, skills: v }))} placeholder="thai, english, kyc" />
      </Field>
      <ModalFooter onClose={onClose} onSave={save} saving={saving} saveLabel={isEdit ? 'Save Changes' : 'Create Agent'} />
    </ModalShell>
  );
}

// ── Reset Password modal ──────────────────────────────────────────────────────

function ResetPasswordModal({ agent, onClose, onSaved }: { agent: Agent; onClose: () => void; onSaved: () => void }) {
  const [password, setPassword] = useState('');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  const save = async () => {
    if (password.length < 8) { setError('Min 8 characters'); return; }
    setSaving(true); setError('');
    try { await api.resetAgentPassword(agent.id, password); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title={`Reset Password — ${agent.name}`} onClose={onClose} width="w-80">
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <Field label="New Password *">
        <AdminInput type="password" value={password} onChange={setPassword} placeholder="Min 8 characters" autoFocus />
      </Field>
      <ModalFooter onClose={onClose} onSave={save} saving={saving} saveLabel="Reset Password" />
    </ModalShell>
  );
}

// ── Avatar modal ──────────────────────────────────────────────────────────────

function AvatarModal({
  agent, currentUserId, currentUserRole, onClose, onSaved,
}: { agent: Agent; currentUserId: string; currentUserRole: string; onClose: () => void; onSaved: (url: string) => void }) {
  const isSelf  = agent.id === currentUserId;
  const isAdmin = ['admin', 'super_admin'].includes(currentUserRole);
  if (!isSelf && !isAdmin) { onClose(); return null; }

  const [preview, setPreview] = useState<string | null>(agent.avatar_url ?? null);
  const [file, setFile]       = useState<File | null>(null);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const inputRef              = useRef<HTMLInputElement>(null);

  const handleFile = (f: File) => { setFile(f); setPreview(URL.createObjectURL(f)); };

  const save = async () => {
    if (!file) return;
    setSaving(true); setError('');
    try { const { avatar_url } = await api.uploadAvatar(agent.id, file); onSaved(avatar_url); }
    catch (e) { setError(e instanceof Error ? e.message : 'Upload failed'); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title={`Avatar — ${agent.name}`} onClose={onClose} width="w-72">
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="flex flex-col items-center gap-3 py-2">
        <div
          className="w-20 h-20 rounded-full overflow-hidden ring-2 ring-surface-5 cursor-pointer hover:ring-brand transition-all"
          onClick={() => inputRef.current?.click()}
        >
          {preview
            ? <img src={preview} alt="preview" className="w-full h-full object-cover" />
            : <Avatar name={agent.name} size="lg" />
          }
        </div>
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
        <button onClick={() => inputRef.current?.click()}
          className="text-xs bg-surface-3 ring-1 ring-surface-5 px-4 py-1.5 rounded hover:bg-surface-4 transition-colors text-text-secondary">
          Choose Image
        </button>
        <p className="text-[10px] text-text-muted">JPG, PNG, WebP, GIF · max 2 MB</p>
      </div>
      <ModalFooter onClose={onClose} onSave={save} saving={saving} saveLabel="Save Avatar" disabled={!file} />
    </ModalShell>
  );
}

// ── Roles tab ─────────────────────────────────────────────────────────────────

const PERM_LABELS: Record<string, string> = {
  'section.home':           'Dashboard',
  'section.inbox':          'Inbox',
  'section.supervisor':     'Live Monitor',
  'section.analytics':      'Analytics',
  'section.metrics':        'Metrics',
  'section.studio':         'Workflow Studio',
  'section.admin':          'Admin Panel',
  'section.knowledge':      'Knowledge Base',
  'inbox.reply':            'Reply to Customer',
  'inbox.assign':           'Assign Conversations',
  'inbox.close':            'Close Conversations',
  'inbox.claim':            'Claim Conversations',
  'inbox.escalate':         'Escalate to Human',
  'inbox.internal_note':    'Add Internal Note',
  'inbox.set_priority':     'Set Priority',
  'inbox.set_tags':         'Set Tags',
  'supervisor.whisper':     'Whisper to Agent',
  'supervisor.reassign':    'Reassign Tickets',
  'studio.create':          'Create Workflows',
  'studio.edit':            'Edit & Save Workflows',
  'studio.delete':          'Delete Workflows',
  'studio.test':            'Run Test Simulations',
  'studio.publish':         'Publish / Unpublish Flows',
  'admin.agents':           'Manage Agents',
  'admin.roles':            'Manage Roles',
  'admin.tags':             'Manage Tags',
  'admin.canned_responses': 'Manage Canned Responses',
  'admin.assignment_rules': 'Manage Assignment Rules',
  'admin.sla_targets':      'Manage SLA Targets',
  'admin.bot_config':       'Bot Configuration',
  'admin.report_settings':  'Report Settings',
  'knowledge.read':         'View Knowledge Articles',
  'knowledge.write':        'Add / Edit / Delete Articles',
};

const PERM_GROUPS: { label: string; description: string; perms: string[] }[] = [
  { label: 'Pages',          description: 'Which sections this role can access',        perms: ['section.home','section.inbox','section.supervisor','section.analytics','section.metrics','section.studio','section.admin','section.knowledge'] },
  { label: 'Conversations',  description: 'Actions available inside conversations',     perms: ['inbox.reply','inbox.assign','inbox.close','inbox.claim','inbox.escalate','inbox.internal_note','inbox.set_priority','inbox.set_tags'] },
  { label: 'Supervision',    description: 'Real-time team monitoring tools',            perms: ['supervisor.whisper','supervisor.reassign'] },
  { label: 'Workflow Studio', description: 'Build and deploy automated flows',           perms: ['studio.create','studio.edit','studio.delete','studio.test','studio.publish'] },
  { label: 'Administration', description: 'Workspace configuration and user management', perms: ['admin.agents','admin.roles','admin.tags','admin.canned_responses','admin.assignment_rules','admin.sla_targets','admin.bot_config','admin.report_settings'] },
  { label: 'Knowledge Base', description: 'Access and manage knowledge articles',       perms: ['knowledge.read','knowledge.write'] },
];

function PermChecklist({ available, selected, onChange }: { available: string[]; selected: string[]; onChange: (p: string[]) => void }) {
  const toggle = (p: string) => onChange(selected.includes(p) ? selected.filter(x => x !== p) : [...selected, p]);

  return (
    <div className="space-y-5">
      {PERM_GROUPS.map(g => {
        const visible = g.perms.filter(p => available.includes(p));
        if (!visible.length) return null;
        return (
          <div key={g.label}>
            <div className="mb-2">
              <p style={{ fontSize: 10, fontWeight: 700, color: T2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{g.label}</p>
              <p style={{ fontSize: 10, color: TM, marginTop: 2 }}>{g.description}</p>
            </div>
            <div className="space-y-0.5">
              {visible.map(p => {
                const checked = selected.includes(p);
                return (
                  <label key={p} className="flex items-center gap-3 px-3 py-2 cursor-pointer rounded-lg"
                         style={{ background: checked ? `${BR}0d` : 'transparent', transition: 'background 0.12s' }}
                         onMouseEnter={e => { if (!checked) (e.currentTarget as HTMLLabelElement).style.background = '#f9fafb'; }}
                         onMouseLeave={e => { (e.currentTarget as HTMLLabelElement).style.background = checked ? `${BR}0d` : 'transparent'; }}>
                    <div className="w-4 h-4 rounded flex items-center justify-center shrink-0"
                         style={{ background: checked ? BR : 'white', border: `1.5px solid ${checked ? BR : '#d1d5db'}`, transition: 'all 0.12s' }}>
                      {checked && (
                        <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 10 8" fill="none">
                          <path d="M1 4l3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </div>
                    <input type="checkbox" checked={checked} onChange={() => toggle(p)} className="sr-only" />
                    <span style={{ fontSize: 12, color: checked ? T1 : T2 }}>{PERM_LABELS[p] ?? p}</span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RoleModal({ role, allPermissions, onSave, onClose }: { role?: AgentRole; allPermissions: string[]; onSave: (data: { name: string; display_name: string; permissions: string[] }) => Promise<void>; onClose: () => void }) {
  const [name, setName]           = useState(role?.name ?? '');
  const [displayName, setDisplay] = useState(role?.display_name ?? '');
  const [perms, setPerms]         = useState<string[]>(role?.permissions ?? []);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');

  const save = async () => {
    const n = name.trim().toLowerCase().replace(/\s+/g, '_');
    if (!n) { setError('Role name is required'); return; }
    setSaving(true); setError('');
    try { await onSave({ name: n, display_name: displayName.trim(), permissions: perms }); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title={role ? `Edit role: ${role.name}` : 'Create role'} onClose={onClose} width="w-[440px]">
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <Field label="Role name (snake_case)">
        <AdminInput value={name} onChange={setName} placeholder="e.g. opt_agent" />
      </Field>
      <Field label="Display name (optional)">
        <AdminInput value={displayName} onChange={setDisplay} placeholder="e.g. Operations Agent" />
      </Field>
      <Field label="Permissions">
        <PermChecklist available={allPermissions} selected={perms} onChange={setPerms} />
      </Field>
      <ModalFooter onClose={onClose} onSave={save} saving={saving} saveLabel={role ? 'Save Changes' : 'Create Role'} />
    </ModalShell>
  );
}

function RolesTab({ currentUser: _ }: { currentUser: AuthUser }) {
  const [roles, setRoles]           = useState<AgentRole[]>([]);
  const [allPerms, setAllPerms]     = useState<string[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing]       = useState<AgentRole | null>(null);
  const [expanded, setExpanded]     = useState<string | null>(null);

  const load = async () => {
    try {
      const { roles: r, all_permissions } = await api.getRoles();
      setRoles(r); setAllPerms(all_permissions);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async (data: { name: string; display_name: string; permissions: string[] }) => {
    await api.createRole({ name: data.name, display_name: data.display_name || undefined, permissions: data.permissions });
    load();
  };

  const handleEdit = async (data: { name: string; display_name: string; permissions: string[] }) => {
    if (!editing) return;
    await api.updateRole(editing.name, { name: data.name !== editing.name ? data.name : undefined, display_name: data.display_name || undefined, permissions: data.permissions });
    load();
  };

  const remove = async (name: string) => {
    if (!confirm(`Delete role "${name}"? This cannot be undone.`)) return;
    try { await api.deleteRole(name); load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to delete'); }
  };

  if (loading) return (
    <div className="flex items-center gap-2" style={{ fontSize: 13, color: TM }}>
      <Spinner size="sm" /> Loading roles…
    </div>
  );

  const getRoleAccent = (_name: string) => BR;


  return (
    <div className="space-y-5">
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* Stats strip */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        {([
          { label: 'Total Roles',           value: roles.length,                            icon: 'M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z', color: BR },
          { label: 'Preset',                value: roles.filter(r => r.is_preset).length,  icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z', color: '#0ea5e9' },
          { label: 'Custom',                value: roles.filter(r => !r.is_preset).length, icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z', color: '#f59e0b' },
          { label: 'Permissions Available', value: allPerms.length,                        icon: 'M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z', color: '#10b981' },
        ] as { label: string; value: number; icon: string; color: string }[]).map(s => (
          <div key={s.label} className="rounded-2xl bg-white flex items-center gap-4 px-5 py-4"
               style={{ border: `1px solid ${SEP}`, boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${s.color}14` }}>
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: s.color, width: 18, height: 18 }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d={s.icon} />
              </svg>
            </div>
            <div>
              <p style={{ fontSize: 22, fontWeight: 700, color: T1, lineHeight: 1 }}>{s.value}</p>
              <p style={{ fontSize: 11, color: TM, marginTop: 3 }}>{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex justify-end">
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5"
          style={{ fontSize: 12, fontWeight: 600, padding: '7px 16px', background: BR, color: 'white', borderRadius: 10, border: 'none', cursor: 'pointer' }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
          onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
          </svg>
          Create Role
        </button>
      </div>

      {/* Role list */}
      <div className="rounded-2xl bg-white overflow-hidden" style={{ border: `1px solid ${SEP}`, boxShadow: '0 1px 6px rgba(0,0,0,0.05)' }}>
        {roles.map((r, idx) => {
          const rc     = getRoleAccent(r.name);
          const perms  = r.permissions ?? [];
          const isOpen = expanded === r.name;
          const groupCounts = PERM_GROUPS
            .map(g => ({ label: g.label, count: g.perms.filter(p => perms.includes(p)).length }))
            .filter(g => g.count > 0);

          return (
            <div key={r.name} style={{ borderTop: idx > 0 ? `1px solid ${SEP}` : 'none' }}>

              {/* Row */}
              <div className="flex items-center gap-4"
                   style={{ paddingLeft: 0, paddingRight: 20, paddingTop: 14, paddingBottom: 14, transition: 'background 0.12s' }}
                   onMouseEnter={e => { if (!isOpen) (e.currentTarget as HTMLDivElement).style.background = '#fafafa'; }}
                   onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}>

                {/* Color rail */}
                <div style={{ width: 3, alignSelf: 'stretch', borderRadius: '0 3px 3px 0', background: rc, flexShrink: 0, marginRight: 4 }} />

                {/* Identity */}
                <div style={{ minWidth: 160 }}>
                  <p style={{ fontSize: 13, fontWeight: 700, color: T1 }}>{r.name}</p>
                  {r.display_name
                    ? <p style={{ fontSize: 11, color: TM, marginTop: 1 }}>{r.display_name}</p>
                    : <p style={{ fontSize: 11, color: 'transparent', marginTop: 1 }}>—</p>
                  }
                </div>

                {/* Permission group chips */}
                <div className="flex flex-wrap gap-1.5 flex-1">
                  {groupCounts.length === 0
                    ? <span style={{ fontSize: 11, color: TM, fontStyle: 'italic' }}>No permissions</span>
                    : groupCounts.map(g => (
                        <span key={g.label} style={{ fontSize: 10, fontWeight: 500, background: '#f3f4f6', color: T2, padding: '3px 9px', borderRadius: 20 }}>
                          {g.label}
                          <span style={{ fontWeight: 700, color: TM, marginLeft: 4 }}>{g.count}</span>
                        </span>
                      ))
                  }
                </div>

                {/* Type badge */}
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', flexShrink: 0,
                  background: r.is_preset ? `${BR}12` : '#fef3c7',
                  color: r.is_preset ? BR : '#b45309',
                  padding: '3px 9px', borderRadius: 20 }}>
                  {r.is_preset ? 'Preset' : 'Custom'}
                </span>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  {!r.is_preset && (
                    <>
                      <button onClick={() => setEditing(r)}
                        style={{ fontSize: 11, fontWeight: 600, color: BR, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px', borderRadius: 6, transition: 'background 0.12s' }}
                        onMouseEnter={e => (e.currentTarget.style.background = `${BR}10`)}
                        onMouseLeave={e => (e.currentTarget.style.background = 'none')}>Edit</button>
                      <button onClick={() => remove(r.name)}
                        style={{ fontSize: 11, fontWeight: 600, color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px', borderRadius: 6, transition: 'background 0.12s' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#fef2f2')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'none')}>Delete</button>
                    </>
                  )}
                  {r.is_preset && (
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ width: 14, height: 14, color: TM, marginRight: 4 }} title="Protected — cannot be edited">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                    </svg>
                  )}
                  <button onClick={() => setExpanded(isOpen ? null : r.name)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: 6, color: TM, transition: 'background 0.12s, color 0.12s' }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#f3f4f6'; e.currentTarget.style.color = T1; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = TM; }}>
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ width: 14, height: 14, transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Expanded permission matrix */}
              {isOpen && (
                <div style={{ borderTop: `1px solid ${SEP}`, background: '#fafafa', padding: '16px 20px 16px 27px' }}>
                  <div className="grid gap-x-6 gap-y-4" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                    {PERM_GROUPS.map(g => {
                      const active = g.perms.filter(p => perms.includes(p));
                      if (!active.length) return null;
                      return (
                        <div key={g.label}>
                          <p style={{ fontSize: 10, fontWeight: 700, color: TM, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 7 }}>
                            {g.label}
                            <span style={{ fontWeight: 500, marginLeft: 5, color: TM, opacity: 0.6 }}>{active.length}/{g.perms.length}</span>
                          </p>
                          <div className="flex flex-wrap gap-1">
                            {active.map(p => (
                              <span key={p} style={{ fontSize: 10, background: `${rc}12`, color: rc, padding: '2px 8px', borderRadius: 5, fontWeight: 500 }}>
                                {PERM_LABELS[p] ?? p}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showCreate && <RoleModal allPermissions={allPerms} onSave={handleCreate} onClose={() => setShowCreate(false)} />}
      {editing    && <RoleModal role={editing} allPermissions={allPerms} onSave={handleEdit} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ── Tags tab ──────────────────────────────────────────────────────────────────

function TagsTab() {
  const [tags, setTags]         = useState<string[]>([]);
  const [newTag, setNewTag]     = useState('');
  const [hoveredTag, setHoveredTag] = useState<string | null>(null);

  useEffect(() => { api.getTags().then(setTags).catch(() => {}); }, []);

  const add = async () => {
    const t = newTag.trim().toLowerCase().replace(/\s+/g, '_');
    if (!t || tags.includes(t)) return;
    setNewTag('');
    const updated = await api.createTag(t).catch(() => null);
    if (updated) setTags(updated);
  };
  const remove = async (tag: string) => {
    const updated = await api.deleteTag(tag).catch(() => null);
    if (updated) setTags(updated);
  };

  const compound = tags.filter(t => t.includes('_')).length;
  const simple   = tags.filter(t => !t.includes('_')).length;

  return (
    <div className="space-y-5">

      {/* Stats strip */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {([
          { label: 'Total Tags',     value: tags.length, icon: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z', color: BR },
          { label: 'Compound Tags',  value: compound,    icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1', color: '#0ea5e9' },
          { label: 'Simple Tags',    value: simple,      icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z', color: '#10b981' },
        ] as { label: string; value: number; icon: string; color: string }[]).map(s => (
          <div key={s.label} className="rounded-2xl bg-white flex items-center gap-4 px-5 py-4"
               style={{ border: `1px solid ${SEP}`, boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${s.color}14` }}>
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: s.color, width: 18, height: 18 }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d={s.icon} />
              </svg>
            </div>
            <div>
              <p style={{ fontSize: 22, fontWeight: 700, color: T1, lineHeight: 1 }}>{s.value}</p>
              <p style={{ fontSize: 11, color: TM, marginTop: 3 }}>{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Add tag input */}
      <div className="rounded-2xl bg-white px-5 py-4 flex gap-3 items-center"
           style={{ border: `1px solid ${SEP}`, boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: TM, fontSize: 13, pointerEvents: 'none' }}>#</span>
          <input
            value={newTag}
            onChange={e => setNewTag(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && add()}
            placeholder="new-tag or compound_tag…"
            style={{ ...ADMIN_INPUT_STYLE, paddingLeft: 24 }}
            onFocus={e => (e.currentTarget.style.borderColor = BR)}
            onBlur={e => (e.currentTarget.style.borderColor = 'rgba(0,0,0,0.10)')}
          />
        </div>
        <button onClick={add}
          style={{ fontSize: 12, fontWeight: 600, padding: '7px 18px', background: BR, color: 'white', borderRadius: 10, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
          onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
          Add Tag
        </button>
      </div>

      {/* Tag list */}
      <div className="rounded-2xl bg-white px-5 py-5"
           style={{ border: `1px solid ${SEP}`, boxShadow: '0 1px 4px rgba(0,0,0,0.04)', minHeight: 80 }}>
        {tags.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ width: 32, height: 32, color: TM, opacity: 0.5 }}>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
            </svg>
            <p style={{ fontSize: 13, color: TM }}>No tags yet — add your first one above.</p>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map(t => (
              <div key={t}
                   className="flex items-center gap-1.5"
                   onMouseEnter={() => setHoveredTag(t)}
                   onMouseLeave={() => setHoveredTag(null)}
                   style={{
                     fontSize: 12, fontWeight: 500, color: T2,
                     background: hoveredTag === t ? `${BR}08` : '#f4f5f7',
                     border: `1px solid ${hoveredTag === t ? `${BR}30` : 'transparent'}`,
                     padding: '5px 10px 5px 9px', borderRadius: 20,
                     transition: 'all 0.15s', cursor: 'default',
                   }}>
                <span style={{ color: hoveredTag === t ? BR : TM, fontSize: 11, fontWeight: 600 }}>#</span>
                <span>{t}</span>
                <button onClick={() => remove(t)}
                  style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: hoveredTag === t ? '#ef4444' : TM, transition: 'color 0.15s', marginLeft: 2 }}>
                  <svg width={12} height={12} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12"/>
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Canned Responses tab ──────────────────────────────────────────────────────

type CannedItem = { id: string; title: string; shortcut: string; body: string; scope: string };

function CannedResponsesTab() {
  const [items, setItems]     = useState<CannedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding]   = useState(false);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [form, setForm]       = useState({ title: '', shortcut: '', body: '', scope: 'shared' });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.getCannedResponses()
      .then(setItems)
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!form.title.trim() || !form.shortcut.trim() || !form.body.trim()) { setError('Title, shortcut and body are all required'); return; }
    setSaving(true); setError('');
    try {
      const created = await api.createCannedResponse(form) as CannedItem;
      setItems(prev => [...prev, created]);
      setForm({ title: '', shortcut: '', body: '', scope: 'shared' });
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    try { await api.deleteCannedResponse(id); setItems(prev => prev.filter(i => i.id !== id)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Delete failed'); }
  };

  return (
    <div className="space-y-4">
      {error && <ErrorBanner>{error}</ErrorBanner>}

      <div className="flex justify-end">
        <button
          onClick={() => { setAdding(v => !v); setError(''); }}
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md transition-colors ${
            adding ? 'bg-surface-3 ring-1 ring-surface-5 text-text-secondary' : 'bg-brand hover:bg-brand-dim text-white'
          }`}
        >
          {adding ? 'Cancel' : <><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg>New Canned Response</>}
        </button>
      </div>

      {adding && (
        <div className="bg-surface-2 ring-1 ring-surface-5 rounded-lg p-4 space-y-3 animate-slide-in-up">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Title *">
              <AdminInput value={form.title} onChange={v => setForm(f => ({ ...f, title: v }))} placeholder="e.g. Greeting" />
            </Field>
            <Field label="Shortcut * (no spaces)">
              <AdminInput value={form.shortcut} onChange={v => setForm(f => ({ ...f, shortcut: v.replace(/\s/g, '-') }))} placeholder="e.g. greeting" className="font-mono" />
            </Field>
          </div>
          <Field label="Body * — variables: {{customer_name}} {{ticket_id}} {{agent_name}}">
            <textarea
              value={form.body}
              onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
              placeholder="Hello {{customer_name}}, thank you for contacting Bitazza support…"
              className={`w-full text-xs bg-surface-3 ring-1 ring-surface-5 rounded px-3 py-2 resize-none outline-none focus:ring-brand transition-all text-text-primary placeholder:text-text-muted`}
              rows={4}
            />
          </Field>
          <div className="flex items-center gap-3">
            <Field label="Scope">
              <select value={form.scope} onChange={e => setForm(f => ({ ...f, scope: e.target.value }))}
                className="text-xs bg-surface-3 ring-1 ring-surface-5 rounded px-2.5 py-1.5 text-text-primary outline-none focus:ring-brand">
                <option value="shared">Shared (team-wide)</option>
                <option value="personal">Personal</option>
              </select>
            </Field>
            <button onClick={save} disabled={saving}
              className="mt-4 text-xs px-4 py-1.5 bg-brand hover:bg-brand-dim text-white rounded-md transition-colors disabled:opacity-40 flex items-center gap-1.5">
              {saving ? <><Spinner size="xs" /> Saving…</> : 'Save'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-text-muted"><Spinner size="sm" /> Loading…</div>
      ) : (
        <div className="bg-surface-2 ring-1 ring-surface-5 rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-surface-5">
                {['Title', 'Shortcut', 'Preview', 'Scope', ''].map((h, i) => (
                  <th key={i} className="text-left text-[10px] font-semibold text-text-muted uppercase tracking-wide px-4 py-2.5">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-5">
              {items.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-sm text-text-muted text-center">No canned responses yet</td></tr>
              )}
              {items.map(item => (
                <>
                  <tr key={item.id} className="hover:bg-surface-3 transition-colors cursor-pointer" onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}>
                    <td className="px-4 py-2.5 font-medium text-text-primary">{item.title}</td>
                    <td className="px-4 py-2.5 font-mono text-brand">/{item.shortcut}</td>
                    <td className="px-4 py-2.5 text-text-secondary max-w-[200px] truncate">{item.body}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[9px] px-2 py-0.5 rounded-full font-medium ${
                        item.scope === 'shared' ? 'bg-brand/10 text-brand' : 'bg-surface-4 text-text-muted'
                      }`}>{item.scope}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button onClick={e => { e.stopPropagation(); remove(item.id); }}
                        className="text-[10px] text-text-muted hover:text-brand transition-colors">Delete</button>
                    </td>
                  </tr>
                  {expandedId === item.id && (
                    <tr key={`${item.id}-exp`}>
                      <td colSpan={5} className="px-4 py-3 bg-surface-3">
                        <p className="text-[10px] text-text-muted uppercase tracking-wide mb-1.5">Full body</p>
                        <p className="text-xs text-text-secondary whitespace-pre-wrap">{item.body}</p>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Assignment Rules tab ──────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  kyc_verification:    'KYC Verification',
  withdrawal_issue:    'Withdrawal Issue',
  account_restriction: 'Account Restriction',
  password_2fa_reset:  'Password / 2FA Reset',
  fraud_security:      'Fraud & Security',
};

const KNOWN_TEAMS = ['cs', 'kyc', 'withdrawals', 'fraud'];

const SLA_META = [
  { priority: '1', label: 'VIP (Priority 1)',      color: '#ef4444' },
  { priority: '2', label: 'Elevated (Priority 2)', color: '#f59e0b' },
  { priority: '3', label: 'Standard (Priority 3)', color: '#9ca3af' },
];

function Toggle({ on, onToggle, saving }: { on: boolean; onToggle: () => void; saving?: boolean }) {
  return (
    <button
      onClick={onToggle}
      disabled={saving}
      style={{
        width: 44, height: 26, borderRadius: 13,
        background: on ? BR : '#d1d5db',
        border: 'none', padding: 0,
        cursor: saving ? 'not-allowed' : 'pointer',
        position: 'relative', flexShrink: 0,
        transition: 'background 0.22s',
        opacity: saving ? 0.5 : 1,
        display: 'inline-block',
        boxShadow: on ? `0 0 0 3px ${BR}22` : 'none',
      }}
    >
      <div style={{
        position: 'absolute', top: 3,
        left: on ? 21 : 3,
        width: 20, height: 20, borderRadius: '50%',
        background: 'white',
        boxShadow: '0 1px 4px rgba(0,0,0,0.22)',
        transition: 'left 0.18s',
      }} />
    </button>
  );
}

function RuleCard({ title, subtitle, editable, children }: { title: string; subtitle: string; editable?: boolean; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'white', borderRadius: 16, overflow: 'hidden',
      border: '1px solid rgba(0,0,0,0.09)',
      boxShadow: '0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
    }}>
      <div style={{ padding: '18px 24px 16px', borderBottom: '1px solid rgba(0,0,0,0.07)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <p style={{ fontSize: 14, fontWeight: 700, color: T1, letterSpacing: '-0.015em', lineHeight: 1.3 }}>{title}</p>
          <p style={{ fontSize: 12, color: TM, marginTop: 3, lineHeight: 1.5, maxWidth: 480 }}>{subtitle}</p>
        </div>
        {!editable && (
          <svg width={14} height={14} fill="none" stroke="currentColor" viewBox="0 0 24 24"
               style={{ color: '#c4c9d4', flexShrink: 0, marginTop: 2 }}>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
          </svg>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

type Rules = {
  category_team_map: Record<string, string>;
  sticky_agent_hours: number;
  vip_auto_priority1: boolean;
  sla_minutes: Record<string, number>;
};

interface ConfirmModal {
  title: string;
  description: string;
  onConfirm: () => void;
}

function AssignmentRulesTab() {
  const [saved, setSaved]     = useState<Rules | null>(null); // last committed state
  const [draft, setDraft]     = useState<Rules | null>(null); // working copy
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [saving, setSaving]   = useState<string | null>(null);
  const [toast, setToast]     = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmModal | null>(null);

  useEffect(() => {
    api.getAssignmentRules()
      .then(raw => {
        const rules: Rules = {
          category_team_map:  raw['category_team_map']?.value  as Record<string, string> ?? {},
          sticky_agent_hours: Number(raw['sticky_agent_hours']?.value ?? 12),
          vip_auto_priority1: raw['vip_auto_priority1']?.value !== false && raw['vip_auto_priority1']?.value !== 'false',
          sla_minutes:        raw['sla_minutes']?.value as Record<string, number> ?? { '1': 1, '2': 3, '3': 10 },
        };
        setSaved(rules);
        setDraft(rules);
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load rules'))
      .finally(() => setLoading(false));
  }, []);

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), type === 'error' ? 4000 : 2500);
  }

  const RULE_SAVE_MESSAGES: Record<string, (draft: Rules) => string> = {
    category_team_map:  () => 'Category → Team routing updated. New tickets will be routed to the new teams.',
    sticky_agent_hours: (d) => `Sticky agent window set to ${d.sticky_agent_hours} hour${d.sticky_agent_hours !== 1 ? 's' : ''}. Returning customers will be matched within this window.`,
    vip_auto_priority1: (d) => d.vip_auto_priority1
      ? 'VIP Auto-Priority enabled. VIP customers will now receive Priority 1 on all new tickets.'
      : 'VIP Auto-Priority disabled. VIP customers will follow standard priority rules.',
    sla_minutes: (d) => `SLA targets updated — P1: ${d.sla_minutes['1']}m · P2: ${d.sla_minutes['2']}m · P3: ${d.sla_minutes['3']}m. Applies to newly assigned tickets.`,
  };

  async function commitSave(key: string, value: unknown) {
    setSaving(key);
    setConfirm(null);
    try {
      await api.updateAssignmentRule(key, value);
      setSaved(draft);
      const msg = draft ? RULE_SAVE_MESSAGES[key]?.(draft) ?? 'Changes saved.' : 'Changes saved.';
      showToast(msg, 'success');
    } catch (e) {
      setDraft(saved);
      const raw = e instanceof Error ? e.message : 'Unknown error';
      const friendly =
        raw.includes('403') || raw.includes('Insufficient') ? 'You do not have permission to change this setting.' :
        raw.includes('401') || raw.includes('Missing token')  ? 'Your session has expired. Please log in again.' :
        raw.includes('500') || raw.includes('Server error')   ? 'A server error occurred. The change was not applied — please try again.' :
        raw.includes('Failed to fetch') || raw.includes('NetworkError') ? 'Could not reach the server. Check your connection and try again.' :
        `Save failed: ${raw}`;
      showToast(friendly, 'error');
    } finally {
      setSaving(null);
    }
  }

  function requestSave(key: string, value: unknown, title: string, description: string) {
    setConfirm({ title, description, onConfirm: () => commitSave(key, value) });
  }

  function isDirty(key: keyof Rules): boolean {
    if (!saved || !draft) return false;
    return JSON.stringify(saved[key]) !== JSON.stringify(draft[key]);
  }

  if (loading) return <div className="flex items-center gap-2 text-sm text-text-muted"><Spinner size="sm" /> Loading rules…</div>;
  if (error)   return <ErrorBanner>{error}</ErrorBanner>;
  if (!draft)  return null;

  const catDirty   = isDirty('category_team_map');
  const stickyDirty = isDirty('sticky_agent_hours');
  const vipDirty   = isDirty('vip_auto_priority1');
  const slaDirty   = isDirty('sla_minutes');

  const ROW: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0 24px', minHeight: 52, borderBottom: '1px solid rgba(0,0,0,0.06)',
  };
  const ROW_LAST: React.CSSProperties = { ...ROW, borderBottom: 'none' };
  const ROW_LABEL: React.CSSProperties = { fontSize: 13, fontWeight: 500, color: T1 };
  const ROW_SUB: React.CSSProperties   = { fontSize: 11, color: TM, marginTop: 2, lineHeight: 1.5 };
  const SEL: React.CSSProperties = {
    fontSize: 12, fontWeight: 500, color: T1,
    background: 'white', border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: 8, padding: '6px 28px 6px 10px',
    outline: 'none', cursor: 'pointer', width: 148,
    appearance: 'none' as const,
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%239ca3af' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center',
    boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
  };

  return (
    <div className="space-y-4" style={{ maxWidth: 680 }}>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-5 right-5 z-50 flex items-start gap-3 rounded-2xl shadow-2xl"
             style={{
               padding: '14px 18px', maxWidth: 360,
               background: toast.type === 'error' ? '#1c0505' : 'white',
               border: `1px solid ${toast.type === 'error' ? 'rgba(239,68,68,0.25)' : 'rgba(0,0,0,0.08)'}`,
               color: toast.type === 'error' ? '#fca5a5' : T1,
               fontSize: 13, lineHeight: 1.5,
             }}>
          <svg width={16} height={16} fill="none" stroke="currentColor" viewBox="0 0 24 24"
               style={{ color: toast.type === 'error' ? '#f87171' : '#10b981', flexShrink: 0, marginTop: 1 }}>
            {toast.type === 'error'
              ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m9.303 3.376c.866 1.5-.217 3.374-1.948 3.374H4.645c-1.73 0-2.813-1.874-1.948-3.374L10.052 3.378c.866-1.5 3.032-1.5 3.898 0L21.303 16.126zM12 15.75h.007v.008H12v-.008z" />
              : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            }
          </svg>
          <span style={{ flex: 1 }}>{toast.msg}</span>
          <button onClick={() => setToast(null)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', opacity: 0.4, padding: 0, flexShrink: 0 }}>
            <svg width={13} height={13} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Confirmation modal */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center"
             style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(6px)' }}>
          <div className="w-full max-w-sm mx-4 rounded-2xl bg-white"
               style={{ border: '1px solid rgba(0,0,0,0.09)', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <div style={{ padding: '24px 24px 0' }}>
              <p style={{ fontSize: 15, fontWeight: 700, color: T1, letterSpacing: '-0.01em', marginBottom: 8 }}>{confirm.title}</p>
              <p style={{ fontSize: 13, color: T2, lineHeight: 1.6 }}>{confirm.description}</p>
            </div>
            <div className="flex gap-2 justify-end" style={{ padding: '20px 24px' }}>
              <button onClick={() => setConfirm(null)}
                style={{ fontSize: 13, fontWeight: 500, padding: '8px 18px', borderRadius: 10, border: '1px solid rgba(0,0,0,0.10)', background: 'white', color: T2, cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
                onMouseLeave={e => (e.currentTarget.style.background = 'white')}>
                Cancel
              </button>
              <button onClick={confirm.onConfirm}
                style={{ fontSize: 13, fontWeight: 600, padding: '8px 20px', borderRadius: 10, border: 'none', background: BR, color: 'white', cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
                onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
                Apply Change
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Category → Team Routing */}
      <RuleCard editable title="Category → Team Routing" subtitle="Tickets are routed to a team based on their category. Unmatched categories fall back to CS.">
        {Object.entries(draft.category_team_map).map(([cat, team], i, arr) => (
          <div key={cat} style={i < arr.length - 1 ? ROW : ROW_LAST}>
            <span style={ROW_LABEL}>{CATEGORY_LABELS[cat] ?? cat}</span>
            <select
              value={team}
              disabled={saving === 'category_team_map'}
              onChange={e => setDraft(d => d ? { ...d, category_team_map: { ...d.category_team_map, [cat]: e.target.value } } : d)}
              style={SEL}
            >
              {KNOWN_TEAMS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        ))}
        <div style={{ ...ROW, borderBottom: '1px solid rgba(0,0,0,0.06)', opacity: 0.4 }}>
          <span style={{ ...ROW_LABEL, fontStyle: 'italic' }}>All other categories</span>
          <span style={{ fontSize: 12, color: TM }}>cs (fallback)</span>
        </div>
        <SaveBar
          dirty={catDirty}
          saving={saving === 'category_team_map'}
          onDiscard={() => setDraft(d => d ? { ...d, category_team_map: saved!.category_team_map } : d)}
          onSave={() => requestSave(
            'category_team_map', draft.category_team_map,
            'Update Category → Team Routing',
            'This will immediately affect how all incoming tickets are routed to teams. Changes take effect on the next ticket created.'
          )}
        />
      </RuleCard>

      {/* Agent Routing Strategy — system locked */}
      <RuleCard title="Agent Routing Strategy" subtitle="Controls how tickets are distributed to available agents within a team.">
        {[
          { label: 'Round-Robin', sub: 'Least recently used — ticket goes to the Available agent with the oldest last-assignment time who is under capacity.' },
          { label: 'Queue Fallback', sub: 'If no agent is available the ticket is queued. VIP tickets go to the front, others to the back.' },
        ].map((r, i, arr) => (
          <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 24px', borderBottom: i < arr.length - 1 ? '1px solid rgba(0,0,0,0.06)' : 'none' }}>
            <svg width={16} height={16} fill="none" stroke={BR} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" style={{ flexShrink: 0, marginTop: 2 }}>
              <path d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            <div>
              <p style={ROW_LABEL}>{r.label}</p>
              <p style={ROW_SUB}>{r.sub}</p>
            </div>
          </div>
        ))}
      </RuleCard>

      {/* Sticky Agent */}
      <RuleCard editable title="Sticky Agent" subtitle="Returning customers are matched to their previous agent if they return within the configured window and the agent is available.">
        <div style={ROW}>
          <div>
            <p style={ROW_LABEL}>Return window</p>
            <p style={ROW_SUB}>How long after a conversation ends the customer is re-matched</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number" min={1} max={72}
              value={draft.sticky_agent_hours}
              disabled={saving === 'sticky_agent_hours'}
              onChange={e => setDraft(d => d ? { ...d, sticky_agent_hours: Number(e.target.value) } : d)}
              style={{ width: 72, fontSize: 15, fontWeight: 700, textAlign: 'center' as const, background: 'white', border: '1px solid rgba(0,0,0,0.12)', borderRadius: 10, padding: '7px 8px', color: T1, outline: 'none', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}
              onFocus={e => (e.currentTarget.style.borderColor = BR)}
              onBlur={e => (e.currentTarget.style.borderColor = 'rgba(0,0,0,0.12)')}
            />
            <span style={{ fontSize: 13, color: TM, fontWeight: 400 }}>hours</span>
          </div>
        </div>
        <SaveBar
          dirty={stickyDirty}
          saving={saving === 'sticky_agent_hours'}
          onDiscard={() => setDraft(d => d ? { ...d, sticky_agent_hours: saved!.sticky_agent_hours } : d)}
          onSave={() => requestSave(
            'sticky_agent_hours', draft.sticky_agent_hours,
            'Update Sticky Agent Window',
            `Returning customers will be matched to their previous agent only if they return within ${draft.sticky_agent_hours} hour${draft.sticky_agent_hours !== 1 ? 's' : ''}. This affects all new tickets.`
          )}
        />
      </RuleCard>

      {/* VIP Auto-Priority */}
      <RuleCard editable title="VIP Auto-Priority" subtitle="Tickets from VIP-tier customers are automatically promoted to Priority 1 on creation.">
        <div style={ROW_LAST}>
          <div>
            <p style={ROW_LABEL}>Auto-promote VIP tickets</p>
            <p style={ROW_SUB}>
              {draft.vip_auto_priority1
                ? 'Enabled — VIP customers will receive Priority 1 on every new ticket.'
                : 'Disabled — VIP tickets use standard priority rules.'}
            </p>
          </div>
          <Toggle
            on={draft.vip_auto_priority1}
            saving={saving === 'vip_auto_priority1'}
            onToggle={() => setDraft(d => d ? { ...d, vip_auto_priority1: !d.vip_auto_priority1 } : d)}
          />
        </div>
        <SaveBar
          dirty={vipDirty}
          saving={saving === 'vip_auto_priority1'}
          onDiscard={() => setDraft(d => d ? { ...d, vip_auto_priority1: saved!.vip_auto_priority1 } : d)}
          onSave={() => requestSave(
            'vip_auto_priority1', draft.vip_auto_priority1,
            `${draft.vip_auto_priority1 ? 'Enable' : 'Disable'} VIP Auto-Priority`,
            draft.vip_auto_priority1
              ? 'VIP customers will automatically receive Priority 1 on every new ticket. This affects SLA deadlines and queue position.'
              : 'VIP customers will no longer be auto-promoted to Priority 1. Their tickets will follow standard priority rules.'
          )}
        />
      </RuleCard>

      {/* SLA Deadlines */}
      <RuleCard editable title="SLA Deadlines" subtitle="Time-to-first-response targets applied at the moment a ticket is assigned to an agent.">
        {SLA_META.map(({ priority, label, color }, i, arr) => (
          <div key={priority} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', minHeight: 52, borderBottom: i < arr.length - 1 ? '1px solid rgba(0,0,0,0.06)' : 'none' }}>
            <div className="flex items-center gap-3">
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0, boxShadow: `0 0 0 2px ${color}22` }} />
              <span style={ROW_LABEL}>{label}</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number" min={1} max={1440}
                value={draft.sla_minutes[priority] ?? ''}
                disabled={saving === 'sla_minutes'}
                onChange={e => setDraft(d => d ? { ...d, sla_minutes: { ...d.sla_minutes, [priority]: Number(e.target.value) } } : d)}
                style={{ width: 72, fontSize: 15, fontWeight: 700, textAlign: 'center' as const, background: 'white', border: '1px solid rgba(0,0,0,0.12)', borderRadius: 10, padding: '7px 8px', color: T1, outline: 'none', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}
                onFocus={e => (e.currentTarget.style.borderColor = color)}
                onBlur={e => (e.currentTarget.style.borderColor = 'rgba(0,0,0,0.12)')}
              />
              <span style={{ fontSize: 11, fontWeight: 500, color: TM, width: 24 }}>min</span>
            </div>
          </div>
        ))}
        <SaveBar
          dirty={slaDirty}
          saving={saving === 'sla_minutes'}
          onDiscard={() => setDraft(d => d ? { ...d, sla_minutes: saved!.sla_minutes } : d)}
          onSave={() => requestSave(
            'sla_minutes', draft.sla_minutes,
            'Update SLA Deadlines',
            'New SLA targets will apply to all tickets assigned from this point forward. Tickets already in progress keep their existing deadlines.'
          )}
        />
      </RuleCard>
    </div>
  );
}

function SaveBar({ dirty, saving, onSave, onDiscard }: { dirty: boolean; saving: boolean; onSave: () => void; onDiscard: () => void }) {
  if (!dirty) return null;
  return (
    <div className="flex items-center justify-end gap-2"
         style={{ padding: '14px 24px', borderTop: '1px solid rgba(0,0,0,0.06)', background: 'rgba(249,250,251,0.8)' }}>
      <button
        onClick={onDiscard}
        disabled={saving}
        style={{ fontSize: 12, fontWeight: 500, padding: '7px 16px', borderRadius: 10, border: '1px solid rgba(0,0,0,0.10)', background: 'white', color: T2, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.5 : 1 }}
        onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
        onMouseLeave={e => (e.currentTarget.style.background = 'white')}
      >
        Discard
      </button>
      <button
        onClick={onSave}
        disabled={saving}
        style={{ fontSize: 12, fontWeight: 600, padding: '7px 18px', borderRadius: 10, border: 'none', background: BR, color: 'white', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.65 : 1, display: 'flex', alignItems: 'center', gap: 6 }}
        onMouseEnter={e => (e.currentTarget.style.opacity = saving ? '0.65' : '0.88')}
        onMouseLeave={e => (e.currentTarget.style.opacity = saving ? '0.65' : '1')}
      >
        {saving && <Spinner size="sm" />}
        Save Changes
      </button>
    </div>
  );
}

// ── Announcements tab ─────────────────────────────────────────────────────────

interface Announcement {
  id: string;
  title_en: string;
  body_en: string;
  title_th: string;
  body_th: string;
  color: string | null;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
}

const PRESET_COLORS = ['#6366f1','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6'];

function toLocalDatetimeInput(utcStr: string | null): string {
  if (!utcStr) return '';
  const d = new Date(utcStr);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localDatetimeInputToISO(s: string): string | null {
  if (!s) return null;
  return new Date(s).toISOString();
}

const EMPTY_ANN_FORM = { title_en: '', body_en: '', title_th: '', body_th: '', color: '', starts_at: '', ends_at: '' };

function AnnouncementsTab() {
  const [items, setItems]     = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing]   = useState<Announcement | null>(null);
  const [form, setForm]         = useState({ ...EMPTY_ANN_FORM });
  const [saving, setSaving]     = useState(false);
  const { toast }               = useToast();

  const load = async () => {
    try {
      setItems(await api.getAnnouncements());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditing(null); setForm({ ...EMPTY_ANN_FORM }); setShowForm(true); };
  const openEdit   = (a: Announcement) => {
    setEditing(a);
    setForm({
      title_en: a.title_en, body_en: a.body_en,
      title_th: a.title_th, body_th: a.body_th,
      color:    a.color ?? '',
      starts_at: toLocalDatetimeInput(a.starts_at),
      ends_at:   toLocalDatetimeInput(a.ends_at),
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.title_en.trim() || !form.body_en.trim() || !form.title_th.trim() || !form.body_th.trim()) {
      setError('All four title/body fields are required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = {
        title_en: form.title_en.trim(), body_en: form.body_en.trim(),
        title_th: form.title_th.trim(), body_th: form.body_th.trim(),
        color:     form.color || null,
        starts_at: localDatetimeInputToISO(form.starts_at),
        ends_at:   localDatetimeInputToISO(form.ends_at),
      };
      if (editing) {
        await api.updateAnnouncement(editing.id, payload);
      } else {
        await api.createAnnouncement(payload);
      }
      toast(editing ? 'Announcement updated' : 'Announcement created', 'success');
      setShowForm(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (a: Announcement) => {
    try {
      await api.toggleAnnouncement(a.id);
      load();
    } catch {
      toast('Toggle failed', 'error');
    }
  };

  const handleDelete = async (a: Announcement) => {
    if (!confirm(`Delete "${a.title_en}"?`)) return;
    try {
      await api.deleteAnnouncement(a.id);
      toast('Announcement deleted', 'success');
      load();
    } catch {
      toast('Delete failed', 'error');
    }
  };

  const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

  if (loading) return <div className="flex items-center gap-2" style={{ fontSize: 13, color: TM }}><Spinner size="sm" /> Loading…</div>;

  return (
    <div className="space-y-5">
      {error && <ErrorBanner>{error}</ErrorBanner>}

      <div className="flex items-center justify-between">
        <p style={{ fontSize: 12, color: T2 }}>
          Active announcements are shown as dismissible cards in the widget before the category picker.
        </p>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 shrink-0"
          style={{ fontSize: 12, fontWeight: 600, padding: '7px 16px', background: BR, color: 'white', borderRadius: 10, border: 'none', cursor: 'pointer' }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
          onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
          </svg>
          New Announcement
        </button>
      </div>

      <div className="rounded-2xl overflow-hidden bg-white" style={{ border: `1px solid ${SEP}`, boxShadow: '0 1px 6px rgba(0,0,0,0.05)' }}>
        <table className="w-full">
          <thead>
            <tr style={{ borderBottom: `1px solid ${SEP}`, background: '#fafbfc' }}>
              {['Title (EN)', 'Title (TH)', 'Color', 'Active', 'Starts', 'Ends', 'Actions'].map(h => (
                <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 700, color: TM, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '10px 14px' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: '40px 16px', textAlign: 'center', fontSize: 13, color: TM }}>No announcements yet</td>
              </tr>
            )}
            {items.map((a, idx) => (
              <tr
                key={a.id}
                style={{ borderTop: idx > 0 ? `1px solid ${SEP}` : 'none', background: 'transparent', transition: 'background 0.12s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = '#f9fafb'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent'; }}
              >
                <td style={{ padding: '10px 14px', fontSize: 12, color: T1, fontWeight: 600, maxWidth: 200 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title_en}</div>
                  <div style={{ fontSize: 11, color: T2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{a.body_en}</div>
                </td>
                <td style={{ padding: '10px 14px', fontSize: 12, color: T1, maxWidth: 200 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title_th}</div>
                </td>
                <td style={{ padding: '10px 14px' }}>
                  {a.color
                    ? <div style={{ width: 18, height: 18, borderRadius: 5, background: a.color, border: '1.5px solid rgba(0,0,0,0.10)' }} title={a.color} />
                    : <span style={{ fontSize: 11, color: TM }}>default</span>}
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <button
                    onClick={() => handleToggle(a)}
                    title={a.active ? 'Deactivate' : 'Activate'}
                    style={{
                      width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', padding: 0,
                      background: a.active ? '#10b981' : '#d1d5db', transition: 'background 0.2s', position: 'relative',
                    }}
                  >
                    <div style={{
                      position: 'absolute', top: 3, left: a.active ? 18 : 3,
                      width: 14, height: 14, borderRadius: '50%', background: 'white',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'left 0.15s',
                    }} />
                  </button>
                </td>
                <td style={{ padding: '10px 14px', fontSize: 12, color: T2 }}>{fmtDate(a.starts_at)}</td>
                <td style={{ padding: '10px 14px', fontSize: 12, color: T2 }}>{fmtDate(a.ends_at)}</td>
                <td style={{ padding: '10px 14px' }}>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => openEdit(a)}
                      style={{ fontSize: 11, fontWeight: 600, padding: '4px 10px', background: '#f3f4f6', color: T2, borderRadius: 7, border: 'none', cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#e5e7eb')}
                      onMouseLeave={e => (e.currentTarget.style.background = '#f3f4f6')}
                    >Edit</button>
                    <button
                      onClick={() => handleDelete(a)}
                      style={{ fontSize: 11, fontWeight: 600, padding: '4px 10px', background: '#fef2f2', color: '#ef4444', borderRadius: 7, border: 'none', cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#fee2e2')}
                      onMouseLeave={e => (e.currentTarget.style.background = '#fef2f2')}
                    >Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showForm && (
        <ModalShell title={editing ? 'Edit Announcement' : 'New Announcement'} onClose={() => setShowForm(false)} width="w-[560px]">
          {error && <ErrorBanner>{error}</ErrorBanner>}
          <Field label="Title (English)">
            <AdminInput value={form.title_en} onChange={v => setForm(f => ({ ...f, title_en: v }))} placeholder="e.g. Scheduled Maintenance Tonight" />
          </Field>
          <Field label="Body (English)">
            <textarea
              value={form.body_en}
              onChange={e => setForm(f => ({ ...f, body_en: e.target.value }))}
              placeholder="Brief message shown to customers…"
              rows={3}
              style={{ ...ADMIN_INPUT_STYLE, resize: 'vertical' }}
              onFocus={e => (e.currentTarget.style.borderColor = BR)}
              onBlur={e => (e.currentTarget.style.borderColor = 'rgba(0,0,0,0.10)')}
            />
          </Field>
          <Field label="Title (Thai)">
            <AdminInput value={form.title_th} onChange={v => setForm(f => ({ ...f, title_th: v }))} placeholder="e.g. กำหนดการบำรุงรักษาคืนนี้" />
          </Field>
          <Field label="Body (Thai)">
            <textarea
              value={form.body_th}
              onChange={e => setForm(f => ({ ...f, body_th: e.target.value }))}
              placeholder="ข้อความสั้นๆ ที่แสดงต่อลูกค้า…"
              rows={3}
              style={{ ...ADMIN_INPUT_STYLE, resize: 'vertical' }}
              onFocus={e => (e.currentTarget.style.borderColor = BR)}
              onBlur={e => (e.currentTarget.style.borderColor = 'rgba(0,0,0,0.10)')}
            />
          </Field>
          <Field label="Card color (optional — defaults to widget brand color)">
            <div className="flex items-center gap-2 flex-wrap">
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, color: f.color === c ? '' : c }))}
                  style={{
                    width: 26, height: 26, borderRadius: 7, background: c, border: 'none', cursor: 'pointer', flexShrink: 0,
                    outline: form.color === c ? `3px solid ${c}` : '2px solid transparent',
                    outlineOffset: 2,
                    transition: 'outline 0.1s',
                  }}
                  title={c}
                />
              ))}
              {/* Custom hex input */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 4 }}>
                <input
                  type="color"
                  value={form.color || '#6366f1'}
                  onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                  style={{ width: 26, height: 26, padding: 1, border: '1px solid rgba(0,0,0,0.12)', borderRadius: 7, cursor: 'pointer', background: 'none' }}
                  title="Custom color"
                />
                <input
                  type="text"
                  value={form.color}
                  onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                  placeholder="#hex or empty for default"
                  style={{ ...ADMIN_INPUT_STYLE, width: 160 }}
                />
                {form.color && (
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, color: '' }))}
                    style={{ fontSize: 11, color: TM, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}
                  >clear</button>
                )}
              </div>
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts at (optional)">
              <input type="datetime-local" value={form.starts_at} onChange={e => setForm(f => ({ ...f, starts_at: e.target.value }))} style={ADMIN_INPUT_STYLE} />
            </Field>
            <Field label="Ends at (optional)">
              <input type="datetime-local" value={form.ends_at} onChange={e => setForm(f => ({ ...f, ends_at: e.target.value }))} style={ADMIN_INPUT_STYLE} />
            </Field>
          </div>
          <ModalFooter onClose={() => setShowForm(false)} onSave={handleSave} saving={saving} saveLabel={editing ? 'Save Changes' : 'Create'} />
        </ModalShell>
      )}
    </div>
  );
}

// ── Stub tab ──────────────────────────────────────────────────────────────────

function StubTab({ label, description }: { label: string; description: string }) {
  return (
    <div className="bg-surface-2 ring-1 ring-surface-5 rounded-lg p-8 text-center">
      <div className="w-10 h-10 rounded-full bg-surface-3 ring-1 ring-surface-5 flex items-center justify-center mx-auto mb-3">
        <svg className="w-5 h-5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
      </div>
      <h3 className="text-sm font-semibold text-text-primary mb-1.5">{label}</h3>
      <p className="text-xs text-text-secondary max-w-sm mx-auto">{description}</p>
      <p className="text-[10px] text-text-muted mt-3">Coming in Phase 4</p>
    </div>
  );
}

// ── Shared helpers ────────────────────────────────────────────────────────────

const ADMIN_INPUT_STYLE: React.CSSProperties = {
  width: '100%', fontSize: 12, background: '#f9fafb', border: '1px solid rgba(0,0,0,0.10)',
  borderRadius: 8, padding: '7px 10px', color: T1, outline: 'none', transition: 'border-color 0.15s',
};

function AdminInput({ value, onChange, placeholder, type = 'text', autoFocus, className = '' }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string; autoFocus?: boolean; className?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      className={className}
      style={ADMIN_INPUT_STYLE}
      onFocus={e => (e.currentTarget.style.borderColor = BR)}
      onBlur={e => (e.currentTarget.style.borderColor = 'rgba(0,0,0,0.10)')}
    />
  );
}

function AdminSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={ADMIN_INPUT_STYLE}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label style={{ fontSize: 10, fontWeight: 700, color: TM, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</label>
      {children}
    </div>
  );
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#ef4444', fontSize: 12, padding: '10px 12px', borderRadius: 10 }}>
      <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/>
      </svg>
      {children}
    </div>
  );
}

function ModalShell({ title, onClose, children, width = 'w-[480px]' }: { title: string; onClose: () => void; children: React.ReactNode; width?: string }) {
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}>
      <div className={`bg-white rounded-2xl ${width} max-h-[90vh] flex flex-col animate-scale-in`} style={{ boxShadow: '0 24px 64px rgba(0,0,0,0.18)', border: '1px solid rgba(0,0,0,0.07)' }}>
        <div className="flex items-center justify-between px-6 py-4 shrink-0" style={{ borderBottom: `1px solid ${SEP}` }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: T1 }}>{title}</h3>
          <button onClick={onClose} className="flex items-center justify-center" style={{ width: 28, height: 28, borderRadius: 8, background: '#f3f4f6', border: 'none', cursor: 'pointer', color: TM, transition: 'background 0.15s' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#e5e7eb')}
            onMouseLeave={e => (e.currentTarget.style.background = '#f3f4f6')}>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {children}
        </div>
      </div>
    </div>
  );
}

function ModalFooter({ onClose, onSave, saving, saveLabel, disabled = false }: { onClose: () => void; onSave: () => void; saving: boolean; saveLabel: string; disabled?: boolean }) {
  return (
    <div className="flex justify-end gap-2 pt-4 mt-2" style={{ borderTop: `1px solid ${SEP}` }}>
      <button onClick={onClose}
        style={{ fontSize: 12, fontWeight: 600, padding: '7px 16px', background: '#f3f4f6', color: T2, borderRadius: 9, border: 'none', cursor: 'pointer', transition: 'background 0.15s' }}
        onMouseEnter={e => (e.currentTarget.style.background = '#e5e7eb')}
        onMouseLeave={e => (e.currentTarget.style.background = '#f3f4f6')}>
        Cancel
      </button>
      <button
        onClick={onSave}
        disabled={saving || disabled}
        className="flex items-center gap-1.5"
        style={{ fontSize: 12, fontWeight: 600, padding: '7px 16px', background: disabled || saving ? '#a5b4fc' : BR, color: 'white', borderRadius: 9, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', transition: 'opacity 0.15s' }}
        onMouseEnter={e => { if (!disabled && !saving) e.currentTarget.style.opacity = '0.85'; }}
        onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
      >
        {saving ? <><Spinner size="xs" /> Saving…</> : saveLabel}
      </button>
    </div>
  );
}


// ── Notifications tab ─────────────────────────────────────────────────────────

const CHANNEL_META: Record<string, { label: string; icon: string; fields: ChannelField[] }> = {
  slack: {
    label: 'Slack',
    icon: 'M5.042 15.165a2.528 2.528 0 01-2.52 2.523A2.528 2.528 0 010 15.165a2.527 2.527 0 012.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 012.521-2.52 2.527 2.527 0 012.521 2.52v6.313A2.528 2.528 0 018.834 24a2.528 2.528 0 01-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 01-2.521-2.52A2.528 2.528 0 018.834 0a2.528 2.528 0 012.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 012.521 2.521 2.528 2.528 0 01-2.521 2.521H2.522A2.528 2.528 0 010 8.834a2.528 2.528 0 012.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 012.522-2.521A2.528 2.528 0 0124 8.834a2.528 2.528 0 01-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 01-2.523 2.521 2.527 2.527 0 01-2.52-2.521V2.522A2.527 2.527 0 0115.165 0a2.528 2.528 0 012.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 012.523 2.522A2.528 2.528 0 0115.165 24a2.527 2.527 0 01-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 01-2.52-2.523 2.526 2.526 0 012.52-2.52h6.313A2.527 2.527 0 0124 15.165a2.528 2.528 0 01-2.522 2.523h-6.313z',
    fields: [{ key: 'webhook_url', label: 'Webhook URL', placeholder: 'https://hooks.slack.com/services/…', type: 'url' }],
  },
  teams: {
    label: 'Microsoft Teams',
    icon: 'M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.27 6.27 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.18 8.18 0 004.78 1.52V6.76a4.85 4.85 0 01-1.01-.07z',
    fields: [{ key: 'webhook_url', label: 'Webhook URL', placeholder: 'https://…webhook.office.com/webhookb2/…', type: 'url' }],
  },
  discord: {
    label: 'Discord',
    icon: 'M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03z',
    fields: [{ key: 'webhook_url', label: 'Webhook URL', placeholder: 'https://discord.com/api/webhooks/…', type: 'url' }],
  },
  line: {
    label: 'LINE Notify',
    icon: 'M22.198 10.624C22.198 4.762 16.265 0 9 0S-4.198 4.762-4.198 10.624c0 5.273 4.667 9.692 10.974 10.533.427.092 1.01.282 1.157.646.132.331.086.848.042 1.183l-.187 1.126c-.058.331-.266 1.295 1.133.706 1.4-.588 7.542-4.444 10.289-7.606 1.896-2.08 2.988-4.196 2.988-6.588',
    fields: [{ key: 'token', label: 'Access Token', placeholder: 'LINE Notify access token', type: 'password' }],
  },
  email: {
    label: 'Email',
    icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
    fields: [
      { key: 'to_emails', label: 'Recipients (comma-separated)', placeholder: 'team@company.com, manager@company.com', type: 'text' },
      { key: 'smtp_host', label: 'SMTP Host', placeholder: 'smtp.gmail.com', type: 'text' },
      { key: 'smtp_port', label: 'SMTP Port', placeholder: '587', type: 'text' },
      { key: 'smtp_user', label: 'SMTP Username', placeholder: 'support@company.com', type: 'text' },
      { key: 'smtp_pass', label: 'SMTP Password', placeholder: '••••••••', type: 'password' },
    ],
  },
  notion: {
    label: 'Notion',
    icon: 'M4 4h16v16H4V4zm2 4v8h12V8H6zm2 2h8v1H8v-1zm0 3h8v1H8v-1z',
    fields: [
      { key: 'token', label: 'Integration Token', placeholder: 'secret_…', type: 'password' },
      { key: 'page_id', label: 'Page ID', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', type: 'text' },
    ],
  },
  confluence: {
    label: 'Confluence',
    icon: 'M2.654 18.522c-.384.627-.808 1.352-.808 1.352s2.748 1.652 5.6 1.652c3.176 0 5.6-1.652 5.6-1.652s-.427-.725-.808-1.352c-.46-.752-1.172-1.352-2.028-1.352H4.682c-.856 0-1.568.6-2.028 1.352zM12 2C7.352 2 4 5.02 4 8.5c0 2.3 1.4 4.35 3.5 5.5L12 22l4.5-8c2.1-1.15 3.5-3.2 3.5-5.5C20 5.02 16.648 2 12 2z',
    fields: [
      { key: 'site_url', label: 'Site URL', placeholder: 'https://yourcompany.atlassian.net', type: 'url' },
      { key: 'email', label: 'Atlassian Email', placeholder: 'you@company.com', type: 'text' },
      { key: 'api_token', label: 'API Token', placeholder: 'API token from id.atlassian.com', type: 'password' },
      { key: 'space_key', label: 'Space Key', placeholder: 'CS', type: 'text' },
      { key: 'page_title', label: 'Page Title', placeholder: 'CS Bot Reports', type: 'text' },
    ],
  },
};

interface ChannelField {
  key: string;
  label: string;
  placeholder: string;
  type: 'text' | 'url' | 'password';
}

type ChannelKey = keyof typeof CHANNEL_META;

const VISIBLE_CHANNELS: ChannelKey[] = ['slack', 'email'];

function NotificationsTab() {
  const { toast } = useToast();
  const [configs, setConfigs] = useState<Record<string, NotificationChannelConfig>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<Record<string, 'daily' | 'weekly' | null>>({});
  const [errors, setErrors] = useState<Record<string, Record<string, string>>>({});
  // track which channels were originally saved (have DB data)
  const [savedChannels, setSavedChannels] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.getNotificationChannels().then(list => {
      const map: Record<string, NotificationChannelConfig> = {};
      const dbChannels = new Set<string>();
      for (const ch of list) {
        map[ch.channel] = ch;
        if (ch.updated_at) dbChannels.add(ch.channel);
      }
      for (const key of Object.keys(CHANNEL_META)) {
        if (!map[key]) map[key] = { channel: key, enabled: false, config: {}, reports: { daily: true, weekly: true } };
      }
      setConfigs(map);
      setSavedChannels(dbChannels);
    }).finally(() => setLoading(false));
  }, []);

  const update = (channel: string, patch: Partial<NotificationChannelConfig>) => {
    setConfigs(prev => {
      const existing = prev[channel] ?? { channel, enabled: false, config: {}, reports: { daily: true, weekly: true } };
      return { ...prev, [channel]: { ...existing, ...patch } };
    });
  };

  const updateField = (channel: string, key: string, value: string) => {
    setConfigs(prev => {
      const existing = prev[channel] ?? { channel, enabled: false, config: {}, reports: { daily: true, weekly: true } };
      return { ...prev, [channel]: { ...existing, config: { ...existing.config, [key]: value } } };
    });
  };

  const disconnect = async (channel: string) => {
    setSaving(prev => ({ ...prev, [channel]: true }));
    try {
      await api.saveNotificationChannel(channel, { enabled: false, config: {}, reports: { daily: true, weekly: true } });
      setConfigs(prev => ({ ...prev, [channel]: { channel, enabled: false, config: {}, reports: { daily: true, weekly: true } } }));
      setSavedChannels(prev => { const s = new Set(prev); s.delete(channel); return s; });
      toast(`${CHANNEL_META[channel]?.label ?? channel} disconnected`, 'success');
    } catch {
      toast('Failed to disconnect', 'error');
    } finally {
      setSaving(prev => ({ ...prev, [channel]: false }));
    }
  };

  const validate = (channel: string): boolean => {
    const cfg = configs[channel];
    const meta = CHANNEL_META[channel];
    const fieldErrors: Record<string, string> = {};
    for (const field of meta.fields) {
      if (!cfg.config[field.key]?.trim()) {
        fieldErrors[field.key] = `${field.label} is required`;
      }
    }
    setErrors(prev => ({ ...prev, [channel]: fieldErrors }));
    return Object.keys(fieldErrors).length === 0;
  };

  const save = async (channel: string) => {
    if (!validate(channel)) return;
    const cfg = configs[channel];
    setSaving(prev => ({ ...prev, [channel]: true }));
    try {
      const updated = await api.saveNotificationChannel(channel, {
        enabled: cfg.enabled,
        config: cfg.config,
        reports: cfg.reports,
      });
      setConfigs(prev => ({ ...prev, [channel]: updated }));
      setSavedChannels(prev => new Set([...prev, channel]));
      toast(`${CHANNEL_META[channel]?.label ?? channel} settings saved`, 'success');
    } catch {
      toast('Failed to save — please try again', 'error');
    } finally {
      setSaving(prev => ({ ...prev, [channel]: false }));
    }
  };

  const runTest = async (channel: string, reportType: 'daily' | 'weekly') => {
    const cfg = configs[channel];
    setTesting(prev => ({ ...prev, [channel]: reportType }));
    try {
      await api.testNotificationChannel(channel, cfg.config, reportType);
      toast(`${reportType.charAt(0).toUpperCase() + reportType.slice(1)} test sent to ${CHANNEL_META[channel]?.label ?? channel}`, 'success');
    } catch {
      toast('Delivery failed — check your credentials', 'error');
    } finally {
      setTesting(prev => ({ ...prev, [channel]: null }));
    }
  };

  if (loading) return <div className="flex items-center justify-center py-16"><Spinner /></div>;

  return (
    <div className="space-y-4">
      {VISIBLE_CHANNELS.map(key => {
        const meta = CHANNEL_META[key];
        const cfg = configs[key] ?? { channel: key, enabled: false, config: {}, reports: { daily: true, weekly: true } };
        const isSaving = saving[key] ?? false;
        const testingType = testing[key] ?? null;
        const isConnected = savedChannels.has(key) && Object.values(cfg.config).some(Boolean);
        const fieldErrors = errors[key] ?? {};
        const allFieldsFilled = meta.fields.every(f => cfg.config[f.key]?.trim());

        // Build a summary of connected credentials (mask sensitive values)
        const connectedSummary = isConnected ? meta.fields
          .filter(f => cfg.config[f.key])
          .map(f => {
            const val = cfg.config[f.key];
            if (f.type === 'password') return `${f.label}: ••••••••`;
            if (f.key === 'webhook_url' || f.key === 'token') {
              return `${f.label}: ${val.slice(0, 28)}…`;
            }
            return `${f.label}: ${val}`;
          }) : [];

        return (
          <div key={key} className="bg-surface-1 ring-1 ring-surface-5 rounded-lg p-5">
            {/* Header row */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${isConnected ? 'bg-green-500/10' : 'bg-surface-3'}`}>
                  <svg className={`w-4 h-4 ${isConnected ? 'text-green-500' : 'text-text-secondary'}`} fill="currentColor" viewBox="0 0 24 24">
                    <path d={meta.icon} />
                  </svg>
                </div>
                <div>
                  <span className="text-sm font-semibold text-text-primary">{meta.label}</span>
                  {isConnected && <span className="ml-2 text-[10px] bg-green-500/10 text-green-500 px-1.5 py-0.5 rounded font-medium">Connected</span>}
                </div>
              </div>
              {/* Enable toggle */}
              <button
                onClick={() => update(key, { enabled: !cfg.enabled })}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${cfg.enabled ? 'bg-brand' : 'bg-surface-5'}`}
                aria-label={cfg.enabled ? 'Disable' : 'Enable'}
              >
                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${cfg.enabled ? 'translate-x-4' : 'translate-x-1'}`} />
              </button>
            </div>

            {/* Connected summary */}
            {isConnected && connectedSummary.length > 0 && (
              <div className="mb-4 bg-surface-2 ring-1 ring-surface-5 rounded-md px-3 py-2.5 space-y-1">
                {connectedSummary.map((line, i) => (
                  <p key={i} className="text-xs text-text-secondary font-mono">{line}</p>
                ))}
                <button
                  onClick={() => disconnect(key)}
                  disabled={isSaving}
                  className="mt-1.5 text-xs text-red-500 hover:text-red-400 transition-colors disabled:opacity-40"
                >
                  Remove connection
                </button>
              </div>
            )}

            {/* Credential fields */}
            <div className="space-y-3 mb-4">
              {meta.fields.map(field => (
                <div key={field.key}>
                  <label className="block text-xs font-medium text-text-secondary mb-1">
                    {field.label} <span className="text-red-500">*</span>
                  </label>
                  <input
                    type={field.type}
                    value={cfg.config[field.key] ?? ''}
                    onChange={e => {
                      updateField(key, field.key, e.target.value);
                      if (fieldErrors[field.key]) setErrors(prev => ({ ...prev, [key]: { ...prev[key], [field.key]: '' } }));
                    }}
                    placeholder={field.placeholder}
                    className={`w-full text-xs bg-surface-0 border rounded-md px-3 py-1.5 text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-brand ${fieldErrors[field.key] ? 'border-red-500' : 'border-surface-5'}`}
                  />
                  {fieldErrors[field.key] && (
                    <p className="mt-1 text-xs text-red-500">{fieldErrors[field.key]}</p>
                  )}
                </div>
              ))}
            </div>

            {/* Report type toggles */}
            <div className="flex items-center gap-4 mb-4">
              <span className="text-xs text-text-secondary">Reports:</span>
              {(['daily', 'weekly'] as const).map(rtype => (
                <label key={rtype} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cfg.reports[rtype] ?? true}
                    onChange={e => update(key, { reports: { ...cfg.reports, [rtype]: e.target.checked } })}
                    className="w-3.5 h-3.5 accent-brand rounded"
                  />
                  <span className="text-xs text-text-primary capitalize">{rtype}</span>
                </label>
              ))}
            </div>

            {/* Actions row */}
            <div className="flex items-center gap-2 flex-wrap">
              {(['daily', 'weekly'] as const).map(rtype => (
                <button
                  key={rtype}
                  onClick={() => runTest(key, rtype)}
                  disabled={!!testingType || !Object.values(cfg.config).some(Boolean)}
                  className="text-xs px-3 py-1.5 rounded-md border border-surface-5 text-text-secondary hover:text-text-primary hover:border-surface-7 transition-colors disabled:opacity-40 flex items-center gap-1.5"
                >
                  {testingType === rtype ? <><Spinner size="xs" /> Sending…</> : `Test ${rtype}`}
                </button>
              ))}
              <div className="flex-1" />
              <button
                onClick={() => save(key)}
                disabled={isSaving || !allFieldsFilled}
                className="text-xs px-4 py-1.5 bg-brand hover:bg-brand-dim text-white rounded-md transition-colors disabled:opacity-40 flex items-center gap-1.5"
              >
                {isSaving ? <><Spinner size="xs" /> Saving…</> : 'Save'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Ticket Properties tab ─────────────────────────────────────────────────────

const CATEGORY_OPTIONS = [
  { value: 'kyc_verification',    label: 'KYC Verification' },
  { value: 'account_restriction', label: 'Account Restriction' },
  { value: 'password_2fa_reset',  label: 'Password / 2FA Reset' },
  { value: 'fraud_security',      label: 'Fraud / Security' },
  { value: 'withdrawal_issue',    label: 'Transactions' },
  { value: 'unclassified',        label: 'Unclassified' },
];

const FIELD_TYPE_LABELS: Record<PropertyFieldType, string> = {
  single_select: 'Single Select',
  multi_select:  'Multi Select',
  text:          'Text',
  number:        'Number',
  boolean:       'Toggle',
};

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

const EMPTY_FORM = {
  name:        '',
  field_key:   '',
  field_type:  'single_select' as PropertyFieldType,
  applies_to:  [] as string[],
  is_required: false,
  options:     [{ value: '', label: '' }] as PropertyOption[],
};

function TicketPropertiesTab() {
  const { addToast } = useToast();
  const [defs, setDefs]             = useState<PropertyDefinition[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showForm, setShowForm]     = useState(false);
  const [editId, setEditId]         = useState<string | null>(null);
  const [form, setForm]             = useState({ ...EMPTY_FORM });
  const [keyTouched, setKeyTouched] = useState(false);
  const [saving, setSaving]         = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PropertyDefinition | null>(null);

  const load = () => {
    setLoading(true);
    api.getPropertyDefinitions(true)
      .then(setDefs)
      .catch(() => addToast('Failed to load property definitions', 'error'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const openCreate = () => {
    setEditId(null);
    setForm({ ...EMPTY_FORM });
    setKeyTouched(false);
    setShowForm(true);
  };

  const openEdit = (def: PropertyDefinition) => {
    setEditId(def.id);
    setForm({
      name:        def.name,
      field_key:   def.field_key,
      field_type:  def.field_type,
      applies_to:  def.applies_to ?? [],
      is_required: def.is_required,
      options:     def.options?.length ? def.options.map(o => ({ ...o })) : [{ value: '', label: '' }],
    });
    setKeyTouched(true);
    setShowForm(true);
  };

  const handleNameChange = (name: string) => {
    setForm(f => ({ ...f, name, field_key: keyTouched ? f.field_key : slugify(name) }));
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.field_key.trim()) {
      addToast('Name and field key are required', 'error'); return;
    }
    const needsOptions = form.field_type === 'single_select' || form.field_type === 'multi_select';
    const cleanOptions = needsOptions
      ? form.options.filter(o => o.label.trim()).map(o => ({
          value: o.value || slugify(o.label),
          label: o.label.trim(),
        }))
      : undefined;
    if (needsOptions && (!cleanOptions || cleanOptions.length === 0)) {
      addToast('Add at least one option for select types', 'error'); return;
    }
    setSaving(true);
    try {
      const payload = {
        name:          form.name.trim(),
        field_key:     form.field_key.trim(),
        field_type:    form.field_type,
        options:       cleanOptions ?? null,
        applies_to:    form.applies_to.length ? form.applies_to : null,
        is_required:   form.is_required,
        display_order: 0,
        is_active:     true,
      };
      if (editId) {
        await api.updatePropertyDefinition(editId, payload);
        addToast('Property updated', 'success');
      } else {
        await api.createPropertyDefinition(payload);
        addToast('Property created', 'success');
      }
      setShowForm(false);
      load();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (def: PropertyDefinition) => {
    try {
      await api.updatePropertyDefinition(def.id, { is_active: !def.is_active });
      setDefs(prev => prev.map(d => d.id === def.id ? { ...d, is_active: !d.is_active } : d));
    } catch {
      addToast('Failed to update property', 'error');
    }
  };

  const handleOrder = async (def: PropertyDefinition, dir: -1 | 1) => {
    const sorted = [...defs].sort((a, b) => a.display_order - b.display_order);
    const idx = sorted.findIndex(d => d.id === def.id);
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const newOrder = sorted[swapIdx].display_order;
    const swapOrder = def.display_order;
    try {
      await Promise.all([
        api.updatePropertyDefinition(def.id, { display_order: newOrder }),
        api.updatePropertyDefinition(sorted[swapIdx].id, { display_order: swapOrder }),
      ]);
      setDefs(prev => prev.map(d => {
        if (d.id === def.id) return { ...d, display_order: newOrder };
        if (d.id === sorted[swapIdx].id) return { ...d, display_order: swapOrder };
        return d;
      }));
    } catch { addToast('Failed to reorder', 'error'); }
  };

  const handleDelete = async (def: PropertyDefinition) => {
    try {
      const result = await api.deletePropertyDefinition(def.id);
      if (result.deactivated) {
        addToast('Property has existing values — deactivated instead of deleted', 'warning');
      } else {
        addToast('Property deleted', 'success');
      }
      setDeleteTarget(null);
      load();
    } catch {
      addToast('Failed to delete property', 'error');
    }
  };

  const sortedDefs = [...defs].sort((a, b) => a.display_order - b.display_order);

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-muted">
          {defs.filter(d => d.is_active).length} active · {defs.filter(d => !d.is_active).length} inactive
        </p>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 text-xs bg-brand hover:bg-brand-dim text-white px-3 py-2 rounded-lg transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Property
        </button>
      </div>

      {/* Create / Edit form */}
      {showForm && (
        <div className="rounded-xl border border-surface-5 bg-surface-1 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-text-primary">{editId ? 'Edit Property' : 'New Property'}</h3>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs text-text-muted">Display Name *</label>
              <input
                value={form.name}
                onChange={e => handleNameChange(e.target.value)}
                placeholder="e.g. KYC Sub-category"
                className="w-full text-sm bg-surface-2 ring-1 ring-surface-5 px-3 py-2 rounded-lg outline-none focus:ring-brand text-text-primary placeholder:text-text-muted"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-text-muted">Field Key * <span className="font-normal text-text-muted">(auto-generated)</span></label>
              <input
                value={form.field_key}
                onChange={e => { setKeyTouched(true); setForm(f => ({ ...f, field_key: e.target.value })); }}
                placeholder="kyc_sub_category"
                className="w-full text-sm font-mono bg-surface-2 ring-1 ring-surface-5 px-3 py-2 rounded-lg outline-none focus:ring-brand text-text-primary placeholder:text-text-muted"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs text-text-muted">Field Type *</label>
              <select
                value={form.field_type}
                onChange={e => setForm(f => ({ ...f, field_type: e.target.value as PropertyFieldType }))}
                className="w-full text-sm bg-surface-2 ring-1 ring-surface-5 px-3 py-2 rounded-lg outline-none focus:ring-brand text-text-primary"
                disabled={!!editId}
              >
                {(Object.keys(FIELD_TYPE_LABELS) as PropertyFieldType[]).map(t => (
                  <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>
                ))}
              </select>
              {editId && <p className="text-[10px] text-text-muted">Field type cannot be changed after creation.</p>}
            </div>
            <div className="space-y-1">
              <label className="text-xs text-text-muted">Required</label>
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={() => setForm(f => ({ ...f, is_required: !f.is_required }))}
                  className={`w-9 h-5 rounded-full transition-colors relative ${form.is_required ? 'bg-brand' : 'bg-surface-5'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${form.is_required ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </button>
                <span className="text-xs text-text-muted">{form.is_required ? 'Yes — amber warning if empty' : 'No'}</span>
              </div>
            </div>
          </div>

          {/* Applies To */}
          <div className="space-y-2">
            <label className="text-xs text-text-muted">Applies To <span className="font-normal">(leave empty = all categories)</span></label>
            <div className="flex flex-wrap gap-2">
              {CATEGORY_OPTIONS.map(cat => {
                const sel = form.applies_to.includes(cat.value);
                return (
                  <button
                    key={cat.value}
                    onClick={() => setForm(f => ({
                      ...f,
                      applies_to: sel
                        ? f.applies_to.filter(v => v !== cat.value)
                        : [...f.applies_to, cat.value],
                    }))}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      sel ? 'bg-brand text-white border-brand' : 'bg-surface-2 text-text-secondary border-surface-5 hover:border-brand/40'
                    }`}
                  >{cat.label}</button>
                );
              })}
            </div>
          </div>

          {/* Options editor */}
          {(form.field_type === 'single_select' || form.field_type === 'multi_select') && (
            <div className="space-y-2">
              <label className="text-xs text-text-muted">Options</label>
              <div className="space-y-1.5">
                {form.options.map((opt, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={opt.label}
                      onChange={e => {
                        const next = [...form.options];
                        next[i] = { value: slugify(e.target.value), label: e.target.value };
                        setForm(f => ({ ...f, options: next }));
                      }}
                      placeholder={`Option ${i + 1} label`}
                      className="flex-1 text-xs bg-surface-2 ring-1 ring-surface-5 px-2.5 py-1.5 rounded outline-none focus:ring-brand text-text-primary placeholder:text-text-muted"
                    />
                    <button
                      onClick={() => setForm(f => ({ ...f, options: f.options.filter((_, j) => j !== i) }))}
                      className="text-text-muted hover:text-brand transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => setForm(f => ({ ...f, options: [...f.options, { value: '', label: '' }] }))}
                  className="text-xs text-brand hover:text-brand-dim flex items-center gap-1 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add option
                </button>
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="text-xs bg-brand hover:bg-brand-dim text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              {saving ? <><Spinner size="xs" /> Saving…</> : (editId ? 'Save Changes' : 'Create Property')}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="text-xs px-4 py-2 rounded-lg border border-surface-5 text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
            >Cancel</button>
          </div>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="space-y-2">{[1,2,3].map(i => <div key={i} className="h-10 bg-surface-2 rounded animate-pulse" />)}</div>
      ) : sortedDefs.length === 0 ? (
        <div className="text-center py-12 text-text-muted text-sm">No properties defined yet.</div>
      ) : (
        <div className="rounded-xl border border-surface-5 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-surface-2 border-b border-surface-5">
                <th className="text-left px-4 py-2.5 text-text-muted font-medium">Name</th>
                <th className="text-left px-4 py-2.5 text-text-muted font-medium">Key</th>
                <th className="text-left px-4 py-2.5 text-text-muted font-medium">Type</th>
                <th className="text-left px-4 py-2.5 text-text-muted font-medium">Applies To</th>
                <th className="text-center px-4 py-2.5 text-text-muted font-medium">Req.</th>
                <th className="text-center px-4 py-2.5 text-text-muted font-medium">Active</th>
                <th className="text-center px-4 py-2.5 text-text-muted font-medium">Order</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {sortedDefs.map((def, idx) => (
                <tr key={def.id} className={`border-b border-surface-5 last:border-0 ${!def.is_active ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3 font-medium text-text-primary">{def.name}</td>
                  <td className="px-4 py-3 font-mono text-text-muted">{def.field_key}</td>
                  <td className="px-4 py-3 text-text-secondary">{FIELD_TYPE_LABELS[def.field_type]}</td>
                  <td className="px-4 py-3 text-text-secondary">
                    {def.applies_to?.length
                      ? def.applies_to.map(c => CATEGORY_OPTIONS.find(o => o.value === c)?.label ?? c).join(', ')
                      : <span className="italic text-text-muted">All</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-center">
                    {def.is_required
                      ? <span className="inline-block w-2 h-2 rounded-full bg-accent-amber" />
                      : <span className="text-text-muted">—</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => handleToggleActive(def)}
                      className={`w-9 h-5 rounded-full transition-colors relative ${def.is_active ? 'bg-brand' : 'bg-surface-5'}`}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${def.is_active ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => handleOrder(def, -1)} disabled={idx === 0}
                        className="p-0.5 text-text-muted hover:text-text-primary disabled:opacity-30 transition-colors">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                        </svg>
                      </button>
                      <button onClick={() => handleOrder(def, 1)} disabled={idx === sortedDefs.length - 1}
                        className="p-0.5 text-text-muted hover:text-text-primary disabled:opacity-30 transition-colors">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 justify-end">
                      <button onClick={() => openEdit(def)} className="text-text-muted hover:text-brand transition-colors" title="Edit">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                      <button onClick={() => setDeleteTarget(def)} className="text-text-muted hover:text-brand transition-colors" title="Delete">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-surface-0 rounded-xl border border-surface-5 shadow-xl p-6 w-96 space-y-4">
            <h3 className="text-sm font-semibold text-text-primary">Delete "{deleteTarget.name}"?</h3>
            <p className="text-xs text-text-muted">
              If this property has existing values on tickets it will be deactivated instead of permanently deleted. You can reactivate it any time.
            </p>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => handleDelete(deleteTarget)}
                className="text-xs bg-brand hover:bg-brand-dim text-white px-4 py-2 rounded-lg transition-colors"
              >Delete / Deactivate</button>
              <button
                onClick={() => setDeleteTarget(null)}
                className="text-xs px-4 py-2 rounded-lg border border-surface-5 text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
              >Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
