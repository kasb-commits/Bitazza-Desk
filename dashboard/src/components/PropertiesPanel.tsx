import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { usePerm } from '../PermissionContext';
import type { Ticket, TicketStatus, Priority, Agent, PropertyDefinition, PropertyValuesMap } from '../types';
import { api } from '../api';
import CopilotPanel from './CopilotPanel';
import { Avatar } from './ui/Avatar';
import { StatusBadge, ChannelBadge, CategoryBadge, TagBadge } from './ui/Badge';
import { Select } from './ui/Select';
import { Skeleton } from './ui/Skeleton';

// ── Core API Panel ────────────────────────────────────────────────────────────

type CoreProfile = Awaited<ReturnType<typeof api.getCoreProfile>>;

function CoreApiPanel({ bitazzaUid }: { bitazzaUid: string }) {
  const [data, setData]       = useState<CoreProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

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
      {error && <p className="text-xs italic" style={{ color: '#9ca3af' }}>{error}</p>}
      {data && !loading && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <PropRow label="KYC Status" value={`${data.kyc_status} (L${data.kyc_level})`} />
            <PropRow label="Account"    value={data.account_status} />
          </div>
          {data.balances?.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: '#9ca3af' }}>Balances</p>
              <div className="space-y-1">
                {data.balances.slice(0, 5).map(b => (
                  <div key={b.currency} className="flex justify-between text-xs">
                    <span className="font-mono" style={{ color: '#6b7280' }}>{b.currency}</span>
                    <span className="font-mono tabular-nums" style={{ color: '#111827' }}>
                      {b.available.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {data.recent_transactions?.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: '#9ca3af' }}>Recent Transactions</p>
              <div className="space-y-1.5">
                {data.recent_transactions.slice(0, 4).map(tx => (
                  <div key={tx.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="shrink-0 capitalize" style={{ color: '#6b7280' }}>{tx.type}</span>
                    <span className="truncate font-mono tabular-nums" style={{ color: '#111827' }}>
                      {tx.amount.toLocaleString()} {tx.currency}
                    </span>
                    <span className="shrink-0 text-[10px] font-medium" style={{
                      color: tx.status === 'completed' ? '#16a34a' : '#9ca3af'
                    }}>{tx.status}</span>
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

// ── Reassign confirmation modal ───────────────────────────────────────────────

function ReassignModal({
  agent,
  note,
  onNoteChange,
  loading,
  onConfirm,
  onCancel,
}: {
  agent: Agent;
  note: string;
  onNoteChange: (v: string) => void;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center z-[9999]"
      style={{ background: 'rgba(0,0,0,0.35)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className="rounded-2xl p-5 w-72 space-y-4 animate-scale-in"
        style={{ background: '#ffffff', boxShadow: '0 20px 60px rgba(0,0,0,0.18)', border: '1px solid #e8ecf2' }}
      >
        <div>
          <p className="text-sm font-semibold mb-0.5" style={{ color: '#111827' }}>Reassign ticket?</p>
          <p className="text-xs" style={{ color: '#6b7280' }}>This conversation will be moved to:</p>
        </div>

        <div className="flex items-center gap-2.5 rounded-xl p-2.5" style={{ background: '#f5f3ff', border: '1px solid #ede9fe' }}>
          <Avatar name={agent.name} size="sm" />
          <div className="min-w-0">
            <p className="text-xs font-semibold truncate" style={{ color: '#111827' }}>{agent.name}</p>
            <p className="text-[10px]" style={{ color: '#6b7280' }}>
              {(agent.active_chats ?? agent.active_conversation_count ?? 0)} active chats
            </p>
          </div>
        </div>

        <div>
          <label className="text-[10px] font-medium uppercase tracking-wide block mb-1" style={{ color: '#9ca3af' }}>
            Handoff note (optional)
          </label>
          <textarea
            value={note}
            onChange={e => onNoteChange(e.target.value)}
            placeholder="Add context for the new agent…"
            rows={2}
            className="w-full text-xs px-2.5 py-2 rounded-lg outline-none resize-none transition-all"
            style={{ background: '#f9fafb', border: '1px solid #e5e7eb', color: '#111827' }}
            onFocus={e => { e.currentTarget.style.borderColor = '#6366f1'; }}
            onBlur={e => { e.currentTarget.style.borderColor = '#e5e7eb'; }}
          />
        </div>

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 text-xs py-2 rounded-lg transition-colors font-medium"
            style={{ background: '#f3f4f6', border: '1px solid #e5e7eb', color: '#374151' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="flex-1 text-xs py-2 rounded-lg transition-colors font-semibold disabled:opacity-50"
            style={{ background: '#6366f1', color: '#ffffff' }}
          >
            {loading ? 'Reassigning…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  ticket: Ticket;
  onUpdate: () => void;
  partialDraft?: string;
  onAcceptDraft?: (text: string) => void;
  onSelectTicket?: (ticketId: string) => void;
  knownTags?: string[];   // all unique tags seen across all tickets in the inbox
}

export default function PropertiesPanel({ ticket, onUpdate, partialDraft = '', onAcceptDraft, onSelectTicket, knownTags = [] }: Props) {
  const canAssign      = usePerm('inbox.assign');
  const canSetPriority = usePerm('inbox.set_priority');
  const canSetTags     = usePerm('inbox.set_tags');
  const navigate = useNavigate();

  const [agents, setAgents]         = useState<Agent[]>([]);
  const [showAgentList, setShowAgentList] = useState(false);
  const [pendingAgent, setPendingAgent]   = useState<Agent | null>(null);
  const [handoffNote, setHandoffNote]     = useState('');
  const [reassigning, setReassigning]     = useState(false);
  const [tags, setTags]             = useState<string[]>(ticket.tags ?? []);
  const [allTags, setAllTags]       = useState<string[]>([]);
  const [newTag, setNewTag]         = useState('');
  const assigneeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getAgents().then(setAgents).catch(() => {});
    api.getTags().then(setAllTags).catch(() => {});
  }, [ticket.id]);

  useEffect(() => { setTags(ticket.tags ?? []); }, [ticket.id]);

  // Close agent list when clicking outside
  useEffect(() => {
    if (!showAgentList) return;
    const handler = (e: MouseEvent) => {
      if (assigneeRef.current && !assigneeRef.current.contains(e.target as Node)) {
        setShowAgentList(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAgentList]);

  const handleStatus = async (status: TicketStatus) => {
    try { await api.setStatus(ticket.id, status); onUpdate(); } catch { /* silent */ }
  };

  const handlePriority = async (priority: Priority) => {
    try { await api.setPriority(ticket.id, priority); onUpdate(); } catch { /* silent */ }
  };

  const confirmReassign = async () => {
    if (!pendingAgent) return;
    setReassigning(true);
    try {
      await api.assign(ticket.id, pendingAgent.id, undefined, handoffNote || undefined);
      setPendingAgent(null);
      setHandoffNote('');
      setShowAgentList(false);
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

  const isAiHandled   = !ticket.assigned_to && !ticket.assigned_agent_id;
  const aiPersonaName = ticket.ai_persona?.ai_name;
  const assignedName  = ticket.assigned_to_name ?? ticket.assigned_agent_name
    ?? (isAiHandled ? (aiPersonaName ? `AI Bot: ${aiPersonaName}` : 'AI Bot') : 'Unassigned');
  const tier = ticket.customer?.tier ?? 'Standard';
  const availableAgents = agents.filter(a => (a.state ?? a.status) !== 'Offline');

  return (
    <aside className="w-[364px] shrink-0 bg-white flex flex-col overflow-hidden" data-theme="light"
      style={{ borderLeft: '1px solid rgba(180,195,220,0.35)', position: 'relative', zIndex: 1 }}
    >
      <div className="flex-1 overflow-y-auto" style={{ background: '#f4f6f9' }}>
        <div className="p-3 space-y-3">

          {/* ── Customer ── */}
          <Section>
            <SectionHeading>Customer</SectionHeading>
            <div className="flex items-center gap-2.5">
              <Avatar name={ticket.customer?.name ?? 'U'} size="md" />
              <div className="min-w-0 flex-1">
                <button
                  className="text-sm font-semibold truncate hover:underline text-left w-full transition-colors"
                  style={{ color: '#111827' }}
                  onClick={() => {
                    const uid = ticket.customer?.bitazza_uid ?? ticket.customer?.user_id;
                    if (uid) navigate(`/users?uid=${uid}`);
                  }}
                >{ticket.customer?.name ?? '—'}</button>
                <div className="text-xs truncate" style={{ color: '#6b7280' }}>{ticket.customer?.email ?? '—'}</div>
              </div>
              {tier !== 'Standard' && (
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
                  tier === 'VIP' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'
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

          {/* ── Ticket ── */}
          <Section>
            <SectionHeading>Ticket</SectionHeading>
            <div className="space-y-3">

              {/* Status row + select */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs" style={{ color: '#6b7280' }}>Status</span>
                <StatusBadge status={ticket.status} dot size="xs" />
              </div>
              <Select
                value={ticket.status}
                options={STATUS_OPTIONS.map(s => ({ value: s, label: s.replace(/_/g, ' ') }))}
                onChange={v => handleStatus(v as TicketStatus)}
              />

              {/* Priority */}
              {canSetPriority && (
                <Select
                  label="Priority"
                  value={String(ticket.priority)}
                  options={PRIORITY_OPTIONS.map(p => ({ value: String(p.value), label: p.label }))}
                  onChange={v => handlePriority(Number(v) as Priority)}
                />
              )}

              {/* Assignee drilldown */}
              <div ref={assigneeRef}>
                <span className="text-xs block mb-1.5" style={{ color: '#6b7280' }}>Assigned to</span>

                {/* Trigger row */}
                <button
                  disabled={!canAssign}
                  onClick={() => canAssign && setShowAgentList(v => !v)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md transition-colors text-left"
                  style={{
                    background: showAgentList ? '#f9fafb' : '#ffffff',
                    border: '1px solid #e5e7eb',
                    cursor: canAssign ? 'pointer' : 'default',
                  }}
                >
                  {isAiHandled ? (
                    <span className="flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 shrink-0">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#6366f1' }}>
                        <rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/>
                      </svg>
                    </span>
                  ) : assignedName !== 'Unassigned' ? (
                    <Avatar name={assignedName} size="xs" />
                  ) : (
                    <span className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center" style={{ background: '#f3f4f6', border: '1px dashed #d1d5db' }}>
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: '#9ca3af' }}>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
                      </svg>
                    </span>
                  )}
                  <span className="flex-1 text-xs truncate" style={{ color: isAiHandled ? '#6366f1' : '#111827', fontWeight: isAiHandled ? 500 : 400 }}>
                    {assignedName}
                  </span>
                  {canAssign && (
                    <svg className={`w-3.5 h-3.5 shrink-0 transition-transform ${showAgentList ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: '#9ca3af' }}>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/>
                    </svg>
                  )}
                </button>

                {/* Inline agent list */}
                {showAgentList && (
                  <div className="mt-1 rounded-lg overflow-hidden animate-slide-in-up" style={{ border: '1px solid #e5e7eb', background: '#ffffff', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}>
                    {availableAgents.length === 0 ? (
                      <p className="text-xs px-3 py-2.5" style={{ color: '#9ca3af' }}>No agents available</p>
                    ) : (
                      <div className="max-h-44 overflow-y-auto">
                        {availableAgents.map(a => {
                          const active = a.active_chats ?? a.active_conversation_count ?? 0;
                          const max    = a.max_chats ?? a.max_capacity ?? 3;
                          const full   = active >= max;
                          const isCurrent = (ticket.assigned_to ?? ticket.assigned_agent_id) === a.id;
                          return (
                            <button
                              key={a.id}
                              disabled={full}
                              onClick={() => { if (!full) { setPendingAgent(a); setShowAgentList(false); } }}
                              className="w-full flex items-center gap-2.5 px-3 py-2 transition-colors text-left"
                              style={{
                                opacity: full ? 0.4 : 1,
                                cursor: full ? 'not-allowed' : 'pointer',
                                background: isCurrent ? '#f5f3ff' : 'transparent',
                              }}
                              onMouseEnter={e => { if (!full && !isCurrent) (e.currentTarget as HTMLButtonElement).style.background = '#f9fafb'; }}
                              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = isCurrent ? '#f5f3ff' : 'transparent'; }}
                            >
                              <Avatar name={a.name} size="xs" />
                              <span className="flex-1 text-xs truncate" style={{ color: '#111827', fontWeight: isCurrent ? 600 : 400 }}>{a.name}</span>
                              <span className="text-[10px] font-mono shrink-0" style={{ color: full ? '#ef4444' : '#9ca3af' }}>{active}/{max}</span>
                              {isCurrent && (
                                <svg className="w-3 h-3 shrink-0" fill="currentColor" viewBox="0 0 20 20" style={{ color: '#6366f1' }}>
                                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/>
                                </svg>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>

            </div>
          </Section>

          {/* ── Info ── */}
          <Section>
            <SectionHeading>Info</SectionHeading>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs" style={{ color: '#6b7280' }}>Channel</span>
                <ChannelBadge channel={ticket.channel as any} size="xs" />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs" style={{ color: '#6b7280' }}>Category</span>
                {ticket.category
                  ? <CategoryBadge category={ticket.category as any} size="xs" />
                  : <span className="text-xs" style={{ color: '#9ca3af' }}>—</span>
                }
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs" style={{ color: '#6b7280' }}>Source</span>
                <span className="text-xs font-medium" style={{ color: ticket.source ? '#111827' : '#9ca3af' }}>
                  {ticket.source ?? '—'}
                </span>
              </div>
              <PropRow label="Created" value={ticket.created_at ? new Date(
                typeof ticket.created_at === 'number' ? ticket.created_at * 1000 : ticket.created_at
              ).toLocaleString() : '—'} />
              <div className="flex items-center justify-between">
                <span className="text-xs" style={{ color: '#6b7280' }}>CSAT</span>
                {ticket.csat_score != null ? (
                  <span className="text-xs font-medium flex items-center gap-1" style={{
                    color: ticket.csat_score >= 4 ? '#16a34a' : ticket.csat_score === 3 ? '#d97706' : '#dc2626'
                  }}>
                    {'★'.repeat(ticket.csat_score)}{'☆'.repeat(5 - ticket.csat_score)}
                    <span className="font-normal ml-0.5" style={{ color: '#9ca3af' }}>({ticket.csat_score}/5)</span>
                  </span>
                ) : (
                  <span className="text-xs" style={{ color: '#9ca3af' }}>—</span>
                )}
              </div>
            </div>
          </Section>

          {/* ── Ticket Properties ── */}
          <TicketPropertiesSection ticketId={ticket.id} category={ticket.category ?? ''} />

          {/* ── Tags ── */}
          <Section>
            <SectionHeading>Tags</SectionHeading>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {tags.map(tag => (
                  <TagBadge key={tag} label={tag} size="xs" onRemove={canSetTags ? () => toggleTag(tag) : undefined} />
                ))}
              </div>
            )}
            {tags.length === 0 && (
              <span className="text-xs" style={{ color: '#9ca3af' }}>No tags on this ticket</span>
            )}
            {canSetTags && (
              <>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {[...new Set([...allTags, ...knownTags])].filter(t => !tags.includes(t)).map(tag => (
                    <button key={tag} onClick={() => toggleTag(tag)} className="opacity-60 hover:opacity-100 transition-opacity">
                      <TagBadge label={tag} size="xs" />
                    </button>
                  ))}
                  {[...new Set([...allTags, ...knownTags])].filter(t => !tags.includes(t)).length === 0 && tags.length === 0 && (
                    <span className="text-xs" style={{ color: '#9ca3af' }}>No tags available</span>
                  )}
                </div>
                <div className="flex gap-1">
                  <input
                    value={newTag}
                    onChange={e => setNewTag(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addCustomTag()}
                    placeholder="Add tag…"
                    className="flex-1 text-xs px-2.5 py-1.5 rounded outline-none transition-all"
                    style={{ background: '#ffffff', border: '1px solid #e5e7eb', color: '#111827' }}
                  />
                  <button
                    onClick={addCustomTag}
                    className="text-xs px-3 py-1.5 rounded transition-colors"
                    style={{ background: '#f3f4f6', border: '1px solid #e5e7eb', color: '#374151' }}
                  >
                    Add
                  </button>
                </div>
              </>
            )}
          </Section>

          {/* ── Live Account (Core API) ── */}
          {ticket.customer?.bitazza_uid && (
            <Section>
              <CoreApiPanel bitazzaUid={ticket.customer.bitazza_uid} />
            </Section>
          )}

          {/* ── AI Copilot ── */}
          <div
            className="rounded-xl overflow-hidden"
            style={{ background: '#ffffff', border: '1px solid #e8ecf2', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}
          >
            <div className="px-3 py-2.5 flex items-center gap-1.5" style={{ background: '#f5f3ff', borderBottom: '1px solid #ede9fe' }}>
              <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#6366f1' }}>
                <path d="M12 2a7 7 0 0 1 7 7c0 4-3 6-5 8H10c-2-2-5-4-5-8a7 7 0 0 1 7-7z"/><line x1="9" y1="17" x2="15" y2="17"/><line x1="9" y1="20" x2="15" y2="20"/>
              </svg>
              <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: '#6366f1' }}>AI Copilot</span>
            </div>
            <CopilotPanel ticketId={ticket.id} partialDraft={partialDraft} onAcceptDraft={onAcceptDraft} onSelectTicket={onSelectTicket} />
          </div>

        </div>
      </div>

      {/* ── Reassign confirmation modal (portaled) ── */}
      {pendingAgent && (
        <ReassignModal
          agent={pendingAgent}
          note={handoffNote}
          onNoteChange={setHandoffNote}
          loading={reassigning}
          onConfirm={confirmReassign}
          onCancel={() => { setPendingAgent(null); setHandoffNote(''); }}
        />
      )}
    </aside>
  );
}

// ── Helper sub-components ─────────────────────────────────────────────────────

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl p-3 space-y-3"
      style={{ background: '#ffffff', border: '1px solid #e8ecf2', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}
    >
      {children}
    </div>
  );
}

// ── Ticket Properties Section ─────────────────────────────────────────────────

function TicketPropertiesSection({ ticketId, category }: { ticketId: string; category: string }) {
  const [defs, setDefs]       = useState<PropertyDefinition[]>([]);
  const [vals, setVals]       = useState<PropertyValuesMap>({});
  const [saving, setSaving]   = useState<string | null>(null);
  // Local draft for text/number fields — avoids re-render-on-save deselect bug
  const [drafts, setDrafts]   = useState<Record<string, string>>({});

  useEffect(() => {
    api.getPropertyDefinitions(false).then(setDefs).catch(() => {});
    api.getTicketPropertyValues(ticketId)
      .then(v => { setVals(v); setDrafts({}); })
      .catch(() => {});
  }, [ticketId]);

  const relevant = defs.filter(d =>
    d.is_active && (d.applies_to == null || d.applies_to.length === 0 || d.applies_to.includes(category))
  ).sort((a, b) => a.display_order - b.display_order);

  if (relevant.length === 0) return null;

  const getCommittedValue = (def: PropertyDefinition): string | string[] | null => {
    const v = vals[def.id];
    if (!v) return null;
    if (def.field_type === 'multi_select') return v.value_array ?? null;
    if (def.field_type === 'number') return v.value_number != null ? String(v.value_number) : null;
    return v.value_text ?? null;
  };

  const handleChange = async (def: PropertyDefinition, value: string | string[] | null) => {
    setSaving(def.id);
    try {
      const updated = await api.setTicketPropertyValue(ticketId, def.id, value);
      setVals(prev => ({ ...prev, [def.id]: updated }));
    } catch {
      // silent
    } finally {
      setSaving(null);
    }
  };

  const handleTextBlur = (def: PropertyDefinition) => {
    const draft = drafts[def.id];
    if (draft === undefined) return; // no local edit — nothing to save
    handleChange(def, draft || null);
    setDrafts(prev => { const n = { ...prev }; delete n[def.id]; return n; });
  };

  return (
    <Section>
      <SectionHeading>Properties</SectionHeading>
      <div className="space-y-3">
        {relevant.map(def => {
          const committed = getCommittedValue(def);
          // For text/number show local draft while typing, fall back to committed
          const displayVal = (def.field_type === 'text' || def.field_type === 'number')
            ? (drafts[def.id] !== undefined ? drafts[def.id] : (committed as string) ?? '')
            : committed;
          const isSaving = saving === def.id;
          const isEmpty = committed == null || (Array.isArray(committed) ? committed.length === 0 : committed === '');
          return (
            <div key={def.id}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-medium" style={{ color: def.is_required && isEmpty ? '#d97706' : '#6b7280' }}>
                  {def.name}{def.is_required && isEmpty ? ' *' : ''}
                </span>
                {isSaving && <span className="text-[9px]" style={{ color: '#9ca3af' }}>saving…</span>}
              </div>

              {def.field_type === 'single_select' && (
                <select
                  value={(displayVal as string) ?? ''}
                  onChange={e => handleChange(def, e.target.value || null)}
                  disabled={isSaving}
                  className="w-full text-xs rounded-lg px-2.5 py-1.5 outline-none"
                  style={{ background: '#f9fafb', border: '1px solid #e5e7eb', color: displayVal ? '#111827' : '#9ca3af' }}
                >
                  <option value="">— select —</option>
                  {(def.options ?? []).map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              )}

              {def.field_type === 'multi_select' && (
                <div className="flex flex-wrap gap-1">
                  {(def.options ?? []).map(o => {
                    const selected = Array.isArray(committed) && committed.includes(o.value);
                    return (
                      <button
                        key={o.value}
                        disabled={isSaving}
                        onClick={() => {
                          const cur = Array.isArray(committed) ? committed : [];
                          handleChange(def, selected ? cur.filter(v => v !== o.value) : [...cur, o.value]);
                        }}
                        className="text-[10px] px-2 py-0.5 rounded-full transition-colors"
                        style={{
                          background: selected ? '#ede9fe' : '#f3f4f6',
                          color: selected ? '#6366f1' : '#6b7280',
                          border: selected ? '1px solid #c4b5fd' : '1px solid #e5e7eb',
                        }}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              )}

              {def.field_type === 'text' && (
                <input
                  type="text"
                  value={displayVal as string}
                  onChange={e => setDrafts(prev => ({ ...prev, [def.id]: e.target.value }))}
                  onBlur={() => handleTextBlur(def)}
                  disabled={isSaving}
                  className="w-full text-xs rounded-lg px-2.5 py-1.5 outline-none"
                  style={{ background: '#f9fafb', border: '1px solid #e5e7eb', color: '#111827' }}
                />
              )}

              {def.field_type === 'number' && (
                <input
                  type="number"
                  value={displayVal as string}
                  onChange={e => setDrafts(prev => ({ ...prev, [def.id]: e.target.value }))}
                  onBlur={() => handleTextBlur(def)}
                  disabled={isSaving}
                  className="w-full text-xs rounded-lg px-2.5 py-1.5 outline-none"
                  style={{ background: '#f9fafb', border: '1px solid #e5e7eb', color: '#111827' }}
                />
              )}

              {def.field_type === 'boolean' && (
                <button
                  disabled={isSaving}
                  onClick={() => handleChange(def, committed === 'true' ? 'false' : 'true')}
                  className="w-8 rounded-full relative transition-colors"
                  style={{ height: 18, background: committed === 'true' ? '#6366f1' : '#e5e7eb' }}
                >
                  <span
                    className="absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform"
                    style={{ left: committed === 'true' ? 'calc(100% - 18px)' : 2 }}
                  />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: '#9ca3af' }}>{children}</h3>
  );
}

function PropRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="text-xs shrink-0" style={{ color: '#6b7280' }}>{label}</span>
      <span
        className={`text-xs truncate text-right max-w-[150px] ${mono ? 'font-mono text-[10px]' : ''}`}
        style={{ color: '#111827' }}
      >
        {value}
      </span>
    </div>
  );
}
