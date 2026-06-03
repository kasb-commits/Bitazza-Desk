import { useState, useEffect, useCallback } from 'react';
import type { RelatedTicket } from '../types';
import { api } from '../api';
import { Spinner } from './ui/Spinner';
import { Skeleton } from './ui/Skeleton';
import { stripTags } from '../utils/richText';

interface Props {
  ticketId: string;
  partialDraft?: string;
  onAcceptDraft?: (text: string) => void;
  onSelectTicket?: (ticketId: string) => void;
}

const SENTIMENT_CONFIG: Record<string, { label: string; bg: string; color: string; ring: string }> = {
  positive: { label: 'Positive', bg: '#f0fdf4', color: '#15803d', ring: '1px solid #bbf7d0' },
  negative: { label: 'Negative', bg: '#fef2f2', color: '#b91c1c', ring: '1px solid #fecaca' },
  neutral:  { label: 'Neutral',  bg: '#f3f4f6', color: '#6b7280', ring: '1px solid #e5e7eb' },
};

export default function CopilotPanel({ ticketId, partialDraft = '', onAcceptDraft, onSelectTicket }: Props) {
  const [suggestion, setSuggestion]             = useState('');
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [suggestionError, setSuggestionError]   = useState('');
  const [copied, setCopied]                     = useState(false);

  const [summary, setSummary]           = useState('');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState('');

  const [sentiment, setSentiment]             = useState('');
  const [sentimentLoading, setSentimentLoading] = useState(false);

  const [related, setRelated]             = useState<RelatedTicket[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);

  const loadSentiment = useCallback(async () => {
    setSentimentLoading(true);
    try {
      const r = await api.sentiment(ticketId);
      setSentiment(r.sentiment);
    } catch { /* silent */ } finally { setSentimentLoading(false); }
  }, [ticketId]);

  const loadRelated = useCallback(async () => {
    setRelatedLoading(true);
    try {
      const r = await api.relatedTickets(ticketId);
      setRelated(r.related);
    } catch { /* silent */ } finally { setRelatedLoading(false); }
  }, [ticketId]);

  useEffect(() => {
    setSuggestion(''); setSuggestionError('');
    setSummary('');    setSummaryError('');
    setSentiment('');
    setRelated([]);
    loadSentiment();
    loadRelated();
  }, [ticketId]);

  const loadSuggestion = async () => {
    setSuggestionLoading(true); setSuggestionError('');
    try {
      const r = await api.suggestReply(ticketId);
      setSuggestion(r.suggestion);
    } catch (e) {
      setSuggestionError(e instanceof Error ? e.message : 'AI Assist unavailable.');
    } finally { setSuggestionLoading(false); }
  };

  const loadSummary = async () => {
    setSummaryLoading(true); setSummaryError('');
    try {
      const r = await api.summarize(ticketId);
      setSummary(r.summary);
    } catch (e) {
      setSummaryError(e instanceof Error ? e.message : 'AI Assist unavailable.');
    } finally { setSummaryLoading(false); }
  };

  const copySuggestion = () => {
    navigator.clipboard.writeText(suggestion).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const sentimentInfo = SENTIMENT_CONFIG[sentiment as keyof typeof SENTIMENT_CONFIG] ?? SENTIMENT_CONFIG.neutral;

  return (
    <div className="p-4 space-y-5">

      {/* ── Summary ──────────────────────────────────────────────────── */}
      <CopilotSection
        title="Summary"
        action={
          <button
            onClick={loadSummary}
            disabled={summaryLoading}
            className="text-xs text-brand hover:text-brand-dim font-medium disabled:opacity-40 transition-colors flex items-center gap-1"
          >
            {summaryLoading ? <><Spinner size="xs" /> Summarizing…</> : summary ? 'Refresh' : 'Summarize'}
          </button>
        }
      >
        {summaryError && <p className="text-xs text-brand">{summaryError}</p>}
        {!summary && !summaryLoading && !summaryError && (
          <p className="text-xs text-text-muted italic">Click Summarize to get an AI overview.</p>
        )}
        {summaryLoading && !summary && (
          <div className="space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        )}
        {summary && (() => {
          const lines = summary.split('\n').map(l => l.trim()).filter(Boolean);
          const parsed = lines.map(line => {
            const colon = line.indexOf(':');
            if (colon === -1) return { label: '', text: line };
            return { label: line.slice(0, colon).trim(), text: line.slice(colon + 1).trim() };
          });
          return (
            <div className="bg-accent-amber/5 ring-1 ring-accent-amber/20 rounded-lg divide-y divide-accent-amber/10 text-xs">
              {parsed.map((row, i) => (
                <div key={i} className="flex gap-2 px-2.5 py-2 leading-relaxed">
                  {row.label && (
                    <span className="shrink-0 font-semibold text-accent-amber w-16 text-[10px] uppercase tracking-wide">
                      {row.label}
                    </span>
                  )}
                  <span className="text-text-secondary">{row.text}</span>
                </div>
              ))}
            </div>
          );
        })()}
      </CopilotSection>

      {/* ── Reply Suggestion ─────────────────────────────────────────── */}
      <CopilotSection
        title="Reply Suggestion"
        action={
          <button
            onClick={loadSuggestion}
            disabled={suggestionLoading}
            className="text-xs text-brand hover:text-brand-dim font-medium disabled:opacity-40 transition-colors flex items-center gap-1"
          >
            {suggestionLoading ? <><Spinner size="xs" /> Generating…</> : suggestion ? 'Regenerate' : 'Generate'}
          </button>
        }
      >
        {suggestionError && (
          <p className="text-xs text-brand">{suggestionError}</p>
        )}
        {!suggestion && !suggestionLoading && !suggestionError && (
          <p className="text-xs text-text-muted italic">Click Generate to get an AI-drafted reply.</p>
        )}
        {suggestionLoading && !suggestion && (
          <div className="space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className="h-3 w-4/6" />
          </div>
        )}
        {suggestion && (
          <div className="bg-brand/5 ring-1 ring-brand/15 rounded-lg p-3">
            <p className="text-xs text-text-primary whitespace-pre-wrap leading-relaxed">{suggestion}</p>
            <div className="flex gap-2 mt-3">
              {onAcceptDraft && (
                <button
                  onClick={() => { onAcceptDraft(suggestion); setSuggestion(''); }}
                  className="text-xs px-3 py-1.5 bg-brand hover:bg-brand-dim text-white rounded transition-colors font-medium"
                >
                  Accept
                </button>
              )}
              <button
                onClick={copySuggestion}
                className="text-xs px-3 py-1.5 rounded transition-colors font-medium"
              style={{ background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb' }}
              >
                {copied ? '✓ Copied' : 'Copy'}
              </button>
              <button
                onClick={() => setSuggestion('')}
                className="text-xs px-3 py-1.5 rounded transition-colors"
              style={{ background: '#f3f4f6', color: '#9ca3af', border: '1px solid #e5e7eb' }}
              >
                Reject
              </button>
            </div>
          </div>
        )}
      </CopilotSection>

      {/* ── Draft with Instructions ───────────────────────────────────── */}
      <AssistedDraftSection
        ticketId={ticketId}
        partialDraft={partialDraft}
        onAcceptDraft={onAcceptDraft}
      />

      {/* ── Sentiment ────────────────────────────────────────────────── */}
      <CopilotSection
        title="Sentiment"
        action={
          <button onClick={loadSentiment} className="text-[10px] text-text-muted hover:text-text-primary transition-colors p-0.5">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/>
            </svg>
          </button>
        }
      >
        {sentimentLoading
          ? <Skeleton className="h-5 w-20 rounded-full" />
          : sentiment
            ? <span
                className="text-xs px-2.5 py-1 rounded-full font-medium capitalize"
                style={{ background: sentimentInfo.bg, color: sentimentInfo.color, boxShadow: `0 0 0 ${sentimentInfo.ring}` }}
              >
                {sentimentInfo.label}
              </span>
            : <span className="text-xs text-text-muted italic">Analyzing…</span>
        }
      </CopilotSection>

      {/* ── Related Tickets ──────────────────────────────────────────── */}
      <CopilotSection title="Related Tickets">
        {relatedLoading && (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
          </div>
        )}
        {!relatedLoading && related.length === 0 && (
          <p className="text-xs text-text-muted italic">No related tickets found.</p>
        )}
        {!relatedLoading && related.map(t => (
          <div
            key={t.id}
            onClick={() => onSelectTicket?.(t.id)}
            className={`rounded-lg px-3 py-2.5 space-y-0.5 transition-colors ${onSelectTicket ? 'cursor-pointer' : ''}`}
            style={{ background: '#f0f4ff', border: '1px solid #c7d2fe' }}
            onMouseEnter={e => { if (onSelectTicket) (e.currentTarget as HTMLDivElement).style.background = '#e0e7ff'; }}
            onMouseLeave={e => { if (onSelectTicket) (e.currentTarget as HTMLDivElement).style.background = '#f0f4ff'; }}
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px]" style={{ color: '#6366f1' }}>{t.id.slice(0, 8)}…</span>
              <span className="text-[10px]" style={{ color: '#6b7280' }}>{t.status?.replace(/_/g, ' ')}</span>
            </div>
            {t.customer_name && (
              <p className="text-xs font-medium truncate" style={{ color: '#1e1b4b' }}>{t.customer_name}</p>
            )}
            {t.last_message && (
              <p className="text-[10px] truncate" style={{ color: '#4b5563' }}>{stripTags(t.last_message).trim() || '—'}</p>
            )}
          </div>
        ))}
      </CopilotSection>

    </div>
  );
}

// ── Assisted Draft Section ────────────────────────────────────────────────────

function AssistedDraftSection({
  ticketId,
  partialDraft,
  onAcceptDraft,
}: {
  ticketId: string;
  partialDraft: string;
  onAcceptDraft?: (text: string) => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [draft, setDraft]             = useState('');
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [copied, setCopied]           = useState(false);

  const generate = async () => {
    setLoading(true); setError('');
    try {
      const r = await api.draftAssisted(ticketId, instruction, partialDraft);
      setDraft(r.draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI Assist unavailable.');
    } finally { setLoading(false); }
  };

  const copy = () => {
    navigator.clipboard.writeText(draft).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <CopilotSection title="Ask AI to Write">
      <div className="flex flex-col gap-1.5">
        <textarea
          value={instruction}
          onChange={e => setInstruction(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(); } }}
          placeholder={'Tell AI what to write…\ne.g. "Explain how to reset 2FA" or "Apologise and ask for their transaction ID"'}
          rows={3}
          className="w-full text-xs rounded-md px-2.5 py-2 outline-none transition-colors resize-none leading-relaxed"
          style={{ background: '#f9fafb', border: '1px solid #e5e7eb', color: '#111827' }}
          onFocus={e => { e.currentTarget.style.borderColor = '#6366f1'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(99,102,241,0.15)'; }}
          onBlur={e => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.boxShadow = 'none'; }}
        />
        <button
          onClick={generate}
          disabled={loading}
          className="self-end text-xs text-brand hover:text-brand-dim font-medium disabled:opacity-40 transition-colors flex items-center gap-1"
        >
          {loading ? <><Spinner size="xs" /> Generating…</> : draft ? 'Regenerate' : 'Generate'}
        </button>
      </div>

      {partialDraft.trim() && (
        <div className="flex items-center gap-1.5 text-[10px] rounded px-2 py-1" style={{ background: '#f0f4ff', border: '1px solid #c7d2fe', color: '#6b7280' }}>
          <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: '#6366f1' }}>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
          </svg>
          <span className="truncate">Using your draft: <span style={{ color: '#374151' }}>{partialDraft.slice(0, 40)}{partialDraft.length > 40 ? '…' : ''}</span></span>
        </div>
      )}

      {error && <p className="text-xs text-brand">{error}</p>}
      {!draft && !loading && !error && (
        <p className="text-xs text-text-muted italic">Type an instruction, then Generate.</p>
      )}
      {loading && !draft && (
        <div className="space-y-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-4/6" />
        </div>
      )}
      {draft && (
        <div className="bg-indigo-500/5 ring-1 ring-indigo-500/15 rounded-lg p-3">
          <p className="text-xs text-text-primary whitespace-pre-wrap leading-relaxed">{draft}</p>
          <div className="flex gap-2 mt-3">
            {onAcceptDraft && (
              <button
                onClick={() => { onAcceptDraft(draft); setDraft(''); }}
                className="text-xs px-3 py-1.5 bg-brand hover:bg-brand-dim text-white rounded transition-colors font-medium"
              >
                Accept
              </button>
            )}
            <button
              onClick={copy}
              className="text-xs px-3 py-1.5 rounded transition-colors font-medium"
              style={{ background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb' }}
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            <button
              onClick={() => setDraft('')}
              className="text-xs px-3 py-1.5 rounded transition-colors"
              style={{ background: '#f3f4f6', color: '#9ca3af', border: '1px solid #e5e7eb' }}
            >
              Reject
            </button>
          </div>
        </div>
      )}
    </CopilotSection>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function CopilotSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}
