import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePerm } from '../PermissionContext';
import type { Ticket, TicketStatus, Priority, Agent } from '../types';
import { api } from '../api';
import CopilotPanel from './CopilotPanel';
import { Avatar } from './ui/Avatar';
import { StatusBadge, ChannelBadge, CategoryBadge, TagBadge } from './ui/Badge';
import { Tabs } from './ui/Tabs';
import { Select } from './ui/Select';
import { Skeleton } from './ui/Skeleton';

// ── Core API Panel ────────────────────────────────────────────────────────────

type CoreProfile = Awaited<ReturnType<typeof api.getCoreProfile>>;

function CoreApiPanel({ bitazzaUid }: { bitazzaUid: string }) {
  const [data, setData]   = useState<CoreProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true); setError(''); setData(null);
    api.getCoreProfile(bitazzaUid)
      .then(setData)
      .catch(e => setError(e instanceof Error ? e.message : 'Unavailable'))
      .finally(() => setLoading(false));
  }, [bitazzaUid]);

  return (
    <div className="space-y-3">
      <SectionHeading>Live Account</SectionHeading>

      {loading && (
        <div className="space-y-2">
          {[1,2,3].map(i => <Skeleton key={i} className="h-3 w-full" />)}
        </div>
      )}
      {error && <p className="text-xs text-text-muted italic">{error}</p>}
      {data && !loading && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <PropRow label="KYC Status" value={`${data.kyc_status} (L${data.kyc_level})`} />
            <PropRow label="Account"    value={data.account_status} />
          </div>
          {data.balances?.length > 0 && (
            <div>
              <p className="text-[10px] text-text-muted uppercase tracking-wide mb-1.5">Balances</p>
              <div className="space-y-1">
                {data.balances.slice(0, 5).map(b => (
                  <div key={b.currency} className="flex justify-between text-xs">
                    <span className="text-text-muted font-mono">{b.currency}</span>
                    <span className="text-text-primary font-mono tabular-nums">
                      {b.available.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {data.recent_transactions?.length > 0 && (
            <div>
              <p className="text-[10px] text-text-muted uppercase tracking-wide mb-1.5">Recent Transactions</p>
              <div className="space-y-1.5">
                {data.recent_transactions.slice(0, 4).map(tx => (
                  <div key={tx.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-text-muted shrink-0 capitalize">{tx.type}</span>
                    <span className="text-text-primary truncate font-mono tabular-nums">
                      {tx.amount.toLocaleString()} {tx.currency}
                    </span>
                    <span className={`shrink-0 text-[10px] font-medium ${
                      tx.status === 'completed' ? 'text-accent-green' : 'text-text-muted'
                    }`}>{tx.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Status/Priority options ───────────────────────────────────────────────────

const STATUS_OPTIONS: TicketStatus[] = [
  'Open_Live', 'In_Progress', 'Pending_Customer',
  'Closed_Resolved', 'Closed_Unresponsive', 'Orphaned', 'Escalated',
];

const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: 1, label: 'VIP — 1 min SLA' },
  { value: 2, label: 'High — 3 min SLA' },
  { value: 3, label: 'Standard — 10 min SLA' },
];

interface Props {
  ticket: Ticket;
  onUpdate: () => void;
  partialDraft?: string;
  onAcceptDraft?: (text: string) => void;
  onSelectTicket?: (ticketId: string) => void;
}

// ── Tab definitions ───────────────────────────────────────────────────────────

const PANEL_TABS = [
  { id: 'details',  label: 'Details'  },
  { id: 'copilot',  label: 'AI Copilot' },
];

export default function PropertiesPanel({ ticket, onUpdate, partialDraft = '', onAcceptDraft, onSelectTicket }: Props) {
  const canAssign      = usePerm('inbox.assign');
  const canSetPriority = usePerm('inbox.set_priority');
  const canSetTags     = usePerm('inbox.set_tags');
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'details' | 'copilot'>('details');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showReassign, setShowReassign] = useState(false);
  const [handoffNote, setHandoffNote] = useState('');
  const [reassigning, setReassigning] = useState(false);
  const [tags, setTags] = useState<string[]>(ticket.tags ?? []);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');

  useEffect(() => {
    api.getAgents().then(setAgents).catch(() => {});
    api.getTags().then(setAllTags).catch(() => {});
  }, []);

  useEffect(() => { setTags(ticket.tags ?? []); }, [ticket.id]);

  const handleStatus = async (status: TicketStatus) => {
    try { await api.setStatus(ticket.id, status); onUpdate(); } catch { /* silent */ }
  };

  const handlePriority = async (priority: Priority) => {
    try { await api.setPriority(ticket.id, priority); onUpdate(); } catch { /* silent */ }
  };

  const handleReassign = async (agentId: string) => {
    setReassigning(true);
    try {
      await api.assign(ticket.id, agentId, undefined, handoffNote || undefined);
      setShowReassign(false);
      setHandoffNote('');
      onUpdate();
    } catch { /* silent */ } finally { setReassigning(false); }
  };

  const toggleTag = async (tag: string) => {
    const next = tags.includes(tag) ? tags.filter(t => t !== tag) : [...tags, tag];
    setTags(next);
    try { await api.setTags(ticket.id, next); } catch { setTags(tags); }
  };

  const addCustomTag = async () => {
    const t = newTag.trim().toLowerCase().replace(/\s+/g, '_');
    if (!t || tags.includes(t)) return;
    setNewTag('');
    if (!allTags.includes(t)) setAllTags(prev => [...prev, t]);
    await toggleTag(t);
  };

  const isAiHandled = !ticket.assigned_to && !ticket.assigned_agent_id;
  const aiPersonaName = ticket.ai_persona?.ai_name;
  const assignedName = ticket.assigned_to_name ?? ticket.assigned_agent_name
    ?? (isAiHandled ? (aiPersonaName ? `AI Bot: ${aiPersonaName}` : 'AI Bot') : 'Unassigned');
  const tier = ticket.customer?.tier ?? 'Standard';

  return (
    <aside className="w-[280px] shrink-0 bg-surface-1 border-l border-surface-5 flex flex-col overflow-hidden">

      {/* Tabs */}
      <Tabs
        tabs={PANEL_TABS}
        activeId={activeTab}
        onChange={id => setActiveTab(id as typeof activeTab)}
        className="px-1 shrink-0"
      />

      <div className="flex-1 overflow-y-auto">

        {/* ── Details Tab ── */}
        {activeTab === 'details' && (
          <div className="divide-y divide-surface-5">

            {/* Customer section */}
            <Section>
              <SectionHeading>Customer</SectionHeading>
              <div className="flex items-center gap-2.5 mb-3">
                <Avatar name={ticket.customer?.name ?? 'U'} size="md" />
                <div className="min-w-0 flex-1">
                  <button
                    className="text-sm font-semibold text-text-primary truncate hover:text-brand hover:underline text-left w-full"
                    onClick={() => {
                      const uid = ticket.customer?.bitazza_uid ?? ticket.customer?.user_id;
                      if (uid) navigate(`/users?uid=${uid}`);
                    }}
                  >{ticket.customer?.name ?? '—'}</button>
                  <div className="text-xs text-text-muted truncate">{ticket.customer?.email ?? '—'}</div>
                </div>
                {tier !== 'Standard' && (
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
                    tier === 'VIP' ? 'bg-brand/10 text-brand' : 'bg-accent-amber/10 text-accent-amber'
                  }`}>{tier}</span>
                )}
              </div>
              <div className="space-y-1.5">
                <PropRow label="UID"         value={ticket.customer?.bitazza_uid ?? ticket.customer?.user_id ?? '—'} mono />
                <PropRow label="KYC"         value={ticket.customer?.kyc_status ?? '—'} />
                <PropRow label="KYC Tier"    value={ticket.customer?.kyc_tier != null ? `Tier ${ticket.customer.kyc_tier}` : '—'} />
                <PropRow label="Past tickets" value={String(ticket.customer?.past_conversation_count ?? 0)} />
              </div>
            </Section>

            {/* Ticket controls */}
            <Section>
              <SectionHeading>Ticket</SectionHeading>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-text-muted">Status</span>
                  <StatusBadge status={ticket.status} dot size="xs" />
                </div>

                <Select
                  value={ticket.status}
                  options={STATUS_OPTIONS.map(s => ({ value: s, label: s.replace(/_/g, ' ') }))}
                  onChange={v => handleStatus(v as TicketStatus)}
                />

                {canSetPriority && (
                  <Select
                    label="Priority"
                    value={String(ticket.priority)}
                    options={PRIORITY_OPTIONS.map(p => ({ value: String(p.value), label: p.label }))}
                    onChange={v => handlePriority(Number(v) as Priority)}
                  />
                )}

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-text-muted">Assigned to</span>
                    {canAssign && (
                      <button
                        onClick={() => setShowReassign(v => !v)}
                        className="text-[10px] text-brand hover:text-brand-dim transition-colors font-medium"
                      >
                        {showReassign ? 'Cancel' : 'Reassign'}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {isAiHandled ? (
                      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-brand/10 text-brand shrink-0">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/>
                        </svg>
                      </span>
                    ) : assignedName !== 'Unassigned' ? (
                      <Avatar name={assignedName} size="xs" />
                    ) : null}
                    <span className={`text-xs ${isAiHandled ? 'text-brand font-medium' : 'text-text-primary'}`}>{assignedName}</span>
                  </div>
                </div>

                {/* Reassign panel */}
                {showReassign && (
                  <div className="bg-surface-3 ring-1 ring-surface-5 rounded-lg p-3 space-y-2 animate-slide-in-up">
                    <p className="text-xs font-medium text-text-secondary">Select agent</p>
                    <div className="space-y-0.5 max-h-32 overflow-y-auto">
                      {agents.length === 0 && (
                        <p className="text-xs text-text-muted">No agents available</p>
                      )}
                      {agents
                        .filter(a => (a.state ?? a.status) !== 'Offline')
                        .map(a => {
                          const active = a.active_chats ?? a.active_conversation_count ?? 0;
                          const max = a.max_chats ?? a.max_capacity ?? 3;
                          const full = active >= max;
                          return (
                            <button key={a.id} onClick={() => !full && handleReassign(a.id)}
                              disabled={reassigning || full}
                              className={`w-full text-left text-xs px-2 py-1.5 rounded flex items-center gap-2 transition-colors ${
                                full ? 'opacity-40 cursor-not-allowed' : 'hover:bg-surface-4'
                              }`}
                            >
                              <Avatar name={a.name} size="xs" />
                              <span className="flex-1 truncate text-text-primary">{a.name}</span>
                              <span className="text-text-muted shrink-0 tabular-nums font-mono text-[10px]">{active}/{max}</span>
                            </button>
                          );
                        })}
                    </div>
                    <textarea
                      value={handoffNote}
                      onChange={e => setHandoffNote(e.target.value)}
                      placeholder="Handoff note (optional)…"
                      className="w-full text-xs bg-surface-2 ring-1 ring-surface-5 px-2 py-1.5 resize-none outline-none focus:ring-brand rounded transition-all text-text-primary placeholder:text-text-muted"
                      rows={2}
                    />
                  </div>
                )}
              </div>
            </Section>

            {/* Info section */}
            <Section>
              <SectionHeading>Info</SectionHeading>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-muted">Channel</span>
                  <ChannelBadge channel={ticket.channel as any} size="xs" />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-muted">Category</span>
                  {ticket.category ? (
                    <CategoryBadge category={ticket.category as any} size="xs" />
                  ) : <span className="text-xs text-text-muted">—</span>}
                </div>
                <PropRow label="Created" value={ticket.created_at ? new Date(
                  typeof ticket.created_at === 'number' ? ticket.created_at * 1000 : ticket.created_at
                ).toLocaleString() : '—'} />
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-muted">CSAT</span>
                  {ticket.csat_score != null ? (
                    <span className={`text-xs font-medium flex items-center gap-1 ${
                      ticket.csat_score >= 4 ? 'text-accent-green' :
                      ticket.csat_score === 3 ? 'text-accent-amber' : 'text-brand'
                    }`}>
                      {'★'.repeat(ticket.csat_score)}{'☆'.repeat(5 - ticket.csat_score)}
                      <span className="text-text-muted font-normal ml-0.5">({ticket.csat_score}/5)</span>
                    </span>
                  ) : (
                    <span className="text-xs text-text-muted">—</span>
                  )}
                </div>
              </div>
            </Section>

            {/* Tags */}
            {canSetTags && <Section>
              <SectionHeading>Tags</SectionHeading>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {allTags.map(tag => (
                  <button key={tag} onClick={() => toggleTag(tag)}>
                    <TagBadge
                      label={tag}
                      size="xs"
                    />
                  </button>
                ))}
                {allTags.length === 0 && (
                  <span className="text-xs text-text-muted">No tags available</span>
                )}
              </div>
              {/* Active tags */}
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {tags.map(tag => (
                    <TagBadge key={tag} label={tag} size="xs" onRemove={() => toggleTag(tag)} />
                  ))}
                </div>
              )}
              <div className="flex gap-1">
                <input
                  value={newTag}
                  onChange={e => setNewTag(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addCustomTag()}
                  placeholder="Add tag…"
                  className="flex-1 text-xs bg-surface-2 ring-1 ring-surface-5 px-2.5 py-1.5 rounded outline-none focus:ring-brand transition-all text-text-primary placeholder:text-text-muted"
                />
                <button onClick={addCustomTag}
                  className="text-xs bg-surface-3 ring-1 ring-surface-5 px-3 py-1.5 rounded hover:bg-surface-4 transition-colors text-text-secondary">
                  Add
                </button>
              </div>
            </Section>}

            {/* Live Account (Core API) */}
            {ticket.customer?.bitazza_uid && (
              <Section>
                <CoreApiPanel bitazzaUid={ticket.customer.bitazza_uid} />
              </Section>
            )}

          </div>
        )}

        {/* ── AI Copilot Tab ── */}
        {activeTab === 'copilot' && (
          <CopilotPanel ticketId={ticket.id} partialDraft={partialDraft} onAcceptDraft={onAcceptDraft} onSelectTicket={onSelectTicket} />
        )}
      </div>
    </aside>
  );
}

// ── Helper sub-components ─────────────────────────────────────────────────────

function Section({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-4 space-y-3">{children}</div>;
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">{children}</h3>
  );
}

function PropRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="text-xs text-text-muted shrink-0">{label}</span>
      <span className={`text-xs text-text-primary truncate text-right max-w-[140px] ${mono ? 'font-mono text-[10px]' : ''}`}>
        {value}
      </span>
    </div>
  );
}
