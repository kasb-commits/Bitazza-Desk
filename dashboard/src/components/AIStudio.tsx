/**
 * AI Studio — Visual workflow builder (n8n / Make.com style)
 *
 * Layout:
 *   [WorkflowList 220px] | [Canvas flex-1] | [ConfigPanel 280px]
 *
 * Node types match the workflow engine:
 *   send_reply · ai_reply · account_lookup · condition
 *   escalate · wait_for_reply · wait_for_trigger · resolve_ticket · set_variable
 */
import {
  useState, useCallback, useRef, useEffect, type ReactNode,
} from 'react';
import { usePerm } from '../PermissionContext';
import ReactFlow, {
  addEdge,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  type NodeProps,
  type Connection,
  type Edge,
  type Node,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Spinner } from './ui/Spinner';

// ── Constants ─────────────────────────────────────────────────────────────────

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

function getToken() {
  try { return (JSON.parse(localStorage.getItem('auth_user') ?? '{}')).token ?? ''; }
  catch { return ''; }
}

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` };
}

// ── Types ─────────────────────────────────────────────────────────────────────

type NodeKind =
  | 'send_reply' | 'ai_reply' | 'account_lookup' | 'condition'
  | 'escalate' | 'wait_for_reply' | 'wait_for_trigger' | 'resolve_ticket' | 'set_variable';

type StepState = 'pending' | 'running' | 'done' | 'error' | 'paused';

interface NodeData {
  kind: NodeKind;
  label: string;
  config: Record<string, unknown>;
  error?: boolean;
  testState?: StepState;
  isStart?: boolean;
}

interface WorkflowSummary {
  id: string;
  name: string;
  published: boolean;
  trigger_channel: string;
  trigger_category: string;
  created_by_name: string | null;
  updated_at: string;
}

interface TestStep {
  node_id: string;
  kind: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  variables_after: Record<string, unknown>;
  error: string | null;
  paused: boolean;
  waiting_for: string | null;
}

interface TestResult {
  steps: TestStep[];
  completed: boolean;
  error: string | null;
  conversation?: Array<{ role: 'user' | 'bot' | 'system'; text: string }>;
}

interface SeedVar { key: string; value: string; }

const DEFAULT_SEED_VARS: SeedVar[] = [
  { key: 'account.status',     value: 'approved' },
  { key: 'account.kyc_status', value: 'verified' },
  { key: 'account.tier',       value: 'Standard' },
];

// Auto-default store_as per tool — hidden from non-technical users
const TOOL_STORE_DEFAULTS: Record<string, string> = {
  profile:      'account',
  kyc_status:   'kyc',
  balance:      'balance',
  transactions: 'transactions',
  limits:       'limits',
};

const TOOL_LABELS: Record<string, string> = {
  profile:      'Profile (name, email, tier)',
  kyc_status:   'KYC Status',
  balance:      'Balance',
  transactions: 'Transactions',
  limits:       'Limits',
};

// ── Templates ──────────────────────────────────────────────────────────────────

const TEMPLATES = [
  {
    id: 'kyc',
    name: 'KYC Verification Flow',
    description: 'Check KYC status and guide the customer or escalate to the KYC team',
    trigger_channel: 'any',
    trigger_category: 'kyc_verification',
    nodes: [
      { id: 'n1', type: 'account_lookup', position: { x: 220, y: 60  }, data: { label: 'Fetch KYC Status', kind: 'account_lookup', config: { tool: 'kyc_status', store_as: 'kyc' } } },
      { id: 'n2', type: 'condition',      position: { x: 220, y: 200 }, data: { label: 'KYC approved?',    kind: 'condition',      config: { variable: 'kyc.status', operator: '==', value: 'approved' } } },
      { id: 'n3', type: 'send_reply',     position: { x: 60,  y: 370 }, data: { label: 'Approved message', kind: 'send_reply',     config: { text: 'Your KYC is fully approved. How can I help you today?' } } },
      { id: 'n4', type: 'resolve_ticket', position: { x: 60,  y: 520 }, data: { label: 'Resolve',          kind: 'resolve_ticket', config: { send_csat: true } } },
      { id: 'n5', type: 'escalate',       position: { x: 400, y: 370 }, data: { label: 'Escalate to KYC',  kind: 'escalate',       config: { team: 'kyc', reason: 'KYC not yet approved' } } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3', sourceHandle: 'true' },
      { id: 'e3', source: 'n2', target: 'n5', sourceHandle: 'false' },
      { id: 'e4', source: 'n3', target: 'n4' },
    ],
  },
  {
    id: 'password',
    name: 'Password / 2FA Reset Flow',
    description: 'Send reset instructions, wait for reply, then let AI handle and resolve',
    trigger_channel: 'any',
    trigger_category: 'password_2fa_reset',
    nodes: [
      { id: 'n1', type: 'send_reply',     position: { x: 220, y: 60  }, data: { label: 'Send instructions', kind: 'send_reply',     config: { text: 'To reset your password, please visit the app and tap "Forgot password". I\'ll wait here if you need more help.' } } },
      { id: 'n2', type: 'wait_for_reply', position: { x: 220, y: 210 }, data: { label: 'Wait for reply',    kind: 'wait_for_reply', config: {} } },
      { id: 'n3', type: 'ai_reply',       position: { x: 220, y: 360 }, data: { label: 'AI handles reply',  kind: 'ai_reply',       config: {} } },
      { id: 'n4', type: 'resolve_ticket', position: { x: 220, y: 510 }, data: { label: 'Resolve ticket',    kind: 'resolve_ticket', config: { send_csat: true } } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },
  {
    id: 'restriction',
    name: 'Account Restriction Flow',
    description: 'Look up account status and escalate to the right team or let AI assist',
    trigger_channel: 'any',
    trigger_category: 'account_restriction',
    nodes: [
      { id: 'n1', type: 'account_lookup', position: { x: 220, y: 60  }, data: { label: 'Fetch Account',     kind: 'account_lookup', config: { tool: 'profile', store_as: 'account' } } },
      { id: 'n2', type: 'condition',      position: { x: 220, y: 210 }, data: { label: 'Account restricted?', kind: 'condition',    config: { variable: 'account.status', operator: '==', value: 'restricted' } } },
      { id: 'n3', type: 'escalate',       position: { x: 60,  y: 380 }, data: { label: 'Escalate to CS',    kind: 'escalate',       config: { team: 'cs', reason: 'Account restriction requires manual review' } } },
      { id: 'n4', type: 'ai_reply',       position: { x: 400, y: 380 }, data: { label: 'AI handles reply',  kind: 'ai_reply',       config: {} } },
      { id: 'n5', type: 'resolve_ticket', position: { x: 400, y: 530 }, data: { label: 'Resolve',           kind: 'resolve_ticket', config: { send_csat: true } } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3', sourceHandle: 'true' },
      { id: 'e3', source: 'n2', target: 'n4', sourceHandle: 'false' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },
];

// ── Auto-layout ─────────────────────────────────────────────────────────────────
// Workflows seeded/inserted in engine format ({id, kind, config}) carry no canvas
// coordinates. Without positions every node defaults to the same point and the graph
// collapses into a single visible node. Derive a layered layout from the edge graph
// so these render faithfully. Loops (back-edges) are handled — a node keeps the level
// from the first time it's reached.
function autoLayoutPositions(
  nodes: { id: string }[],
  edges: { source?: string; target?: string }[],
): Map<string, { x: number; y: number }> {
  const X_GAP = 240, Y_GAP = 150, X0 = 120, Y0 = 40;
  const childrenOf = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  nodes.forEach(n => { childrenOf.set(n.id, []); indeg.set(n.id, 0); });
  edges.forEach(e => {
    if (e.source && e.target && childrenOf.has(e.source) && indeg.has(e.target)) {
      childrenOf.get(e.source)!.push(e.target);
      indeg.set(e.target, indeg.get(e.target)! + 1);
    }
  });

  // Roots = no incoming edge; fall back to the first node if the graph is fully cyclic.
  let roots = nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
  if (roots.length === 0 && nodes.length) roots = [nodes[0].id];

  const level = new Map<string, number>();
  const queue: string[] = [];
  roots.forEach(r => { level.set(r, 0); queue.push(r); });
  while (queue.length) {
    const id = queue.shift()!;
    const lvl = level.get(id)!;
    for (const c of childrenOf.get(id) ?? []) {
      if (!level.has(c)) { level.set(c, lvl + 1); queue.push(c); }
    }
  }

  // Place any disconnected nodes in trailing levels so nothing overlaps.
  let maxLvl = 0;
  level.forEach(v => { if (v > maxLvl) maxLvl = v; });
  nodes.forEach(n => { if (!level.has(n.id)) { maxLvl += 1; level.set(n.id, maxLvl); } });

  const byLevel = new Map<number, string[]>();
  nodes.forEach(n => {
    const lvl = level.get(n.id)!;
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl)!.push(n.id);
  });

  const pos = new Map<string, { x: number; y: number }>();
  byLevel.forEach((ids, lvl) => {
    ids.forEach((id, i) => {
      pos.set(id, { x: X0 + i * X_GAP, y: Y0 + lvl * Y_GAP });
    });
  });
  return pos;
}

// ── Node catalog ──────────────────────────────────────────────────────────────

interface NodeSpec {
  label: string;
  color: string;
  group: string;
  description: string;
  terminal?: boolean;      // no outgoing connection needed
  pauses?: boolean;        // pauses execution, waiting for input
}

const NODE_SPECS: Record<NodeKind, NodeSpec> = {
  send_reply:       { label: 'Send Reply',        color: '#3B82F6', group: 'Actions',    description: 'Send a fixed message to the customer' },
  ai_reply:         { label: 'AI Response',       color: '#8B5CF6', group: 'AI',         description: 'Let the AI engine handle a reply (pre+post filters enforced)' },
  account_lookup:   { label: 'Account Lookup',    color: '#6366F1', group: 'Account',    description: 'Fetch account info and store in variables' },
  condition:        { label: 'Condition',         color: '#F59E0B', group: 'Control',    description: 'Branch on a variable value (True / False)' },
  set_variable:     { label: 'Set Variable',      color: '#64748B', group: 'Control',    description: 'Store a value in a workflow variable' },
  escalate:         { label: 'Escalate',          color: '#EF4444', group: 'Escalation', description: 'Hand off to a human agent', terminal: true },
  wait_for_reply:   { label: 'Wait for Reply',    color: '#14B8A6', group: 'Wait',       description: 'Pause and wait for the next customer message', pauses: true, terminal: true },
  wait_for_trigger: { label: 'Wait for Trigger',  color: '#06B6D4', group: 'Wait',       description: 'Pause and wait for an external trigger (e.g. email verification)', pauses: true, terminal: true },
  resolve_ticket:   { label: 'Resolve Ticket',    color: '#22C55E', group: 'Actions',    description: 'Mark the ticket as resolved', terminal: true },
};

const GROUPS = ['AI', 'Actions', 'Account', 'Control', 'Wait', 'Escalation'];

const BUILT_IN_VARS = [
  'language', 'channel', 'category', 'user_id', 'conversation_id', 'user_message',
  'consecutive_low_confidence',
];
const ACCOUNT_VARS = ['account.status', 'account.balance', 'account.name', 'account.email', 'account.tier', 'account.rejection_reason'];
const AI_VARS      = ['ai_reply', 'escalated', 'confidence', 'upgraded_category'];

const ALL_VARS = [...BUILT_IN_VARS, ...ACCOUNT_VARS, ...AI_VARS];

// ── Node icons ────────────────────────────────────────────────────────────────

const KIND_ICON: Record<NodeKind, string> = {
  send_reply:       'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
  ai_reply:         'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
  account_lookup:   'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
  condition:        'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  escalate:         'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
  wait_for_reply:   'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  wait_for_trigger: 'M13 10V3L4 14h7v7l9-11h-7z',
  resolve_ticket:   'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  set_variable:     'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
};

// ── Custom ReactFlow nodes ────────────────────────────────────────────────────

function NodeShell({
  data, selected, children,
}: { data: NodeData; selected: boolean; children: ReactNode }) {
  const spec  = NODE_SPECS[data.kind];
  const color = data.error ? '#EF4444' : spec.color;

  const testRing =
    data.testState === 'running' ? 'ring-2 ring-blue-400 animate-pulse' :
    data.testState === 'done'    ? 'ring-2 ring-green-400' :
    data.testState === 'error'   ? 'ring-2 ring-red-500' :
    data.testState === 'paused'  ? 'ring-2 ring-amber-400' : '';

  return (
    <div className="relative">
      {data.isStart && (
        <div className="absolute -top-6 left-0 right-0 flex justify-center pointer-events-none">
          <span className="text-[9px] font-bold bg-green-500/20 text-green-400 border border-green-500/30 rounded-full px-2 py-0.5">
            ▶ START
          </span>
        </div>
      )}
      <div
        className={`bg-surface-2 rounded-lg min-w-[190px] max-w-[240px] shadow-card transition-all ${
          testRing || (selected ? 'ring-2 shadow-panel' : 'ring-1 ring-surface-5')
        } ${!testRing && data.error ? 'ring-red-500/60' : !testRing && selected ? 'ring-brand' : ''}`}
      >
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-t-lg border-b border-surface-4"
          style={{ borderLeft: `3px solid ${color}` }}
        >
          <svg className="w-3.5 h-3.5 shrink-0" style={{ color }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={KIND_ICON[data.kind]} />
          </svg>
          <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color }}>
            {spec.label}
          </span>
          {data.error && (
            <span className="ml-auto text-[10px] font-bold text-red-400">!</span>
          )}
        </div>
        <div className="px-3 py-2 text-xs text-text-secondary">{children}</div>
      </div>
    </div>
  );
}

// 14px handles — easier to grab than the original 10px
const hs = (color: string, extra?: object) => ({
  width: 14, height: 14,
  background: color,
  border: '2px solid var(--surface-2)',
  ...extra,
});

function SendReplyNode(p: NodeProps<NodeData>) {
  return (
    <NodeShell {...p}>
      <Handle type="target" position={Position.Top} style={hs(NODE_SPECS.send_reply.color)} title="Drag here to connect" />
      <p className="truncate text-text-muted italic">
        {(p.data.config.text as string) || 'Configure message…'}
      </p>
      <Handle type="source" position={Position.Bottom} style={hs(NODE_SPECS.send_reply.color)} title="Drag to connect to next step" />
      <Handle type="source" id="error" position={Position.Bottom} style={hs('#EF4444', { left: '85%', bottom: -7 })} title="On error → route here" />
    </NodeShell>
  );
}

function AiReplyNode(p: NodeProps<NodeData>) {
  return (
    <NodeShell {...p}>
      <Handle type="target" position={Position.Top} style={hs(NODE_SPECS.ai_reply.color)} title="Drag here to connect" />
      <p className="text-[11px] text-text-muted">AI handles reply with pre + post filters</p>
      <Handle type="source" position={Position.Bottom} style={hs(NODE_SPECS.ai_reply.color)} title="Drag to connect to next step" />
      <Handle type="source" id="error" position={Position.Bottom} style={hs('#EF4444', { left: '85%', bottom: -7 })} title="On error → route here" />
    </NodeShell>
  );
}

function AccountLookupNode(p: NodeProps<NodeData>) {
  return (
    <NodeShell {...p}>
      <Handle type="target" position={Position.Top} style={hs(NODE_SPECS.account_lookup.color)} title="Drag here to connect" />
      <p className="text-[11px] text-text-muted">
        {TOOL_LABELS[(p.data.config.tool as string)] || 'Select what to look up'}
      </p>
      {p.data.config.api_url && (
        <p className="text-[10px] text-indigo-400 truncate mt-0.5">🔗 Custom API</p>
      )}
      <Handle type="source" position={Position.Bottom} style={hs(NODE_SPECS.account_lookup.color)} title="Drag to connect to next step" />
      <Handle type="source" id="error" position={Position.Bottom} style={hs('#EF4444', { left: '85%', bottom: -7 })} title="On error → route here" />
    </NodeShell>
  );
}

function ConditionNode(p: NodeProps<NodeData>) {
  const conditions = p.data.config.conditions as Array<{variable: string; operator: string; value: string}> | undefined;
  const logic = (p.data.config.logic as string) || 'AND';
  return (
    <NodeShell {...p}>
      <Handle type="target" position={Position.Top} style={hs(NODE_SPECS.condition.color)} title="Drag here to connect" />
      {conditions && conditions.length > 0 ? (
        <div className="space-y-0.5">
          {conditions.slice(0, 2).map((c, i) => (
            <p key={i} className="font-mono text-[10px]">
              {i > 0 && <span className="text-amber-400 mr-1">{logic}</span>}
              <span className="text-text-secondary">{c.variable || 'var'}</span>{' '}
              <span className="text-amber-400">{c.operator || '=='}</span>{' '}
              <span className="text-text-secondary">{c.value || 'val'}</span>
            </p>
          ))}
          {conditions.length > 2 && <p className="text-[9px] text-text-muted">+{conditions.length - 2} more…</p>}
        </div>
      ) : (
        <p className="font-mono text-[11px]">
          <span className="text-text-secondary">{(p.data.config.variable as string) || 'var'}</span>
          {' '}<span className="text-amber-400">{(p.data.config.operator as string) || '=='}</span>{' '}
          <span className="text-text-secondary">{(p.data.config.value as string) || 'val'}</span>
        </p>
      )}
      {/* True/False labels above handles — visible outside the node body */}
      <div className="relative mt-2" style={{ height: 18 }}>
        <span className="absolute text-[9px] font-bold text-green-400" style={{ left: '18%', bottom: 0 }}>✓ True</span>
        <span className="absolute text-[9px] font-bold text-red-400"   style={{ left: '62%', bottom: 0 }}>✗ False</span>
      </div>
      <Handle
        type="source" id="true" position={Position.Bottom}
        style={hs('#22C55E', { left: '28%' })}
        title="True branch — drag to connect"
      />
      <Handle
        type="source" id="false" position={Position.Bottom}
        style={hs('#EF4444', { left: '72%' })}
        title="False branch — drag to connect"
      />
    </NodeShell>
  );
}

function EscalateNode(p: NodeProps<NodeData>) {
  return (
    <NodeShell {...p}>
      <Handle type="target" position={Position.Top} style={hs(NODE_SPECS.escalate.color)} />
      <p className="text-[11px] text-red-400 font-semibold">→ Human agent</p>
      {p.data.config.reason && (
        <p className="text-[10px] text-text-muted truncate mt-0.5">{p.data.config.reason as string}</p>
      )}
    </NodeShell>
  );
}

function WaitForReplyNode(p: NodeProps<NodeData>) {
  return (
    <NodeShell {...p}>
      <Handle type="target" position={Position.Top} style={hs(NODE_SPECS.wait_for_reply.color)} />
      <p className="text-[11px] text-teal-400">Pause — await customer reply</p>
    </NodeShell>
  );
}

function WaitForTriggerNode(p: NodeProps<NodeData>) {
  return (
    <NodeShell {...p}>
      <Handle type="target" position={Position.Top} style={hs(NODE_SPECS.wait_for_trigger.color)} />
      <p className="text-[11px] text-cyan-400">
        {(p.data.config.trigger_type as string) || 'external_trigger'}
      </p>
    </NodeShell>
  );
}

function ResolveTicketNode(p: NodeProps<NodeData>) {
  return (
    <NodeShell {...p}>
      <Handle type="target" position={Position.Top} style={hs(NODE_SPECS.resolve_ticket.color)} />
      <p className="text-[11px] text-green-400 font-semibold">✓ Resolve ticket</p>
      {p.data.config.send_csat && (
        <p className="text-[10px] text-text-muted mt-0.5">+ Send CSAT survey</p>
      )}
    </NodeShell>
  );
}

function SetVariableNode(p: NodeProps<NodeData>) {
  return (
    <NodeShell {...p}>
      <Handle type="target" position={Position.Top} style={hs(NODE_SPECS.set_variable.color)} title="Drag here to connect" />
      <p className="font-mono text-[11px] text-text-secondary truncate">
        {(p.data.config.variable_name as string) || 'var'} = {(p.data.config.value as string) || '…'}
      </p>
      <Handle type="source" position={Position.Bottom} style={hs(NODE_SPECS.set_variable.color)} title="Drag to connect to next step" />
      <Handle type="source" id="error" position={Position.Bottom} style={hs('#EF4444', { left: '85%', bottom: -7 })} title="On error → route here" />
    </NodeShell>
  );
}

const NODE_TYPES = {
  send_reply: SendReplyNode,
  ai_reply: AiReplyNode,
  account_lookup: AccountLookupNode,
  condition: ConditionNode,
  escalate: EscalateNode,
  wait_for_reply: WaitForReplyNode,
  wait_for_trigger: WaitForTriggerNode,
  resolve_ticket: ResolveTicketNode,
  set_variable: SetVariableNode,
};

// ── Variable picker ───────────────────────────────────────────────────────────

function VarPicker({ onPick }: { onPick: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="text-[10px] text-text-muted hover:text-text-secondary border border-surface-5 rounded px-1.5 py-0.5 transition-colors"
        title="Insert variable"
      >
        {'{{}}'}
      </button>
      {open && (
        <div className="absolute z-50 top-6 right-0 bg-surface-3 border border-surface-5 rounded-md shadow-modal w-48 py-1 max-h-52 overflow-y-auto">
          {ALL_VARS.map(v => (
            <button
              key={v}
              type="button"
              className="w-full text-left px-3 py-1 text-[11px] font-mono text-text-secondary hover:bg-surface-4 hover:text-text-primary transition-colors"
              onClick={() => { onPick(`{{${v}}}`); setOpen(false); }}
            >
              {v}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Field helpers ─────────────────────────────────────────────────────────────

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <label className="text-[10px] text-text-muted uppercase tracking-wide block mb-1">
      {children}
    </label>
  );
}

function TextInput({
  value, onChange, placeholder, mono,
}: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full text-xs bg-surface-1 ring-1 ring-surface-5 rounded px-2.5 py-1.5 text-text-primary placeholder:text-text-muted outline-none focus:ring-brand transition-all ${mono ? 'font-mono' : ''}`}
    />
  );
}

function SelectInput({
  value, onChange, options,
}: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full text-xs bg-surface-1 ring-1 ring-surface-5 rounded px-2.5 py-1.5 text-text-primary outline-none focus:ring-brand transition-all"
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <FieldLabel>{label}</FieldLabel>
      {children}
    </div>
  );
}

function VarField({
  label, value, onChange, placeholder, mono,
}: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <FieldLabel>{label}</FieldLabel>
        <VarPicker onPick={v => onChange(value + v)} />
      </div>
      <TextInput value={value} onChange={onChange} placeholder={placeholder} mono={mono} />
    </div>
  );
}

// ── NodeConfigPanel ───────────────────────────────────────────────────────────

interface ConfigPanelProps {
  node: Node<NodeData> | null;
  onChange: (id: string, config: Partial<Record<string, unknown>>, label?: string) => void;
  onDelete: (id: string) => void;
  testStep?: TestStep | null;
}

function JsonBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-text-muted italic">null</span>;
  const str = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  return (
    <pre className="text-[10px] font-mono bg-surface-0 border border-surface-5 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-words text-text-secondary max-h-36 overflow-y-auto">
      {str}
    </pre>
  );
}

function NodeConfigPanel({ node, onChange, onDelete, testStep }: ConfigPanelProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ── Test step log view ──────────────────────────────────────────────────────
  if (testStep) {
    const spec  = NODE_SPECS[testStep.kind as NodeKind];
    const color = spec?.color || '#64748B';
    const stateLabel = testStep.error ? '✕ Error' : testStep.paused ? '⏸ Paused' : '✓ Done';
    const stateColor = testStep.error ? 'text-red-400' : testStep.paused ? 'text-amber-400' : 'text-green-400';

    return (
      <div className="w-[280px] shrink-0 border-l border-surface-5 bg-surface-1 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-5 flex items-center gap-2 shrink-0">
          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
          <span className="text-xs font-semibold text-text-primary">{spec?.label || testStep.kind}</span>
          <span className={`ml-auto text-[10px] font-bold ${stateColor}`}>{stateLabel}</span>
        </div>
        <div className="px-4 py-3 overflow-y-auto flex-1 space-y-3">
          {testStep.error && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide text-red-400 mb-1">Error</p>
              <pre className="text-[10px] font-mono bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5 text-red-300 whitespace-pre-wrap break-words">
                {testStep.error}
              </pre>
            </div>
          )}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-text-muted mb-1">Input</p>
            <JsonBlock value={testStep.input} />
          </div>
          {testStep.output !== null && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide text-text-muted mb-1">Output</p>
              <JsonBlock value={testStep.output} />
            </div>
          )}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-text-muted mb-1">Variables after</p>
            <JsonBlock value={testStep.variables_after} />
          </div>
          {testStep.paused && testStep.waiting_for && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide text-amber-400 mb-1">Waiting for</p>
              <p className="text-xs font-mono text-text-secondary">{testStep.waiting_for}</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!node) {
    return (
      <div className="w-[280px] shrink-0 border-l border-surface-5 bg-surface-1 flex items-center justify-center">
        <div className="text-center px-6 py-8">
          <svg className="w-9 h-9 text-text-muted mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5" />
          </svg>
          <p className="text-xs text-text-muted">Select a node to configure it</p>
          <p className="text-[10px] text-text-muted mt-1 opacity-60">Or drag a module from the left panel</p>
        </div>
      </div>
    );
  }

  const spec   = NODE_SPECS[node.data.kind];
  const cfg    = node.data.config as Record<string, string>;
  const set    = (key: string, val: unknown) => onChange(node.id, { [key]: val });

  return (
    <div className="w-[280px] shrink-0 border-l border-surface-5 bg-surface-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-surface-5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: spec.color }} />
          <span className="text-xs font-semibold text-text-primary">{spec.label}</span>
        </div>
        <button
          onClick={() => onDelete(node.id)}
          className="text-[10px] text-text-muted hover:text-red-400 transition-colors px-1.5 py-0.5 rounded hover:bg-red-400/10"
        >
          Delete
        </button>
      </div>

      {/* Description */}
      <p className="text-[10px] text-text-muted px-4 py-2 border-b border-surface-5 shrink-0">{spec.description}</p>

      {/* Config fields */}
      <div className="px-4 py-3 overflow-y-auto flex-1">
        {/* Label (common) */}
        <FieldRow label="Label">
          <TextInput value={node.data.label} onChange={v => onChange(node.id, {}, v)} placeholder="Node label" />
        </FieldRow>

        {/* send_reply */}
        {node.data.kind === 'send_reply' && (
          <>
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1">
                <FieldLabel>Message text</FieldLabel>
                <VarPicker onPick={v => set('text', (cfg.text || '') + v)} />
              </div>
              <textarea
                value={cfg.text || ''}
                onChange={e => set('text', e.target.value)}
                placeholder="Message sent to the customer…"
                rows={4}
                className="w-full text-xs bg-surface-1 ring-1 ring-surface-5 rounded px-2.5 py-1.5 text-text-primary placeholder:text-text-muted outline-none focus:ring-brand resize-none transition-all"
              />
            </div>
          </>
        )}

        {/* ai_reply — bot selector + security info */}
        {node.data.kind === 'ai_reply' && (
          <>
            <FieldRow label="Which bot handles this?">
              <SelectInput
                value={(cfg.ai_persona as string) || ''}
                onChange={v => onChange(node.id, { ai_persona: v || undefined })}
                options={[
                  { value: '',     label: 'Aria (default)' },
                ]}
              />
            </FieldRow>
            <div className="bg-surface-3 border border-surface-5 rounded-md px-3 py-2.5 text-[11px] text-text-muted space-y-1.5 mt-1">
              <p className="font-medium text-text-secondary">Security invariants (not configurable)</p>
              <p>1. <span className="font-mono text-xs text-purple-400">security_filter</span> runs BEFORE generation</p>
              <p>2. <span className="font-mono text-xs text-purple-400">compliance_filter</span> runs AFTER generation</p>
              <p className="text-[10px] opacity-70 mt-1">Sets: <span className="font-mono">ai_reply · escalated · confidence · upgraded_category</span></p>
            </div>
          </>
        )}

        {/* account_lookup */}
        {node.data.kind === 'account_lookup' && (() => {
          const currentTool = cfg.tool || 'profile';
          const handleToolChange = (v: string) => {
            onChange(node.id, { tool: v, store_as: TOOL_STORE_DEFAULTS[v] ?? v });
          };
          return (
            <>
              <FieldRow label="What to look up">
                <SelectInput
                  value={currentTool}
                  onChange={handleToolChange}
                  options={[
                    { value: 'profile',      label: 'Profile (name, email, tier)' },
                    { value: 'kyc_status',   label: 'KYC Status' },
                    { value: 'balance',      label: 'Balance' },
                    { value: 'transactions', label: 'Transactions' },
                    { value: 'limits',       label: 'Limits' },
                  ]}
                />
              </FieldRow>
              <div className="border-t border-surface-5 pt-3 mt-1">
                <button
                  onClick={() => setShowAdvanced(s => !s)}
                  className="text-[10px] text-text-muted hover:text-text-secondary w-full text-left flex items-center gap-1"
                >
                  <span>{showAdvanced ? '▾' : '▸'}</span> Advanced
                </button>
                {showAdvanced && (
                  <div className="mt-2 space-y-2">
                    <FieldRow label="Variable name">
                      <TextInput
                        value={cfg.store_as || TOOL_STORE_DEFAULTS[currentTool] || 'account'}
                        onChange={v => set('store_as', v)}
                        placeholder={TOOL_STORE_DEFAULTS[currentTool] || 'account'}
                        mono
                      />
                    </FieldRow>
                    <p className="text-[10px] text-text-muted leading-relaxed">
                      Only change this if you use two lookup nodes in the same workflow — give them different names so they don't overwrite each other.
                    </p>
                    <FieldRow label="API Base URL">
                      <TextInput
                        value={cfg.api_url || ''}
                        onChange={v => set('api_url', v)}
                        placeholder="https://api.example.com/v1"
                      />
                    </FieldRow>
                    <FieldRow label="API Key">
                      <input
                        type="password"
                        value={cfg.api_key || ''}
                        onChange={e => set('api_key', e.target.value)}
                        placeholder="Leave blank to use system default"
                        className="w-full text-xs bg-surface-1 ring-1 ring-surface-5 rounded px-2.5 py-1.5 text-text-primary placeholder:text-text-muted outline-none focus:ring-brand transition-all"
                      />
                    </FieldRow>
                    <p className="text-[10px] text-text-muted opacity-70">Leave blank to use the system-configured API.</p>
                  </div>
                )}
              </div>
            </>
          );
        })()}

        {/* condition */}
        {node.data.kind === 'condition' && (() => {
          // Normalize: if old single-condition format, migrate to conditions array
          const rawConditions = (node.data.config.conditions as Array<{variable:string;operator:string;value:string}> | undefined);
          const clauses: Array<{variable:string;operator:string;value:string}> = rawConditions && rawConditions.length > 0
            ? rawConditions
            : [{ variable: cfg.variable || '', operator: cfg.operator || '==', value: cfg.value || '' }];
          const logic = (node.data.config.logic as string) || 'AND';

          const setClause = (i: number, field: string, val: string) => {
            const updated = clauses.map((c, idx) => idx === i ? { ...c, [field]: val } : c);
            onChange(node.id, { conditions: updated, logic, variable: undefined, operator: undefined, value: undefined });
          };
          const addClause = () => {
            onChange(node.id, { conditions: [...clauses, { variable: '', operator: '==', value: '' }], logic });
          };
          const removeClause = (i: number) => {
            const updated = clauses.filter((_, idx) => idx !== i);
            onChange(node.id, { conditions: updated.length ? updated : clauses, logic });
          };
          const opOptions = [
            { value: '==', label: '== equals' }, { value: '!=', label: '!= not equals' },
            { value: 'contains', label: 'contains' }, { value: 'starts_with', label: 'starts with' },
            { value: '>', label: '> greater than' }, { value: '<', label: '< less than' },
          ];
          return (
            <>
              {clauses.length > 1 && (
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-[10px] text-text-muted">Match</span>
                  {(['AND','OR'] as const).map(l => (
                    <button key={l} type="button"
                      onClick={() => onChange(node.id, { conditions: clauses, logic: l })}
                      className={`text-[10px] font-bold px-2 py-0.5 rounded border transition-colors ${
                        logic === l
                          ? 'bg-brand/15 border-brand/40 text-brand'
                          : 'border-surface-5 text-text-muted hover:text-text-secondary'
                      }`}>{l}</button>
                  ))}
                  <span className="text-[10px] text-text-muted">conditions</span>
                </div>
              )}
              {clauses.map((clause, i) => (
                <div key={i} className="mb-2 bg-surface-3 rounded p-2 space-y-1.5">
                  {i > 0 && (
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] font-bold text-amber-400">{logic}</span>
                      <button type="button" onClick={() => removeClause(i)}
                        className="text-[10px] text-red-400 hover:text-red-300">✕</button>
                    </div>
                  )}
                  {i === 0 && clauses.length > 1 && (
                    <div className="flex justify-end">
                      <button type="button" onClick={() => removeClause(i)}
                        className="text-[10px] text-red-400 hover:text-red-300">✕</button>
                    </div>
                  )}
                  <VarField label="Variable" value={clause.variable} onChange={v => setClause(i, 'variable', v)} placeholder="e.g. account.status" mono />
                  <FieldRow label="Operator">
                    <SelectInput value={clause.operator || '=='} onChange={v => setClause(i, 'operator', v)} options={opOptions} />
                  </FieldRow>
                  <VarField label="Value" value={clause.value} onChange={v => setClause(i, 'value', v)} placeholder="e.g. approved" />
                </div>
              ))}
              <button type="button" onClick={addClause}
                className="w-full text-[10px] text-text-muted hover:text-brand border border-dashed border-surface-5 hover:border-brand/40 rounded py-1.5 transition-colors mb-3">
                + Add condition
              </button>
              <div className="bg-surface-3 border border-surface-5 rounded px-2.5 py-2 text-[10px] text-text-muted">
                Drag the <span className="text-green-400 font-bold">✓ True</span> handle (left) and{' '}
                <span className="text-red-400 font-bold">✗ False</span> handle (right) to connect branches.
              </div>
            </>
          );
        })()}

        {/* escalate */}
        {node.data.kind === 'escalate' && (
          <>
            <VarField
              label="Reason (optional)"
              value={cfg.reason || ''}
              onChange={v => set('reason', v)}
              placeholder="e.g. KYC verification required"
            />
            <FieldRow label="Team">
              <SelectInput
                value={cfg.team || 'cs'}
                onChange={v => set('team', v)}
                options={[
                  { value: 'cs',      label: 'CS (default)' },
                  { value: 'kyc',     label: 'KYC Team' },
                  { value: 'finance', label: 'Finance' },
                  { value: 'tech',    label: 'Tech Support' },
                ]}
              />
            </FieldRow>
          </>
        )}

        {/* wait_for_reply — no config */}
        {node.data.kind === 'wait_for_reply' && (
          <div className="bg-surface-3 border border-surface-5 rounded px-2.5 py-2 text-[10px] text-text-muted">
            Execution pauses here. When the customer sends their next message, the workflow resumes from the node after this one.
          </div>
        )}

        {/* wait_for_trigger */}
        {node.data.kind === 'wait_for_trigger' && (
          <>
            <FieldRow label="Trigger type">
              <SelectInput
                value={cfg.trigger_type || 'email_verification'}
                onChange={v => set('trigger_type', v)}
                options={[
                  { value: 'email_verification', label: 'Email verification' },
                  { value: 'custom',             label: 'Custom external trigger' },
                ]}
              />
            </FieldRow>
            <FieldRow label="Store token as">
              <TextInput
                value={cfg.token_variable || 'verification_token'}
                onChange={v => set('token_variable', v)}
                placeholder="verification_token"
                mono
              />
            </FieldRow>
          </>
        )}

        {/* resolve_ticket */}
        {node.data.kind === 'resolve_ticket' && (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={!!cfg.send_csat}
              onChange={e => set('send_csat', e.target.checked)}
              className="accent-brand"
            />
            <span className="text-xs text-text-secondary">Send CSAT survey after resolving</span>
          </label>
        )}

        {/* set_variable */}
        {node.data.kind === 'set_variable' && (
          <>
            <FieldRow label="Variable name">
              <TextInput
                value={cfg.variable_name || ''}
                onChange={v => set('variable_name', v)}
                placeholder="e.g. intent"
                mono
              />
            </FieldRow>
            <VarField
              label="Value"
              value={cfg.value || ''}
              onChange={v => set('value', v)}
              placeholder="e.g. {{user_message}} or literal"
            />
          </>
        )}
      </div>
    </div>
  );
}

// ── WorkflowList ──────────────────────────────────────────────────────────────

interface WorkflowListProps {
  workflows: WorkflowSummary[];
  activeId: string | null;
  loading: boolean;
  canCreate: boolean;
  canDelete: boolean;
  canPublish: boolean;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleActive: (id: string, currentlyPublished: boolean) => void;
}

function WorkflowList({ workflows, activeId, loading, canCreate, canDelete, canPublish, onCreate, onSelect, onDelete, onToggleActive }: WorkflowListProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-3 border-b border-surface-5 flex items-center justify-between shrink-0">
        <span className="text-[10px] font-bold uppercase tracking-wider text-text-muted">Workflows</span>
        {canCreate && (
          <button
            onClick={onCreate}
            className="text-[10px] bg-brand hover:bg-brand-dim text-white rounded px-2 py-1 transition-colors font-medium"
          >
            + New
          </button>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto py-1">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Spinner size="sm" />
          </div>
        )}
        {!loading && workflows.length === 0 && (
          <div className="text-center px-4 py-8">
            <p className="text-[11px] text-text-muted">No workflows yet</p>
            <p className="text-[10px] text-text-muted opacity-60 mt-1">Click + New to create one</p>
          </div>
        )}
        {workflows.map(wf => (
          <div
            key={wf.id}
            className={`group relative px-3 py-2.5 cursor-pointer transition-colors border-l-2 ${
              activeId === wf.id
                ? 'bg-surface-3 border-brand'
                : 'border-transparent hover:bg-surface-2 hover:border-surface-5'
            }`}
            onClick={() => onSelect(wf.id)}
          >
            <div className="flex items-start justify-between gap-1">
              <p className={`text-xs font-medium truncate ${activeId === wf.id ? 'text-text-primary' : 'text-text-secondary'}`}>
                {wf.name}
              </p>
              <span className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                wf.published
                  ? 'bg-green-500/15 text-green-400'
                  : 'bg-surface-5 text-text-muted'
              }`}>
                {wf.published ? 'Live' : 'Draft'}
              </span>
            </div>
            <div className="flex items-center justify-between mt-0.5">
              <p className="text-[10px] text-text-muted">
                {wf.trigger_channel} · {wf.trigger_category}
              </p>
              {/* Action buttons */}
              <div className="flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
                {canPublish && (
                  <button
                    onClick={() => onToggleActive(wf.id, wf.published)}
                    className={`text-[10px] px-1.5 py-0.5 rounded transition-colors font-medium ${
                      wf.published
                        ? 'text-yellow-400 hover:bg-yellow-400/10'
                        : 'text-green-400 hover:bg-green-400/10'
                    }`}
                    title={wf.published ? 'Deactivate' : 'Activate'}
                  >
                    {wf.published ? 'Deactivate' : 'Activate'}
                  </button>
                )}
                {canDelete && (
                  <button
                    onClick={() => onDelete(wf.id)}
                    className="text-[10px] text-red-400 hover:bg-red-400/10 px-1.5 py-0.5 rounded transition-colors font-medium"
                    title="Delete workflow"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── NodePalette ───────────────────────────────────────────────────────────────

function NodePalette({ onAdd }: { onAdd: (kind: NodeKind) => void }) {
  return (
    <div className="border-t border-surface-5 flex flex-col shrink-0">
      <div className="px-3 py-2 border-b border-surface-5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-text-muted">Modules</span>
      </div>
      <div className="overflow-y-auto max-h-[320px] py-1">
        {GROUPS.map(group => {
          const entries = (Object.entries(NODE_SPECS) as [NodeKind, NodeSpec][])
            .filter(([, s]) => s.group === group);
          if (!entries.length) return null;
          return (
            <div key={group} className="px-2 py-1.5">
              <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted px-1 mb-1">{group}</p>
              {entries.map(([kind, spec]) => (
                <button
                  key={kind}
                  onClick={() => onAdd(kind)}
                  className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-3 transition-colors group"
                >
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ background: spec.color }} />
                  <span className="text-[11px] text-text-secondary group-hover:text-text-primary">{spec.label}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── TestRunPanel ──────────────────────────────────────────────────────────────

interface TestRunPanelProps {
  workflowId: string | null;
  onClose: () => void;
  onStepSelect: (step: TestStep | null) => void;
  onNodeHighlight: (states: Record<string, StepState>) => void;
  selectedStepId: string | null;
}

const STEP_DELAY = 650; // ms between steps

function TestRunPanel({ workflowId, onClose, onStepSelect, onNodeHighlight, selectedStepId }: TestRunPanelProps) {
  const [sampleMessage, setSampleMessage] = useState('Hello, I need help with my KYC verification');
  const [channel,       setChannel]       = useState('widget');
  const [category,      setCategory]      = useState('kyc_verification');
  const [language,      setLanguage]      = useState('en');
  const [userId,        setUserId]        = useState('');
  const [seedVars,      setSeedVars]      = useState<SeedVar[]>(DEFAULT_SEED_VARS.map(v => ({ ...v })));
  const [showJsonEditor,setShowJsonEditor]= useState(false);
  const [jsonRaw,       setJsonRaw]       = useState('');
  const [jsonError,     setJsonError]     = useState('');
  const [fetching,      setFetching]      = useState(false);
  const [allSteps,      setAllSteps]      = useState<TestStep[]>([]);
  const [visibleCount,  setVisibleCount]  = useState(0);
  const [runningIdx,    setRunningIdx]    = useState<number | null>(null);
  const [finalResult,   setFinalResult]   = useState<TestResult | null>(null);
  const [centerTab,     setCenterTab]     = useState<'preview' | 'steps'>('preview');
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => { timersRef.current.forEach(clearTimeout); timersRef.current = []; };

  const run = async () => {
    if (!workflowId) return;

    let extra_variables: Record<string, unknown> = {};
    if (showJsonEditor && jsonRaw.trim()) {
      try { extra_variables = JSON.parse(jsonRaw); setJsonError(''); }
      catch { setJsonError('Invalid JSON'); return; }
    } else {
      seedVars.filter(v => v.key.trim()).forEach(v => { extra_variables[v.key] = v.value; });
    }

    // Reset
    clearTimers();
    setFetching(true);
    setAllSteps([]);
    setVisibleCount(0);
    setRunningIdx(null);
    setFinalResult(null);
    onStepSelect(null);
    onNodeHighlight({});

    try {
      const r = await fetch(`${API}/api/studio/flows/${workflowId}/test-run`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          sample_message: sampleMessage, channel, category, language,
          user_id: userId.trim() || 'test-user',
          extra_variables,
        }),
      });
      const data: TestResult = await r.json();
      setAllSteps(data.steps);
      setFinalResult(data);

      // Animate step reveal
      const nodeStates: Record<string, StepState> = {};
      data.steps.forEach((step, i) => {
        // Show spinner on this node
        timersRef.current.push(setTimeout(() => {
          setRunningIdx(i);
          nodeStates[step.node_id] = 'running';
          onNodeHighlight({ ...nodeStates });
        }, i * STEP_DELAY));

        // Resolve to done/error/paused
        timersRef.current.push(setTimeout(() => {
          const s: StepState = step.error ? 'error' : step.paused ? 'paused' : 'done';
          nodeStates[step.node_id] = s;
          setVisibleCount(i + 1);
          setRunningIdx(null);
          onNodeHighlight({ ...nodeStates });
        }, i * STEP_DELAY + STEP_DELAY - 150));
      });

    } catch (e) {
      setFinalResult({ steps: [], completed: false, error: String(e) });
    } finally {
      setFetching(false);
    }
  };

  const isAnimating = runningIdx !== null || (fetching);
  const showSummary = finalResult && visibleCount >= allSteps.length && !isAnimating;

  return (
    <div className="absolute inset-x-0 bottom-0 bg-surface-1 border-t border-surface-5 flex flex-col shadow-modal"
      style={{ height: '44%', zIndex: 20 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-5 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold text-text-primary">Test Run</span>
          {showSummary && (
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
              finalResult!.error ? 'bg-red-500/15 text-red-400' :
              finalResult!.completed ? 'bg-green-500/15 text-green-400' :
              'bg-amber-500/15 text-amber-400'
            }`}>
              {finalResult!.error ? '✕ Error' : finalResult!.completed ? '✓ Completed' : '⏸ Paused'}
            </span>
          )}
        </div>
        <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">

        {/* Left: inputs */}
        <div className="w-[260px] shrink-0 border-r border-surface-5 px-3 py-3 space-y-2.5 overflow-y-auto">
          <div>
            <FieldLabel>Message</FieldLabel>
            <textarea value={sampleMessage} onChange={e => setSampleMessage(e.target.value)} rows={3}
              className="w-full text-xs bg-surface-2 ring-1 ring-surface-5 rounded px-2.5 py-1.5 text-text-primary outline-none focus:ring-brand resize-none" />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <div><FieldLabel>Channel</FieldLabel>
              <SelectInput value={channel} onChange={setChannel} options={[
                { value: 'widget', label: 'Widget' }, { value: 'email', label: 'Email' },
              ]} />
            </div>
            <div><FieldLabel>Language</FieldLabel>
              <SelectInput value={language} onChange={setLanguage} options={[
                { value: 'en', label: 'EN' }, { value: 'th', label: 'TH' },
              ]} />
            </div>
          </div>
          <div><FieldLabel>Category</FieldLabel>
            <SelectInput value={category} onChange={setCategory} options={[
              { value: 'any', label: 'Any' },
              { value: 'kyc_verification', label: 'KYC' },
              { value: 'account_restriction', label: 'Account' },
              { value: 'password_2fa_reset', label: '2FA / Password' },
              { value: 'withdrawal_issue', label: 'Withdrawal' },
              { value: 'fraud_security', label: 'Fraud' },
              { value: 'other', label: 'Other' },
            ]} />
          </div>
          <div><FieldLabel>User ID</FieldLabel>
            <TextInput value={userId} onChange={setUserId} placeholder="USR-000009 or blank" mono />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <FieldLabel>Test variables</FieldLabel>
              <button type="button" onClick={() => setShowJsonEditor(v => !v)}
                className="text-[10px] text-text-muted hover:text-text-secondary transition-colors">
                {showJsonEditor ? 'Simple ↑' : 'Edit JSON ↓'}
              </button>
            </div>
            {showJsonEditor ? (
              <>
                <textarea value={jsonRaw} onChange={e => { setJsonRaw(e.target.value); setJsonError(''); }}
                  rows={3} placeholder='{"account.status":"approved"}'
                  className="w-full text-xs font-mono bg-surface-2 ring-1 ring-surface-5 rounded px-2.5 py-1.5 text-text-primary outline-none focus:ring-brand resize-none placeholder:text-text-muted" />
                {jsonError && <p className="text-[10px] text-red-400 mt-0.5">{jsonError}</p>}
              </>
            ) : (
              <div className="space-y-1">
                {seedVars.map((sv, i) => (
                  <div key={i} className="flex gap-1 items-center">
                    <input value={sv.key} onChange={e => setSeedVars(vs => vs.map((v, j) => j === i ? { ...v, key: e.target.value } : v))}
                      placeholder="variable.path"
                      className="flex-1 min-w-0 text-[10px] font-mono bg-surface-2 ring-1 ring-surface-5 rounded px-2 py-1 text-text-primary outline-none focus:ring-brand" />
                    <span className="text-text-muted text-[10px] shrink-0">=</span>
                    <input value={sv.value} onChange={e => setSeedVars(vs => vs.map((v, j) => j === i ? { ...v, value: e.target.value } : v))}
                      placeholder="value"
                      className="flex-1 min-w-0 text-[10px] bg-surface-2 ring-1 ring-surface-5 rounded px-2 py-1 text-text-primary outline-none focus:ring-brand" />
                    <button type="button" onClick={() => setSeedVars(vs => vs.filter((_, j) => j !== i))}
                      className="text-text-muted hover:text-red-400 text-xs shrink-0">✕</button>
                  </div>
                ))}
                <button type="button" onClick={() => setSeedVars(vs => [...vs, { key: '', value: '' }])}
                  className="text-[10px] text-text-muted hover:text-brand w-full text-left transition-colors">
                  + Add variable
                </button>
              </div>
            )}
          </div>
          <button onClick={run} disabled={isAnimating || fetching || !workflowId}
            className="w-full text-xs bg-brand hover:bg-brand-dim text-white rounded px-3 py-2 transition-colors disabled:opacity-40 flex items-center justify-center gap-1.5">
            {fetching ? <><Spinner size="xs" /> Fetching…</> :
             isAnimating ? <><Spinner size="xs" /> Running…</> : '▶  Run Test'}
          </button>
        </div>

        {/* Center: preview or step trace */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Tab toggle */}
          <div className="flex items-center border-b border-surface-5 px-4 shrink-0">
            {(['preview', 'steps'] as const).map(tab => (
              <button key={tab} onClick={() => setCenterTab(tab)}
                className={`text-[10px] font-semibold px-3 py-2 border-b-2 transition-colors capitalize ${
                  centerTab === tab ? 'border-brand text-brand' : 'border-transparent text-text-muted hover:text-text-secondary'
                }`}>{tab === 'preview' ? 'Preview' : 'Steps (debug)'}</button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3">
          {!fetching && allSteps.length === 0 && !finalResult && (
            <div className="flex items-center justify-center h-full text-text-muted text-xs">
              Configure inputs and click Run Test
            </div>
          )}

          {/* Preview tab: conversation bubbles */}
          {centerTab === 'preview' && finalResult?.conversation && (
            <div className="space-y-2">
              {finalResult.conversation.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : msg.role === 'system' ? 'justify-center' : 'justify-start'}`}>
                  {msg.role === 'system' ? (
                    <span className="text-[10px] text-text-muted italic px-3 py-1 bg-surface-3 rounded-full border border-surface-5">{msg.text}</span>
                  ) : (
                    <div className={`max-w-[75%] px-3 py-2 rounded-xl text-xs ${
                      msg.role === 'user'
                        ? 'bg-brand/20 text-text-primary rounded-br-sm'
                        : 'bg-surface-3 text-text-secondary rounded-bl-sm border border-surface-5'
                    }`}>
                      {msg.text}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {centerTab === 'preview' && finalResult && !finalResult.conversation?.length && (
            <div className="flex items-center justify-center h-full text-text-muted text-xs">
              No messages sent in this run
            </div>
          )}

          {/* Step list (debug tab) */}
          {centerTab === 'steps' && <div className="space-y-2 pb-2">
            {allSteps.slice(0, Math.max(visibleCount, runningIdx !== null ? runningIdx + 1 : 0)).map((step, i) => {
              const spec    = NODE_SPECS[step.kind as NodeKind];
              const color   = spec?.color || '#64748B';
              const isRun   = runningIdx === i;
              const isDone  = i < visibleCount;
              const hasErr  = !!step.error;
              const isPaused= step.paused;
              const isSel   = selectedStepId === step.node_id;

              let statusIcon: ReactNode;
              if (isRun) {
                statusIcon = <Spinner size="xs" />;
              } else if (!isDone) {
                statusIcon = null;
              } else if (hasErr) {
                statusIcon = (
                  <svg className="w-4 h-4 text-red-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                );
              } else if (isPaused) {
                statusIcon = (
                  <svg className="w-4 h-4 text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6" />
                  </svg>
                );
              } else {
                statusIcon = (
                  <svg className="w-4 h-4 text-green-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                );
              }

              return (
                <button
                  key={step.node_id + i}
                  onClick={() => isDone ? onStepSelect(isSel ? null : step) : undefined}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all text-left ${
                    isSel
                      ? 'border-brand bg-brand/5 ring-1 ring-brand/30'
                      : isRun
                      ? 'border-surface-4 bg-surface-3 animate-pulse'
                      : isDone
                      ? hasErr
                        ? 'border-red-500/30 bg-red-500/5 hover:bg-red-500/10 cursor-pointer'
                        : 'border-surface-5 bg-surface-2 hover:bg-surface-3 cursor-pointer'
                      : 'border-surface-5/40 bg-surface-2/40 opacity-40 cursor-default'
                  }`}
                >
                  {/* Step number bubble */}
                  <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
                    style={{ background: isDone || isRun ? color : '#374151' }}>
                    {i + 1}
                  </div>

                  {/* Label */}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium" style={{ color: isDone || isRun ? color : undefined }}>
                      {spec?.label || step.kind}
                    </p>
                    {isDone && !isRun && (
                      <p className="text-[10px] text-text-muted truncate mt-0.5">
                        {hasErr ? step.error?.slice(0, 60) + '…' :
                         isPaused ? `Paused — ${step.waiting_for}` :
                         step.output ? Object.keys(step.output).join(', ') : ''}
                      </p>
                    )}
                  </div>

                  {/* Status icon */}
                  <div className="shrink-0">{statusIcon}</div>

                  {/* Click hint */}
                  {isDone && !isRun && (
                    <svg className="w-3.5 h-3.5 text-text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>}

          {/* Fatal error */}
          {centerTab === 'steps' && showSummary && finalResult!.error && (
            <div className="mt-3 bg-red-500/10 border border-red-500/30 rounded px-3 py-2 text-xs text-red-400 font-mono">
              {finalResult!.error}
            </div>
          )}
          </div>{/* end flex-1 overflow-y-auto */}
        </div>{/* end center flex-1 flex flex-col */}
      </div>
    </div>
  );
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

interface ToolbarProps {
  name: string;
  onNameChange: (v: string) => void;
  triggerChannel: string;
  onChannelChange: (v: string) => void;
  triggerCategory: string;
  onCategoryChange: (v: string) => void;
  published: boolean;
  saving: boolean;
  publishing: boolean;
  hasErrors: boolean;
  catchAll: boolean;
  canEdit: boolean;
  canTest: boolean;
  canPublish: boolean;
  onSave: () => void;
  onPublish: () => void;
  onUnpublish: () => void;
  onTestRun: () => void;
  statusMsg: string;
  statusKind: 'idle' | 'ok' | 'error';
}

function Toolbar(p: ToolbarProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-surface-5 bg-surface-1 shrink-0">
      {/* Workflow name */}
      <input
        value={p.name}
        onChange={e => p.onNameChange(e.target.value)}
        className="text-sm font-semibold bg-transparent outline-none border-b border-transparent focus:border-brand text-text-primary transition-colors w-48 truncate"
        placeholder="Workflow name"
      />

      <div className="h-4 w-px bg-surface-5 mx-1" />

      {/* Trigger channel */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-text-muted uppercase tracking-wide" title="This workflow fires when a conversation matches this channel">Channel ⓘ</span>
        <select
          value={p.triggerChannel}
          onChange={e => p.onChannelChange(e.target.value)}
          className="text-xs bg-surface-2 border border-surface-5 rounded px-2 py-1 text-text-primary outline-none focus:border-brand transition-colors"
        >
          <option value="any">Any</option>
          <option value="widget">Widget</option>
          <option value="email">Email</option>
        </select>
      </div>

      {/* Trigger category */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-text-muted uppercase tracking-wide" title="This workflow fires when a conversation matches this category">Category ⓘ</span>
        <select
          value={p.triggerCategory}
          onChange={e => p.onCategoryChange(e.target.value)}
          className="text-xs bg-surface-2 border border-surface-5 rounded px-2 py-1 text-text-primary outline-none focus:border-brand transition-colors"
        >
          <option value="any">Any</option>
          <option value="kyc_verification">KYC Verification</option>
          <option value="account_restriction">Account Restriction</option>
          <option value="password_2fa_reset">2FA / Password Reset</option>
          <option value="withdrawal_issue">Withdrawal Issue</option>
          <option value="fraud_security">Fraud / Security</option>
          <option value="other">Other</option>
        </select>
      </div>

      {p.catchAll && (
        <span className="text-[10px] text-amber-400" title="This workflow will intercept ALL conversations">⚠ Catch-all trigger</span>
      )}

      {/* Status message */}
      {p.statusMsg && (
        <span className={`text-[10px] ml-1 ${
          p.statusKind === 'ok'    ? 'text-green-400' :
          p.statusKind === 'error' ? 'text-red-400' : 'text-text-muted'
        }`}>
          {p.statusMsg}
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        {p.canTest && (
          <button
            onClick={p.onTestRun}
            className="text-xs bg-surface-3 hover:bg-surface-4 text-text-secondary hover:text-text-primary border border-surface-5 rounded px-3 py-1.5 transition-colors flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Test
          </button>
        )}
        {p.canEdit && (
          <button
            onClick={p.onSave}
            disabled={p.saving}
            className="text-xs bg-surface-3 hover:bg-surface-4 text-text-secondary hover:text-text-primary border border-surface-5 rounded px-3 py-1.5 transition-colors disabled:opacity-40"
          >
            {p.saving ? 'Saving…' : 'Save'}
          </button>
        )}
        {p.canPublish && (p.published ? (
          <button
            onClick={p.onUnpublish}
            disabled={p.publishing}
            className="text-xs bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 border border-amber-500/30 rounded px-3 py-1.5 transition-colors disabled:opacity-40"
          >
            Unpublish
          </button>
        ) : (
          <button
            onClick={p.onPublish}
            disabled={p.publishing || p.hasErrors}
            title={p.hasErrors ? 'Fix highlighted nodes before publishing' : undefined}
            className="text-xs bg-brand hover:bg-brand-dim text-white rounded px-3 py-1.5 transition-colors disabled:opacity-40"
          >
            {p.publishing ? 'Publishing…' : 'Publish'}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Main AIStudio ─────────────────────────────────────────────────────────────

export default function AIStudio() {
  const canCreate  = usePerm('studio.create');
  const canEdit    = usePerm('studio.edit');
  const canDelete  = usePerm('studio.delete');
  const canTest    = usePerm('studio.test');
  const canPublish = usePerm('studio.publish');

  // ── Workflow list ──
  const [workflows, setWorkflows]     = useState<WorkflowSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [activeId, setActiveId]       = useState<string | null>(null);

  // ── Canvas ──
  const [nodes, setNodes, onNodesChange] = useNodesState<NodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNode, setSelectedNode]  = useState<Node<NodeData> | null>(null);

  // ── Workflow meta ──
  const [wfName,     setWfName]     = useState('Untitled Workflow');
  const [channel,    setChannel]    = useState('any');
  const [category,   setCategory]   = useState('any');
  const [published,  setPublished]  = useState(false);

  // ── UI state ──
  const [saving,     setSaving]     = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [statusMsg,  setStatusMsg]  = useState('');
  const [statusKind, setStatusKind] = useState<'idle' | 'ok' | 'error'>('idle');
  const [showTest,   setShowTest]   = useState(false);
  const [errorIds,   setErrorIds]   = useState<Set<string>>(new Set());
  const [conflictWarn, setConflictWarn] = useState('');
  const [showHint,   setShowHint]   = useState(() => !localStorage.getItem('studio_onboarded'));

  // ── Test run state ──
  const [selectedTestStep, setSelectedTestStep] = useState<TestStep | null>(null);
  const [testNodeStates,   setTestNodeStates]   = useState<Record<string, StepState>>({});

  const idRef = useRef<string | null>(null);

  // ── Fetch workflow list ──
  const loadList = useCallback(async () => {
    setListLoading(true);
    try {
      const r = await fetch(`${API}/api/studio/flows`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (r.ok) setWorkflows(await r.json());
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  // ── Load workflow onto canvas ──
  const loadWorkflow = useCallback(async (id: string) => {
    const r = await fetch(`${API}/api/studio/flows/${id}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!r.ok) return;
    const wf = await r.json();

    idRef.current = wf.id;
    setActiveId(wf.id);
    setWfName(wf.name);
    setChannel(wf.trigger_channel || 'any');
    setCategory(wf.trigger_category || 'any');
    setPublished(!!wf.published);

    const rawNodes = (typeof wf.nodes_json === 'string' ? JSON.parse(wf.nodes_json) : wf.nodes_json) ?? [];
    const rawEdges = (typeof wf.edges_json === 'string' ? JSON.parse(wf.edges_json) : wf.edges_json) ?? [];

    // Engine-format workflows ({id, kind, config}) carry no canvas coordinates. If no
    // node has a stored position, derive a layered layout from the edges so the graph
    // renders faithfully instead of collapsing all nodes onto the same point.
    const needsLayout = rawNodes.length > 0 && rawNodes.every((n: Record<string, unknown>) => !n.position);
    const layout = needsLayout
      ? autoLayoutPositions(rawNodes as { id: string }[], rawEdges as { source?: string; target?: string }[])
      : null;

    // Normalize nodes: support both canvas format (type/data) and engine format (kind/config)
    const canvasNodes: Node<NodeData>[] = rawNodes.map((n: Record<string, unknown>) => {
      const kind  = (n.kind || n.type) as NodeKind;
      const data  = n.data as Record<string, unknown> | undefined;
      const cfg   = (n.config as Record<string, unknown>) || (data as Record<string, unknown>) || {};
      return {
        id:       n.id as string,
        type:     kind,
        position: (n.position as { x: number; y: number }) || layout?.get(n.id as string) || { x: 100, y: 100 },
        data: {
          kind,
          label: (data?.label as string) || (cfg.label as string) || NODE_SPECS[kind]?.label || kind,
          config: cfg,
        },
      };
    });

    setNodes(canvasNodes);
    setEdges(rawEdges.map((e: Record<string, unknown>) => ({
      id:           e.id as string || `e-${e.source}-${e.target}`,
      source:       e.source as string,
      target:       e.target as string,
      sourceHandle: e.sourceHandle as string | undefined,
      style:        { stroke: 'var(--surface-5)', strokeWidth: 2 },
    })));
    setSelectedNode(null);
    setErrorIds(new Set());
    setStatusMsg('');
  }, [setNodes, setEdges]);

  // ── Create new workflow ──
  const createWorkflow = async () => {
    const r = await fetch(`${API}/api/studio/flows`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Untitled Workflow', trigger_channel: 'any', trigger_category: 'any' }),
    });
    if (!r.ok) return;
    const { id } = await r.json();
    await loadList();
    await loadWorkflow(id);
  };

  // ── Create workflow from template ──
  const createWorkflowFromTemplate = async (tpl: typeof TEMPLATES[number]) => {
    const r = await fetch(`${API}/api/studio/flows`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        name: tpl.name,
        trigger_channel: tpl.trigger_channel,
        trigger_category: tpl.trigger_category,
        nodes_json: tpl.nodes,
        edges_json: tpl.edges,
      }),
    });
    if (!r.ok) return;
    const { id } = await r.json();
    await loadList();
    await loadWorkflow(id);
  };

  // ── Delete workflow ──
  const deleteWorkflow = async (id: string) => {
    if (!confirm('Delete this workflow? This cannot be undone.')) return;
    await fetch(`${API}/api/studio/flows/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (idRef.current === id) {
      idRef.current = null;
      setActiveId(null);
      setNodes([]);
      setEdges([]);
    }
    await loadList();
  };

  // ── Activate / Deactivate workflow from list ──
  const toggleWorkflowActive = async (id: string, currentlyPublished: boolean) => {
    const endpoint = currentlyPublished ? 'unpublish' : 'publish';
    const r = await fetch(`${API}/api/studio/flows/${id}/${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    const body = await r.json();
    if (!r.ok) {
      alert(body.error || `Failed to ${currentlyPublished ? 'deactivate' : 'activate'} workflow.`);
      return;
    }
    // Sync canvas state if this is the currently open workflow
    if (idRef.current === id) {
      setPublished(!currentlyPublished);
      setStatusMsg(currentlyPublished ? 'Deactivated' : 'Activated');
      setStatusKind('ok');
      setTimeout(() => setStatusMsg(''), 2500);
    }
    await loadList();
  };

  // ── Save draft ──
  const saveDraft = async () => {
    setSaving(true);
    setStatusMsg('');
    const canvasNodes = nodes.map(n => ({
      id:       n.id,
      type:     n.data.kind,
      position: n.position,
      data:     { label: n.data.label, ...n.data.config },
    }));
    const canvasEdges = edges;
    try {
      if (idRef.current) {
        await fetch(`${API}/api/studio/flows/${idRef.current}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({
            name: wfName,
            trigger_channel: channel,
            trigger_category: category,
            nodes_json: canvasNodes,
            edges_json: canvasEdges,
          }),
        });
      } else {
        const r = await fetch(`${API}/api/studio/flows`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            name: wfName,
            trigger_channel: channel,
            trigger_category: category,
            nodes_json: canvasNodes,
            edges_json: canvasEdges,
          }),
        });
        if (r.ok) {
          const { id } = await r.json();
          idRef.current = id;
          setActiveId(id);
          await loadList();
        }
      }
      setStatusMsg('Saved'); setStatusKind('ok');
      setTimeout(() => setStatusMsg(''), 2500);
    } catch {
      setStatusMsg('Save failed'); setStatusKind('error');
    } finally {
      setSaving(false);
    }
  };

  // ── Publish ──
  const publish = async () => {
    if (!idRef.current) { await saveDraft(); if (!idRef.current) return; }
    setPublishing(true);
    setErrorIds(new Set());
    try {
      const r = await fetch(`${API}/api/studio/flows/${idRef.current}/publish`, {
        method: 'POST', headers: { Authorization: `Bearer ${getToken()}` },
      });
      const body = await r.json();
      if (!r.ok) {
        if (body.broken_node_ids?.length) {
          setErrorIds(new Set(body.broken_node_ids));
          setNodes(ns => ns.map(n => ({ ...n, data: { ...n.data, error: body.broken_node_ids.includes(n.id) } })));
        }
        setStatusMsg(body.error || 'Publish failed'); setStatusKind('error');
        return;
      }
      setPublished(true);
      setStatusMsg('Published!'); setStatusKind('ok');
      if (body.warnings?.length) setConflictWarn(body.warnings[0]);
      await loadList();
      setTimeout(() => setStatusMsg(''), 3000);
    } finally {
      setPublishing(false);
    }
  };

  // ── Unpublish ──
  const unpublish = async () => {
    if (!idRef.current) return;
    await fetch(`${API}/api/studio/flows/${idRef.current}/unpublish`, {
      method: 'POST', headers: { Authorization: `Bearer ${getToken()}` },
    });
    setPublished(false);
    setStatusMsg('Unpublished'); setStatusKind('ok');
    await loadList();
    setTimeout(() => setStatusMsg(''), 2500);
  };

  // ── Canvas callbacks ──
  const onConnect = useCallback(
    (params: Connection) => setEdges(eds => addEdge({
      ...params,
      style: { stroke: 'var(--surface-5)', strokeWidth: 2 },
    }, eds)),
    [setEdges],
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node<NodeData>) => {
    setSelectedNode(node);
    setSelectedTestStep(null);  // canvas click → show config, not test log
  }, []);

  const onPaneClick = useCallback(() => setSelectedNode(null), []);

  // ── Node mutations ──
  const addNode = (kind: NodeKind) => {
    if (!idRef.current && !activeId) {
      alert('Create or select a workflow first.');
      return;
    }
    const id = `${kind}-${Date.now()}`;
    const defaultConfig: Record<string, unknown> =
      kind === 'account_lookup' ? { tool: 'profile', store_as: 'account' } : {};
    setNodes(ns => [...ns, {
      id,
      type: kind,
      position: { x: 200 + Math.random() * 250, y: 120 + Math.random() * 200 },
      data: { kind, label: NODE_SPECS[kind].label, config: defaultConfig },
    }]);
  };

  const updateNode = useCallback((id: string, config: Partial<Record<string, unknown>>, label?: string) => {
    setNodes(ns => ns.map(n => {
      if (n.id !== id) return n;
      const newData = {
        ...n.data,
        config: { ...n.data.config, ...config },
        ...(label !== undefined ? { label } : {}),
      };
      return { ...n, data: newData };
    }));
    setSelectedNode(prev => {
      if (!prev || prev.id !== id) return prev;
      return {
        ...prev,
        data: {
          ...prev.data,
          config: { ...prev.data.config, ...config },
          ...(label !== undefined ? { label } : {}),
        },
      };
    });
  }, [setNodes]);

  const deleteNode = useCallback((id: string) => {
    setNodes(ns => ns.filter(n => n.id !== id));
    setEdges(es => es.filter(e => e.source !== id && e.target !== id));
    setSelectedNode(null);
  }, [setNodes, setEdges]);

  // ── Render ────────────────────────────────────────────────────────────────

  const noWorkflowLoaded = !idRef.current && !activeId;

  // Compute which node has no incoming edge → that's the start node
  const startNodeId = (() => {
    const targets = new Set(edges.map(e => e.target));
    const roots = nodes.filter(n => !targets.has(n.id));
    return roots.length === 1 ? roots[0].id : null;
  })();

  const multipleRoots = (() => {
    const targets = new Set(edges.map(e => e.target));
    return nodes.filter(n => !targets.has(n.id)).length > 1;
  })();

  // Real-time client-side validation
  const nodeErrors = (() => {
    const errs = new Set<string>();
    const connectedSources = new Set(edges.map(e => e.source));
    const terminals = new Set(['escalate', 'resolve_ticket', 'wait_for_reply', 'wait_for_trigger']);
    for (const n of nodes) {
      const k = n.data.kind;
      const c = n.data.config;
      const conditions = c.conditions as Array<{variable:string;value:string}> | undefined;
      if (k === 'send_reply' && !c.text) errs.add(n.id);
      if (k === 'account_lookup' && !c.tool) errs.add(n.id);
      if (k === 'condition') {
        const hasCompound = conditions && conditions.length > 0 && conditions.some(cl => cl.variable);
        const hasSingle = c.variable;
        if (!hasCompound && !hasSingle) errs.add(n.id);
        // must have both true/false outgoing edges
        const out = edges.filter(e => e.source === n.id);
        if (!out.some(e => e.sourceHandle === 'true') || !out.some(e => e.sourceHandle === 'false')) errs.add(n.id);
      }
      if (k === 'set_variable' && !c.variable_name) errs.add(n.id);
      // Non-terminal nodes must have an outgoing edge
      if (!terminals.has(k) && !connectedSources.has(n.id)) errs.add(n.id);
    }
    return errs;
  })();

  const catchAllTrigger = channel === 'any' && category === 'any';

  return (
    <div className="flex flex-1 overflow-hidden bg-surface-0">

      {/* ── Left panel: workflow list + node palette ── */}
      <div className="w-[220px] shrink-0 border-r border-surface-5 bg-surface-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-hidden flex flex-col min-h-0">
          <WorkflowList
            workflows={workflows}
            activeId={activeId}
            loading={listLoading}
            canCreate={canCreate}
            canDelete={canDelete}
            canPublish={canPublish}
            onCreate={createWorkflow}
            onSelect={loadWorkflow}
            onDelete={deleteWorkflow}
            onToggleActive={toggleWorkflowActive}
          />
        </div>
        {canEdit && <NodePalette onAdd={addNode} />}
      </div>

      {/* ── Center: canvas ── */}
      <div className="flex-1 flex flex-col relative overflow-hidden">

        {/* Top toolbar (only when a workflow is loaded) */}
        {!noWorkflowLoaded && (
          <Toolbar
            name={wfName}
            onNameChange={setWfName}
            triggerChannel={channel}
            onChannelChange={setChannel}
            triggerCategory={category}
            onCategoryChange={setCategory}
            published={published}
            saving={saving}
            publishing={publishing}
            hasErrors={nodeErrors.size > 0}
            catchAll={catchAllTrigger}
            canEdit={canEdit}
            canTest={canTest}
            canPublish={canPublish}
            onSave={saveDraft}
            onPublish={publish}
            onUnpublish={unpublish}
            onTestRun={() => setShowTest(v => !v)}
            statusMsg={statusMsg}
            statusKind={statusKind}
          />
        )}

        {/* Empty state — template picker */}
        {noWorkflowLoaded ? (
          <div className="flex-1 flex items-center justify-center flex-col gap-6 px-8 py-10 overflow-y-auto">
            <div className="text-center">
              <p className="text-base font-semibold text-text-primary">{canCreate ? 'Start with a template' : 'Workflow Studio'}</p>
              <p className="text-xs text-text-muted mt-1">{canCreate ? 'Pick a pre-built flow or start from scratch' : 'Select a workflow from the list to view it.'}</p>
            </div>
            {canCreate && <div className="grid grid-cols-3 gap-4 w-full max-w-2xl">
              {TEMPLATES.map(t => (
                <button
                  key={t.id}
                  onClick={() => createWorkflowFromTemplate(t)}
                  className="text-left bg-surface-2 hover:bg-surface-3 border border-surface-5 hover:border-brand/40 rounded-xl p-4 transition-all group"
                >
                  <p className="text-xs font-semibold text-text-primary group-hover:text-brand transition-colors">{t.name}</p>
                  <p className="text-[10px] text-text-muted mt-1 leading-relaxed">{t.description}</p>
                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-[9px] font-bold bg-surface-4 text-text-muted rounded-full px-2 py-0.5">
                      {t.nodes.length} steps
                    </span>
                    <span className="text-[9px] text-text-muted">{t.trigger_category.replace(/_/g, ' ')}</span>
                  </div>
                </button>
              ))}
            </div>}
            {canCreate && (
              <button
                onClick={createWorkflow}
                className="text-xs text-text-muted hover:text-text-secondary transition-colors underline-offset-2 hover:underline"
              >
                Start from scratch →
              </button>
            )}
          </div>
        ) : (
          <div className="flex-1 relative">
            {/* Onboarding hint — shown once */}
            {showHint && nodes.length === 0 && (
              <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 bg-surface-3 border border-brand/30 rounded-xl px-5 py-3 shadow-modal flex items-center gap-3 max-w-sm">
                <svg className="w-5 h-5 text-brand shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-xs text-text-secondary flex-1">
                  Add steps from the left panel. Drag from the <span className="text-brand font-semibold">colored dot</span> at the bottom of a node to connect it.
                </p>
                <button onClick={() => { setShowHint(false); localStorage.setItem('studio_onboarded', '1'); }}
                  className="text-text-muted hover:text-text-primary text-lg leading-none shrink-0">✕</button>
              </div>
            )}

            {multipleRoots && (
              <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-2 flex items-center gap-2 text-xs text-amber-400">
                ⚠ Multiple entry points — only one node can be the start of a workflow
              </div>
            )}

            {conflictWarn && (
              <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-2 flex items-center gap-2 text-xs text-amber-400 max-w-md">
                ⚠ {conflictWarn}
                <button onClick={() => setConflictWarn('')} className="ml-2 text-amber-400/70 hover:text-amber-400">✕</button>
              </div>
            )}

            <ReactFlow
              nodes={nodes.map(n => ({
                ...n,
                data: {
                  ...n.data,
                  error: errorIds.has(n.id) || nodeErrors.has(n.id),
                  testState: testNodeStates[n.id],
                  isStart: startNodeId === n.id,
                },
              }))}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              nodeTypes={NODE_TYPES}
              fitView
              style={{ background: 'var(--surface-0)' }}
              defaultEdgeOptions={{
                style: { stroke: 'var(--surface-5)', strokeWidth: 2 },
              }}
            >
              <Background color="var(--surface-5)" gap={20} size={1} />
              <Controls
                style={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--surface-5)',
                  borderRadius: 8,
                }}
              />
              <MiniMap
                nodeColor={() => 'var(--surface-4)'}
                maskColor="rgba(8,10,12,0.6)"
                style={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--surface-5)',
                  borderRadius: 8,
                }}
              />
            </ReactFlow>

            {/* Test run drawer */}
            {showTest && (
              <TestRunPanel
                workflowId={idRef.current}
                onClose={() => {
                  setShowTest(false);
                  setSelectedTestStep(null);
                  setTestNodeStates({});
                }}
                onStepSelect={step => {
                  setSelectedTestStep(step);
                  // When a step is clicked, also deselect canvas node so the right panel shows the log
                  if (step) setSelectedNode(null);
                }}
                onNodeHighlight={setTestNodeStates}
                selectedStepId={selectedTestStep?.node_id ?? null}
              />
            )}
          </div>
        )}
      </div>

      {/* ── Right panel: node config / test step log ── */}
      {!noWorkflowLoaded && (
        <NodeConfigPanel
          node={selectedNode}
          onChange={updateNode}
          onDelete={deleteNode}
          testStep={selectedTestStep}
        />
      )}
    </div>
  );
}
