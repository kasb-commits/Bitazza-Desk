import { useState, useEffect, useRef, useCallback } from 'react';
import type { KnowledgeItem, KnowledgeSourceType, CitationsSource } from '../types';
import { api } from '../api';
import type { AuthUser } from '../App';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return '—';
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function SourceBadge({ type }: { type: KnowledgeSourceType }) {
  const styles: Record<KnowledgeSourceType, string> = {
    url:  'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-1 ring-blue-200 dark:ring-blue-500/20',
    pdf:  'bg-brand/10 text-brand ring-1 ring-brand/20',
    docx: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 ring-1 ring-amber-200 dark:ring-amber-500/20',
  };
  const labels: Record<KnowledgeSourceType, string> = {
    url: 'URL', pdf: 'PDF', docx: 'DOCX',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${styles[type] ?? styles.url}`}>
      {labels[type] ?? type.toUpperCase()}
    </span>
  );
}

// ── Status banner ─────────────────────────────────────────────────────────────

interface StatusMsg { type: 'success' | 'error'; text: string }

function StatusBanner({ msg, onDismiss }: { msg: StatusMsg; onDismiss: () => void }) {
  const isError = msg.type === 'error';
  return (
    <div className={`flex items-start gap-2.5 rounded-md p-3 ring-1 ${
      isError
        ? 'bg-red-950/60 ring-red-800/60'
        : 'bg-green-950/60 ring-green-800/60'
    }`}>
      {isError ? (
        <svg className="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
      ) : (
        <svg className="w-4 h-4 text-green-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      )}
      <p className={`text-xs leading-relaxed flex-1 ${isError ? 'text-red-300' : 'text-green-300'}`}>{msg.text}</p>
      <button onClick={onDismiss} className="text-text-muted hover:text-text-secondary transition-colors shrink-0">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// ── Add URL tab ───────────────────────────────────────────────────────────────

function AddUrlPanel({ onAdded }: { onAdded: (item: KnowledgeItem) => void }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<StatusMsg | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    setLoading(true);
    setStatus(null);
    try {
      const item = await api.addKnowledgeUrl(trimmed);
      setStatus({ type: 'success', text: `Added "${item.title}" — ${item.chunk_count} chunk${item.chunk_count !== 1 ? 's' : ''} indexed.` });
      setUrl('');
      onAdded(item);
    } catch (err) {
      setStatus({ type: 'error', text: err instanceof Error ? err.message : 'Failed to scrape URL.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-text-secondary mb-4">
          Enter a public URL. The page content will be scraped, chunked, and added to the knowledge base so the AI can reference it when answering customer queries.
        </p>
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://help.bitazza.com/article/..."
            className="flex-1 bg-surface-2 ring-1 ring-surface-5 text-text-primary px-3 py-2 text-sm rounded-md outline-none focus:ring-brand transition-all placeholder:text-text-muted"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !url.trim()}
            className="px-4 py-2 bg-brand hover:bg-brand-dim text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shrink-0"
          >
            {loading && (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            )}
            {loading ? 'Scraping…' : 'Scrape & Add'}
          </button>
        </form>
      </div>
      {status && <StatusBanner msg={status} onDismiss={() => setStatus(null)} />}
    </div>
  );
}

// ── Upload file tab ───────────────────────────────────────────────────────────

function UploadFilePanel({ onAdded }: { onAdded: (item: KnowledgeItem) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<StatusMsg | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (f: File) => {
    const ext = f.name.split('.').pop()?.toLowerCase();
    if (ext !== 'pdf' && ext !== 'docx') {
      setStatus({ type: 'error', text: 'Only PDF and DOCX files are supported.' });
      return;
    }
    setFile(f);
    setStatus(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const handleUpload = async () => {
    if (!file) return;
    setLoading(true);
    setStatus(null);
    try {
      const item = await api.uploadKnowledgeFile(file);
      setStatus({ type: 'success', text: `Added "${item.title}" — ${item.chunk_count} chunk${item.chunk_count !== 1 ? 's' : ''} indexed.` });
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      onAdded(item);
    } catch (err) {
      setStatus({ type: 'error', text: err instanceof Error ? err.message : 'Upload failed.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">
        Upload a PDF or DOCX file. Its content will be extracted and indexed into the knowledge base.
      </p>

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`relative flex flex-col items-center justify-center gap-3 border-2 border-dashed rounded-lg p-8 cursor-pointer transition-colors ${
          dragging
            ? 'border-brand bg-brand-subtle'
            : 'border-surface-5 bg-surface-2 hover:border-brand/50 hover:bg-surface-3'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.docx"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
        <svg className="w-8 h-8 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
        </svg>
        {file ? (
          <div className="text-center">
            <p className="text-sm font-medium text-text-primary">{file.name}</p>
            <p className="text-xs text-text-muted mt-0.5">{(file.size / 1024).toFixed(1)} KB</p>
          </div>
        ) : (
          <div className="text-center">
            <p className="text-sm text-text-secondary">Drop a PDF or DOCX here, or click to browse</p>
            <p className="text-xs text-text-muted mt-1">Supported: .pdf, .docx</p>
          </div>
        )}
      </div>

      {file && (
        <div className="flex gap-2 justify-end">
          <button
            onClick={() => { setFile(null); setStatus(null); if (inputRef.current) inputRef.current.value = ''; }}
            disabled={loading}
            className="px-3 py-1.5 text-sm ring-1 ring-surface-5 rounded-md hover:bg-surface-4 transition-colors text-text-secondary disabled:opacity-50"
          >
            Clear
          </button>
          <button
            onClick={handleUpload}
            disabled={loading}
            className="px-4 py-1.5 bg-brand hover:bg-brand-dim text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {loading && (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            )}
            {loading ? 'Indexing…' : 'Upload & Index'}
          </button>
        </div>
      )}

      {status && <StatusBanner msg={status} onDismiss={() => setStatus(null)} />}
    </div>
  );
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ISSUE_CATEGORIES = [
  'Exchange Fees', 'Account Verification', 'Deposits', 'Withdrawals',
  'Refunds', 'Transaction Delays', 'Security', 'KYC', 'API Usage',
  'Password Reset', 'Account Restriction', 'Fraud',
];

// ── Citation helpers ──────────────────────────────────────────────────────────

function CoverageBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-xs text-text-muted">—</span>;
  if (score >= 0.75) return <span className="text-xs text-accent-green font-medium">High</span>;
  if (score >= 0.5)  return <span className="text-xs text-amber-400 font-medium">Medium</span>;
  return <span className="text-xs text-red-400 font-medium">Low</span>;
}

function CitationsSourceBadge({ source }: { source: CitationsSource }) {
  if (source === 'pending') return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-surface-4 text-gray-500 dark:text-text-muted ring-1 ring-gray-300 dark:ring-surface-5">Pending</span>
  );
  if (source === 'manual') return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 ring-1 ring-amber-200 dark:ring-amber-500/20">
      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
      </svg>
      Edited
    </span>
  );
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-1 ring-blue-200 dark:ring-blue-500/20">AI</span>
  );
}

// ── Item Detail Modal (3 tabs: Chunks / Citations / Version History) ───────────

type ModalTab = 'Chunks' | 'Citations' | 'Version History';

function ItemDetailModal({
  item, canWrite, initialTab = 'Chunks', onClose, onRefresh,
}: {
  item: KnowledgeItem;
  canWrite: boolean;
  initialTab?: ModalTab;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [activeTab, setActiveTab] = useState<ModalTab>(initialTab);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-6 animate-fade-in" onClick={onClose}>
      <div
        className="w-full max-w-2xl bg-surface-3 ring-1 ring-surface-5 rounded-xl shadow-modal flex flex-col max-h-[85vh] animate-scale-in"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-surface-5 shrink-0">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-primary truncate">{item.title}</h3>
            <p className="text-xs text-text-muted mt-0.5">
              v{item.version_number ?? 1} · {item.chunk_count} chunk{item.chunk_count !== 1 ? 's' : ''}
              {item.source_ref && <> · <span className="font-mono">{item.source_ref.length > 40 ? item.source_ref.slice(0, 40) + '…' : item.source_ref}</span></>}
            </p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-secondary transition-colors shrink-0 mt-0.5">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-surface-5 shrink-0 px-5">
          {(['Chunks', 'Citations', 'Version History'] as ModalTab[]).map(t => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`px-3 py-2.5 text-xs font-medium transition-colors ${
                activeTab === t
                  ? 'text-text-primary border-b-2 border-brand -mb-px'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="overflow-y-auto flex-1">
          {activeTab === 'Chunks' && <ChunksTabContent item={item} />}
          {activeTab === 'Citations' && <CitationsTabContent item={item} canWrite={canWrite} onRefresh={onRefresh} />}
          {activeTab === 'Version History' && (
            <VersionHistoryTabContent item={item} canWrite={canWrite} onClose={onClose} onRefresh={onRefresh} />
          )}
        </div>

        <div className="px-5 py-3 border-t border-surface-5 shrink-0 flex justify-end">
          <button onClick={onClose} className="px-4 py-1.5 text-sm ring-1 ring-surface-5 rounded-md hover:bg-surface-4 transition-colors text-text-secondary">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Chunks tab ────────────────────────────────────────────────────────────────

function ChunksTabContent({ item }: { item: KnowledgeItem }) {
  const [chunks, setChunks] = useState<{ index: number; text: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getKnowledgeChunks(item.id)
      .then(r => setChunks(r.chunks))
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load chunks'))
      .finally(() => setLoading(false));
  }, [item.id]);

  if (loading) return (
    <div className="flex items-center justify-center py-12 gap-2 text-text-muted text-sm">
      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
      </svg>
      Loading chunks…
    </div>
  );
  if (error) return <p className="text-red-400 text-sm text-center py-8 px-5">{error}</p>;
  if (chunks.length === 0) return <p className="text-text-muted text-sm text-center py-8 px-5">No chunks found in vector store.</p>;

  return (
    <div className="px-5 py-4 space-y-3">
      {chunks.map(chunk => (
        <div key={chunk.index} className="bg-surface-2 ring-1 ring-surface-5 rounded-md p-3">
          <div className="text-[10px] font-mono text-text-muted mb-1.5">Chunk {chunk.index + 1}</div>
          <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap">{chunk.text}</p>
        </div>
      ))}
    </div>
  );
}

// ── Citations tab ─────────────────────────────────────────────────────────────

function CitationsTabContent({ item, canWrite, onRefresh }: { item: KnowledgeItem; canWrite: boolean; onRefresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [editCategories, setEditCategories] = useState<string[]>(item.citation_categories ?? []);
  const [editKeywords, setEditKeywords] = useState((item.citation_keywords ?? []).join(', '));
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<StatusMsg | null>(null);

  const source = item.citations_source ?? 'pending';
  const categories = item.citation_categories ?? [];
  const keywords = item.citation_keywords ?? [];

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus(null);
    try {
      const kws = editKeywords.split(',').map(k => k.trim()).filter(Boolean);
      await api.updateKnowledgeCitations(item.id, editCategories, kws);
      setSaveStatus({ type: 'success', text: 'Citations saved and locked against AI reclassification.' });
      setEditing(false);
      onRefresh();
    } catch (err) {
      setSaveStatus({ type: 'error', text: err instanceof Error ? err.message : 'Save failed.' });
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditCategories(item.citation_categories ?? []);
    setEditKeywords((item.citation_keywords ?? []).join(', '));
    setEditing(false);
    setSaveStatus(null);
  };

  const toggleCategory = (cat: string) => {
    setEditCategories(prev =>
      prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]
    );
  };

  // ── Read-only view ─────────────────────────────────────────────────────────
  if (!editing) {
    return (
      <div className="px-5 py-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CitationsSourceBadge source={source} />
            <span className="text-xs text-text-muted">Coverage: <CoverageBadge score={item.coverage_score ?? null} /></span>
          </div>
          {canWrite && source !== 'pending' && (
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium ring-1 ring-surface-5 rounded-md hover:bg-surface-4 text-text-secondary transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
              </svg>
              Override citations
            </button>
          )}
        </div>

        {source === 'pending' ? (
          <div className="rounded-md bg-surface-2 ring-1 ring-surface-5 px-4 py-5 text-center space-y-1.5">
            <p className="text-xs text-text-muted">AI classification is pending.</p>
            <p className="text-[10px] text-text-muted">Categories will appear here automatically after the background classifier runs (usually within seconds of ingest).</p>
          </div>
        ) : (
          <>
            <div>
              <p className="text-[10px] font-medium text-text-muted uppercase tracking-wide mb-2">Issue Categories</p>
              {categories.length === 0 ? (
                <p className="text-xs text-text-muted italic">No categories assigned.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {categories.map(cat => (
                    <span key={cat} className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-brand/10 text-brand ring-1 ring-brand/20">
                      {cat}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {keywords.length > 0 && (
              <div>
                <p className="text-[10px] font-medium text-text-muted uppercase tracking-wide mb-2">Retrieval Keywords</p>
                <div className="flex flex-wrap gap-1.5">
                  {keywords.map(kw => (
                    <span key={kw} className="px-2 py-0.5 rounded text-[10px] bg-surface-2 text-text-secondary ring-1 ring-surface-5">
                      {kw}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {source === 'manual' && (
              <p className="text-[10px] text-amber-400 flex items-center gap-1">
                <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                Manually overridden — AI reclassification is locked for this item.
              </p>
            )}
          </>
        )}

        {saveStatus && <StatusBanner msg={saveStatus} onDismiss={() => setSaveStatus(null)} />}
      </div>
    );
  }

  // ── Edit view ──────────────────────────────────────────────────────────────
  return (
    <div className="px-5 py-4 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-text-primary">Override AI citations</p>
        <CitationsSourceBadge source={source} />
      </div>
      <p className="text-[11px] text-text-muted -mt-2">
        Saving will lock this item — the AI reclassifier will no longer update these citations automatically.
      </p>

      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">Issue Categories</label>
        <div className="flex flex-wrap gap-1.5">
          {ISSUE_CATEGORIES.map(cat => {
            const selected = editCategories.includes(cat);
            return (
              <button
                key={cat}
                type="button"
                onClick={() => toggleCategory(cat)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ring-1 ${
                  selected
                    ? 'bg-brand/20 text-brand ring-brand/30'
                    : 'bg-surface-2 text-text-muted ring-surface-5 hover:ring-brand/30 hover:text-text-secondary'
                }`}
              >
                {cat}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">Retrieval Keywords</label>
        <input
          type="text"
          value={editKeywords}
          onChange={e => setEditKeywords(e.target.value)}
          placeholder="kyc, identity verification, document upload…"
          className="w-full bg-surface-2 ring-1 ring-surface-5 text-text-primary px-3 py-2 text-xs rounded-md outline-none focus:ring-brand transition-all placeholder:text-text-muted"
        />
        <p className="text-[10px] text-text-muted mt-1">Comma-separated keywords</p>
      </div>

      {saveStatus && <StatusBanner msg={saveStatus} onDismiss={() => setSaveStatus(null)} />}

      <div className="flex justify-end gap-2">
        <button
          onClick={handleCancelEdit}
          disabled={saving}
          className="px-3 py-1.5 text-xs ring-1 ring-surface-5 rounded-md hover:bg-surface-4 transition-colors text-text-secondary disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-1.5 bg-brand hover:bg-brand-dim text-white text-xs font-medium rounded-md transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {saving && (
            <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
          )}
          {saving ? 'Saving…' : 'Save & Lock'}
        </button>
      </div>
    </div>
  );
}

// ── Version History tab ───────────────────────────────────────────────────────

function VersionHistoryTabContent({
  item, canWrite, onClose, onRefresh,
}: {
  item: KnowledgeItem;
  canWrite: boolean;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [versions, setVersions] = useState<KnowledgeItem[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(true);
  const [overrideMode, setOverrideMode] = useState<'url' | 'file' | null>(null);
  const [overrideUrl, setOverrideUrl] = useState('');
  const [overrideFile, setOverrideFile] = useState<File | null>(null);
  const [overrideNotes, setOverrideNotes] = useState('');
  const [overrideLoading, setOverrideLoading] = useState(false);
  const [overrideStatus, setOverrideStatus] = useState<StatusMsg | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.getKnowledgeVersions(item.id)
      .then(vs => setVersions([...vs].sort((a, b) => b.version_number - a.version_number)))
      .catch(() => {})
      .finally(() => setLoadingVersions(false));
  }, [item.id]);

  const handleOverride = async () => {
    if (overrideMode === 'url' && !overrideUrl.trim()) return;
    if (overrideMode === 'file' && !overrideFile) return;
    setOverrideLoading(true);
    setOverrideStatus(null);
    try {
      if (overrideMode === 'file' && overrideFile) {
        await api.overrideKnowledgeWithFile(item.id, overrideFile, overrideNotes);
      } else {
        await api.overrideKnowledgeWithUrl(item.id, overrideUrl.trim(), overrideNotes);
      }
      onClose();
      onRefresh();
    } catch (err) {
      setOverrideStatus({ type: 'error', text: err instanceof Error ? err.message : 'Override failed. The original version is still active.' });
    } finally {
      setOverrideLoading(false);
    }
  };

  const statusColors: Record<string, string> = {
    ACTIVE:     'bg-accent-green/10 text-accent-green ring-1 ring-accent-green/20',
    ARCHIVED:   'bg-surface-4 text-text-muted ring-1 ring-surface-5',
    PROCESSING: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 ring-1 ring-amber-200 dark:ring-amber-500/20',
    FAILED:     'bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 ring-1 ring-red-200 dark:ring-red-500/20',
  };

  return (
    <div className="px-5 py-4 space-y-4">
      {canWrite && (
        <div className="bg-surface-2 ring-1 ring-surface-5 rounded-lg p-4 space-y-3">
          <p className="text-xs font-semibold text-text-primary">Upload New Version</p>
          {overrideMode === null && (
            <div className="flex gap-2">
              <button
                onClick={() => setOverrideMode('url')}
                className="px-3 py-1.5 text-xs ring-1 ring-surface-5 rounded-md hover:bg-surface-4 text-text-secondary transition-colors"
              >
                Replace with URL
              </button>
              <button
                onClick={() => setOverrideMode('file')}
                className="px-3 py-1.5 text-xs ring-1 ring-surface-5 rounded-md hover:bg-surface-4 text-text-secondary transition-colors"
              >
                Replace with File
              </button>
            </div>
          )}
          {overrideMode === 'url' && (
            <div className="space-y-2">
              <input
                type="url"
                value={overrideUrl}
                onChange={e => setOverrideUrl(e.target.value)}
                placeholder="https://help.bitazza.com/…"
                className="w-full bg-surface-3 ring-1 ring-surface-5 text-text-primary px-3 py-2 text-xs rounded-md outline-none focus:ring-brand transition-all placeholder:text-text-muted"
              />
              <input
                type="text"
                value={overrideNotes}
                onChange={e => setOverrideNotes(e.target.value)}
                placeholder="Reason for change (optional)"
                className="w-full bg-surface-3 ring-1 ring-surface-5 text-text-primary px-3 py-2 text-xs rounded-md outline-none focus:ring-brand transition-all placeholder:text-text-muted"
              />
              <div className="flex gap-2 justify-end">
                <button onClick={() => { setOverrideMode(null); setOverrideUrl(''); setOverrideStatus(null); }} className="px-3 py-1.5 text-xs ring-1 ring-surface-5 rounded-md hover:bg-surface-4 text-text-secondary">Cancel</button>
                <button onClick={handleOverride} disabled={overrideLoading || !overrideUrl.trim()} className="px-4 py-1.5 bg-brand hover:bg-brand-dim text-white text-xs font-medium rounded-md disabled:opacity-50 flex items-center gap-2">
                  {overrideLoading && <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>}
                  {overrideLoading ? 'Replacing…' : 'Submit Override'}
                </button>
              </div>
            </div>
          )}
          {overrideMode === 'file' && (
            <div className="space-y-2">
              <div
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-2 border border-dashed border-surface-5 rounded-md p-3 cursor-pointer hover:border-brand/50 transition-colors"
              >
                <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
                <span className="text-xs text-text-muted">{overrideFile ? overrideFile.name : 'Click to select PDF or DOCX'}</span>
                <input ref={fileRef} type="file" accept=".pdf,.docx" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) setOverrideFile(f); }} />
              </div>
              <input
                type="text"
                value={overrideNotes}
                onChange={e => setOverrideNotes(e.target.value)}
                placeholder="Reason for change (optional)"
                className="w-full bg-surface-3 ring-1 ring-surface-5 text-text-primary px-3 py-2 text-xs rounded-md outline-none focus:ring-brand transition-all placeholder:text-text-muted"
              />
              <div className="flex gap-2 justify-end">
                <button onClick={() => { setOverrideMode(null); setOverrideFile(null); setOverrideStatus(null); }} className="px-3 py-1.5 text-xs ring-1 ring-surface-5 rounded-md hover:bg-surface-4 text-text-secondary">Cancel</button>
                <button onClick={handleOverride} disabled={overrideLoading || !overrideFile} className="px-4 py-1.5 bg-brand hover:bg-brand-dim text-white text-xs font-medium rounded-md disabled:opacity-50 flex items-center gap-2">
                  {overrideLoading && <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>}
                  {overrideLoading ? 'Replacing…' : 'Submit Override'}
                </button>
              </div>
            </div>
          )}
          {overrideStatus && <StatusBanner msg={overrideStatus} onDismiss={() => setOverrideStatus(null)} />}
        </div>
      )}

      {loadingVersions ? (
        <div className="flex items-center justify-center py-8 gap-2 text-text-muted text-sm">
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          Loading versions…
        </div>
      ) : versions.length === 0 ? (
        <p className="text-text-muted text-xs text-center py-6">No version history available.</p>
      ) : (
        <div className="space-y-2">
          {versions.map(v => (
            <div key={v.id} className="flex items-start gap-3 bg-surface-2 ring-1 ring-surface-5 rounded-md p-3">
              <div className="text-xs font-mono text-text-muted shrink-0 mt-0.5">v{v.version_number}</div>
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${statusColors[v.status] ?? statusColors.ARCHIVED}`}>
                    {v.status}
                  </span>
                  <span className="text-[10px] text-text-muted">{formatDate(v.created_at)}</span>
                </div>
                {v.source_ref && (
                  <p className="text-[10px] text-text-muted truncate" title={v.source_ref}>{v.source_ref}</p>
                )}
                {v.change_notes && (
                  <p className="text-xs text-text-secondary italic">"{v.change_notes}"</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Pending citations banner ──────────────────────────────────────────────────

function PendingCitationsBanner({ pendingCount, onRefresh }: { pendingCount: number; onRefresh: () => void }) {
  const [classifying, setClassifying] = useState(false);
  const [done, setDone] = useState(false);

  const handleClassifyAll = async () => {
    setClassifying(true);
    try {
      await api.classifyAllKnowledge();
      setDone(true);
      setTimeout(() => { onRefresh(); setDone(false); }, 1500);
    } catch {
      // silent — items will retry via auto-poll
    } finally {
      setClassifying(false);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-md bg-amber-50 dark:bg-amber-500/8 ring-1 ring-amber-200 dark:ring-amber-500/20 px-4 py-2.5">
      <svg className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <p className="text-[11px] text-amber-700 dark:text-amber-300 flex-1">
        {pendingCount} item{pendingCount !== 1 ? 's' : ''} pending AI citation classification.
        {' '}Auto-refreshing every 5 s — or run classification now for all items.
      </p>
      <button
        onClick={handleClassifyAll}
        disabled={classifying || done}
        className="shrink-0 px-3 py-1 text-[11px] font-medium bg-amber-100 dark:bg-amber-500/15 hover:bg-amber-200 dark:hover:bg-amber-500/25 text-amber-700 dark:text-amber-300 ring-1 ring-amber-300 dark:ring-amber-500/30 rounded-md transition-colors disabled:opacity-60 flex items-center gap-1.5"
      >
        {classifying && (
          <svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
        )}
        {done ? 'Done — refreshing…' : classifying ? 'Classifying…' : 'Classify all now'}
      </button>
    </div>
  );
}

// ── Items table ───────────────────────────────────────────────────────────────

function ItemsTable({
  items, canWrite, onDelete, onOpen, onOverride,
}: {
  items: KnowledgeItem[];
  canWrite: boolean;
  onDelete: (id: number) => void;
  onOpen: (item: KnowledgeItem, tab?: ModalTab) => void;
  onOverride: (item: KnowledgeItem) => void;
}) {
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);

  const allCategories = [...new Set(items.flatMap(i => i.citation_categories ?? []))].sort();

  const filtered = categoryFilter.length === 0
    ? items
    : items.filter(i => categoryFilter.every(c => (i.citation_categories ?? []).includes(c)));

  const toggleFilter = (cat: string) => {
    setCategoryFilter(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]);
  };

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
        <div className="w-12 h-12 rounded-full bg-surface-3 ring-1 ring-surface-5 flex items-center justify-center">
          <svg className="w-5 h-5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.966 8.966 0 00-6 2.292m0-14.25v14.25" />
          </svg>
        </div>
        <div>
          <p className="text-text-primary text-sm font-medium">No knowledge items yet</p>
          <p className="text-text-muted text-xs mt-1">Add a URL or upload a document to get started</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Category filter */}
      {allCategories.length > 0 && (
        <div className="relative">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setFilterOpen(o => !o)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md ring-1 transition-colors ${
                categoryFilter.length > 0
                  ? 'bg-brand/10 text-brand ring-brand/30'
                  : 'bg-surface-2 text-text-muted ring-surface-5 hover:bg-surface-3'
              }`}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
              </svg>
              {categoryFilter.length > 0 ? `${categoryFilter.length} filter${categoryFilter.length > 1 ? 's' : ''} active` : 'Filter by category'}
            </button>
            {categoryFilter.map(cat => (
              <span key={cat} className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-brand/10 text-brand ring-1 ring-brand/20">
                {cat}
                <button onClick={() => toggleFilter(cat)} className="hover:text-brand-dim">×</button>
              </span>
            ))}
            {categoryFilter.length > 0 && (
              <button onClick={() => setCategoryFilter([])} className="text-[10px] text-text-muted hover:text-text-secondary underline">Clear all</button>
            )}
          </div>
          {filterOpen && (
            <div className="absolute top-full left-0 mt-1 z-20 bg-surface-3 ring-1 ring-surface-5 rounded-lg shadow-lg p-3 flex flex-wrap gap-1.5 w-80">
              {allCategories.map(cat => (
                <button
                  key={cat}
                  onClick={() => toggleFilter(cat)}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ring-1 ${
                    categoryFilter.includes(cat)
                      ? 'bg-brand/20 text-brand ring-brand/30'
                      : 'bg-surface-2 text-text-muted ring-surface-5 hover:ring-brand/30'
                  }`}
                >
                  {cat}
                </button>
              ))}
              <button onClick={() => setFilterOpen(false)} className="ml-auto text-[10px] text-text-muted hover:text-text-secondary">Done</button>
            </div>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-5">
              <th className="text-left text-xs font-medium text-text-muted py-2.5 px-3">Title</th>
              <th className="text-left text-xs font-medium text-text-muted py-2.5 px-3">Type</th>
              <th className="text-left text-xs font-medium text-text-muted py-2.5 px-3">Citations</th>
              <th className="text-right text-xs font-medium text-text-muted py-2.5 px-3">Chunks</th>
              <th className="text-left text-xs font-medium text-text-muted py-2.5 px-3">Added</th>
              <th className="py-2.5 px-3" colSpan={canWrite ? 3 : 1} />
            </tr>
          </thead>
          <tbody>
            {filtered.map(item => {
              const cats = item.citation_categories ?? [];
              const visible = cats.slice(0, 3);
              const overflow = cats.length - 3;
              return (
                <tr key={item.id} className="border-b border-surface-5/50 hover:bg-surface-3 transition-colors group">
                  <td className="py-3 px-3">
                    <span className="font-medium text-text-primary text-xs">{item.title}</span>
                    {(item.version_number ?? 1) > 1 && (
                      <span className="ml-1.5 text-[10px] text-text-muted font-mono">v{item.version_number}</span>
                    )}
                  </td>
                  <td className="py-3 px-3">
                    <SourceBadge type={item.source_type} />
                  </td>
                  <td className="py-3 px-3">
                    {(item.citations_source ?? 'pending') === 'pending' ? (
                      <CitationsSourceBadge source="pending" />
                    ) : (
                      <div className="flex items-center gap-1 flex-wrap">
                        {visible.map(cat => (
                          <span key={cat} className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-brand/10 text-brand ring-1 ring-brand/20">{cat}</span>
                        ))}
                        {overflow > 0 && (
                          <span className="text-[10px] text-text-muted">+{overflow}</span>
                        )}
                        {(item.citations_source ?? 'pending') === 'manual' && (
                          <svg className="w-2.5 h-2.5 text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                          </svg>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="py-3 px-3 text-right">
                    <span className="text-xs text-text-secondary tabular-nums">{item.chunk_count}</span>
                  </td>
                  <td className="py-3 px-3">
                    <span className="text-xs text-text-muted">{formatDate(item.created_at)}</span>
                  </td>
                  <td className="py-3 px-3 text-right">
                    <button
                      onClick={() => onOpen(item)}
                      className="p-1 rounded text-text-muted hover:text-accent-blue hover:bg-accent-blue/10"
                      title="View details"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </button>
                  </td>
                  {canWrite && (
                    <td className="py-3 px-3 text-right">
                      <button
                        onClick={() => onOverride(item)}
                        className="p-1 rounded text-text-muted hover:text-amber-400 hover:bg-amber-400/10"
                        title="Override"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                        </svg>
                      </button>
                    </td>
                  )}
                  {canWrite && (
                    <td className="py-3 px-3 text-right">
                      <button
                        onClick={() => {
                          if (window.confirm(`Delete "${item.title}" and all its versions? This will remove all indexed chunks.`)) {
                            onDelete(item.id);
                          }
                        }}
                        className="p-1 rounded text-text-muted hover:text-brand hover:bg-brand/10"
                        title="Delete"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                        </svg>
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

const TABS = ['Add Knowledge', 'Knowledge Items'] as const;
type Tab = typeof TABS[number];

interface Props { currentUser: AuthUser }

export default function KnowledgeBase({ currentUser: _currentUser }: Props) {
  const [tab, setTab] = useState<Tab>('Add Knowledge');
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [deleteStatus, setDeleteStatus] = useState<StatusMsg | null>(null);
  const [modalState, setModalState] = useState<{ item: KnowledgeItem; tab: ModalTab } | null>(null);

  const canWrite = (_currentUser.permissions ?? []).some(
    p => p === 'knowledge.write' || p === 'knowledge.*' || p === '*'
  );

  const loadItems = useCallback(async () => {
    setLoadingItems(true);
    try {
      const data = await api.listKnowledge();
      setItems(data);
    } catch { /* silent */ }
    finally { setLoadingItems(false); }
  }, []);

  useEffect(() => { loadItems(); }, [loadItems]);

  // Auto-poll while any item is still pending classification (background task may still be running).
  // Stops after 5 retries (~25 s) to avoid polling forever if Gemini is unavailable.
  useEffect(() => {
    const hasPending = items.some(i => !(i.citation_categories?.length));
    if (!hasPending) return;
    let retries = 0;
    const timer = setInterval(() => {
      retries++;
      loadItems();
      if (retries >= 5) clearInterval(timer);
    }, 5000);
    return () => clearInterval(timer);
  }, [items, loadItems]);

  const handleAdded = (item: KnowledgeItem) => {
    setItems(prev => [item, ...prev]);
    setTimeout(() => setTab('Knowledge Items'), 1200);
  };

  const handleDelete = async (id: number) => {
    try {
      await api.deleteKnowledge(id);
      setItems(prev => prev.filter(i => i.id !== id));
      setDeleteStatus({ type: 'success', text: 'Knowledge item and all its versions deleted.' });
    } catch (err) {
      setDeleteStatus({ type: 'error', text: err instanceof Error ? err.message : 'Delete failed.' });
    }
  };

  const openModal = (item: KnowledgeItem, modalTab: ModalTab = 'Chunks') => {
    setModalState({ item, tab: modalTab });
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-surface-0">
      {modalState && (
        <ItemDetailModal
          item={modalState.item}
          canWrite={canWrite}
          initialTab={modalState.tab}
          onClose={() => setModalState(null)}
          onRefresh={loadItems}
        />
      )}
      <div className="max-w-4xl mx-auto space-y-5">

        {/* Header */}
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Knowledge Base</h2>
          <p className="text-xs text-text-muted mt-1">
            Manage the content the AI uses to answer customer questions. All indexed items are automatically retrieved during conversations.
          </p>
        </div>

        {/* Stats bar */}
        <div className="flex items-center gap-4 bg-surface-2 ring-1 ring-surface-5 rounded-lg px-4 py-3">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.966 8.966 0 00-6 2.292m0-14.25v14.25" />
            </svg>
            <span className="text-xs text-text-secondary">
              <span className="font-semibold text-text-primary">{items.length}</span> item{items.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="w-px h-4 bg-surface-5" />
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-secondary">
              <span className="font-semibold text-text-primary">
                {items.reduce((sum, i) => sum + i.chunk_count, 0)}
              </span> total chunks indexed
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-green" />
            <span className="text-xs text-text-muted">RAG active</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="bg-surface-2 ring-1 ring-surface-5 rounded-lg overflow-hidden">
          <div className="flex border-b border-surface-5">
            {TABS.map(t => (
              // Hide "Add Knowledge" tab for read-only users
              (t === 'Add Knowledge' && !canWrite) ? null : (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-5 py-3 text-sm font-medium transition-colors ${
                    tab === t
                      ? 'text-text-primary border-b-2 border-brand -mb-px'
                      : 'text-text-muted hover:text-text-secondary'
                  }`}
                >
                  {t}
                </button>
              )
            ))}
          </div>

          <div className="p-5">
            {tab === 'Add Knowledge' && canWrite && (
              <div className="space-y-8">
                {/* URL section */}
                <div>
                  <h3 className="text-sm font-semibold text-text-primary mb-1 flex items-center gap-2">
                    <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                        d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
                    </svg>
                    Add from URL
                  </h3>
                  <AddUrlPanel onAdded={handleAdded} />
                </div>

                <div className="border-t border-surface-5" />

                {/* File section */}
                <div>
                  <h3 className="text-sm font-semibold text-text-primary mb-1 flex items-center gap-2">
                    <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                    </svg>
                    Upload Document
                  </h3>
                  <UploadFilePanel onAdded={handleAdded} />
                </div>
              </div>
            )}

            {tab === 'Knowledge Items' && (
              <div className="space-y-3">
                {deleteStatus && (
                  <StatusBanner msg={deleteStatus} onDismiss={() => setDeleteStatus(null)} />
                )}
                {canWrite && items.length > 0 && items.some(i => !(i.citation_categories?.length)) && (
                  <PendingCitationsBanner pendingCount={items.filter(i => !(i.citation_categories?.length)).length} onRefresh={loadItems} />
                )}
                {loadingItems ? (
                  <div className="flex items-center justify-center py-12 gap-2 text-text-muted text-sm">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
                    Loading…
                  </div>
                ) : (
                  <ItemsTable
                    items={items}
                    canWrite={canWrite}
                    onDelete={handleDelete}
                    onOpen={openModal}
                    onOverride={item => openModal(item, 'Version History')}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
