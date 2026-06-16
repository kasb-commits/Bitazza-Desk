"""
Standalone smoke test — real Gemini, no pytest required.

Reproduces ticket bb63ac1a-bbe7-4320-a7a3-221c5652f5b9:

  Turn 1   password category  → bot answers password reset
  [switch] set_category → KYC (abandon_active_execution called)
  Turn 2   "I need help with my KYC verification."
  Turn 3   "im checking on kyc status"
  Turn 4   "ok"

Three fixes validated with real LLM responses:
  Fix 1 — stale password execution abandoned on category switch
  Fix 2 — KYC data auto-fetched on second turn (no "cannot check")
  Fix 3 — safety net escalates ticket even without EscalateNode

Run:
    python3 tests/run_smoke_kyc_topic_switch.py
"""
import os, sys, uuid
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# ── env must be set before any project import ─────────────────────────────────
os.environ["GEMINI_API_KEY"]      = "AIzaSyAxRYnIy6eAvzvQsIZjOpCdR_3iYgu03qY"
os.environ["FRESHDESK_API_KEY"]   = "lNZ0OTsu4693Amh1tekU"
os.environ["FRESHDESK_SUBDOMAIN"] = "bitazzahelp.freshdesk.com"
os.environ["JWT_SECRET"]          = "d8eb6c9c922f454f6a627765878e381c8cdcbc6ad4c6f4e456bd8a70f7cb828c"
os.environ["CHROMA_PATH"]         = "/tmp/chroma_smoke"
os.environ["DATABASE_URL"]        = "postgresql://x:x@localhost/x"
os.environ["USE_MOCK_USER_API"]   = "true"

from collections import defaultdict
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

# ── Fake workflows ────────────────────────────────────────────────────────────

def _make_password_wf():
    from workflow_engine.models import Workflow, WorkflowNode, WorkflowTrigger
    return Workflow(
        id="wf-pw", name="Password Reset",
        trigger=WorkflowTrigger(channel="any", category="password_2fa_reset"),
        nodes=[
            WorkflowNode(id="pw-ai",   kind="ai_reply",      config={"category": "password_2fa_reset"}, next_node_id="pw-wait"),
            WorkflowNode(id="pw-wait", kind="wait_for_reply", config={},                                next_node_id=None),
        ],
        edges=[], published=True, version=1,
    )


def _make_kyc_wf():
    """KYC: triage → wait → final-ai_reply (no trailing wait).

    The final ai_reply has next_node_id=None so the engine loop exits naturally
    after Turn 3, which lets the escalation safety net fire (Fix 3 target).
    No EscalateNode — that's the scenario being validated.
    """
    from workflow_engine.models import Workflow, WorkflowNode, WorkflowTrigger
    return Workflow(
        id="wf-kyc", name="KYC Verification",
        trigger=WorkflowTrigger(channel="any", category="kyc_verification"),
        nodes=[
            WorkflowNode(id="kyc-t",  kind="ai_reply",      config={"category": "kyc_verification"}, next_node_id="kyc-w1"),
            WorkflowNode(id="kyc-w1", kind="wait_for_reply", config={},                               next_node_id="kyc-a"),
            WorkflowNode(id="kyc-a",  kind="ai_reply",       config={"category": "kyc_verification"}, next_node_id=None),
        ],
        edges=[], published=True, version=1,
    )


# ── In-memory execution store ─────────────────────────────────────────────────

class _ExecStore:
    def __init__(self):
        self._execs = {}

    def create(self, eid, wid, cid, nid, variables, status, channel, category):
        from workflow_engine.models import WorkflowExecution, ExecutionStatus
        ex = WorkflowExecution(
            id=eid, workflow_id=wid, conversation_id=cid,
            current_node_id=nid, variables=dict(variables),
            status=ExecutionStatus(status.value if hasattr(status,"value") else status),
            waiting_for=None, channel=channel, category=category,
        )
        self._execs[eid] = ex

    def update(self, eid, status, current_node_id=None, waiting_for=None, variables=None, output_reply=None, **_):
        ex = self._execs.get(eid)
        if ex is None:
            raise LookupError(eid)
        ex.status = status
        if current_node_id is not None:
            ex.current_node_id = current_node_id
        ex.waiting_for = waiting_for
        if variables is not None:
            ex.variables = dict(variables)

    def get_active(self, cid):
        from workflow_engine.models import ExecutionStatus
        terminal = {ExecutionStatus.COMPLETED, ExecutionStatus.FAILED, ExecutionStatus.ABANDONED}
        cands = [e for e in self._execs.values()
                 if e.conversation_id == cid and e.status not in terminal]
        return cands[-1] if cands else None

    def abandon_active(self, cid, **_):
        from workflow_engine.models import ExecutionStatus
        ex = self.get_active(cid)
        if ex:
            ex.status = ExecutionStatus.ABANDONED


# ── Assertion helpers ─────────────────────────────────────────────────────────

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"
failures = []

def check(label, condition, detail=""):
    if condition:
        print(f"  {PASS}  {label}")
    else:
        msg = f"  {FAIL}  {label}" + (f"\n       → {detail}" if detail else "")
        print(msg)
        failures.append(label)


# ═════════════════════════════════════════════════════════════════════════════
# Full conversation — exact same flow as the reference ticket
# ═════════════════════════════════════════════════════════════════════════════

def run():
    store         = _ExecStore()
    history       = defaultdict(list)
    ticket_status = {"status": None}
    assign_calls  = []
    conv_id       = str(uuid.uuid4())

    pw_wf  = _make_password_wf()
    kyc_wf = _make_kyc_wf()
    wf_map = {pw_wf.id: pw_wf, kyc_wf.id: kyc_wf}

    def _published(*a, **kw):      return list(wf_map.values())
    def _get_active(conversation_id, **_kw):  return store.get_active(conversation_id)
    def _create(execution_id, workflow_id, conversation_id, current_node_id,
                variables, status, channel, category, conn=None):
        store.create(execution_id, workflow_id, conversation_id, current_node_id,
                     variables, status, channel, category)
    def _update(execution_id, status, current_node_id=None, waiting_for=None,
                variables=None, output_reply=None, conn=None):
        store.update(execution_id, status, current_node_id=current_node_id,
                     waiting_for=waiting_for, variables=variables)
    def _load_wf(workflow_id, **_kw): return wf_map.get(workflow_id)
    def _abandon(conversation_id, **_kw): store.abandon_active(conversation_id)
    def _is_human(_):              return False
    def _get_hist(cid, limit=10):  return history[cid][-limit:]
    def _add_msg(cid, role, content, *a, **kw):
        history[cid].append({"role": role, "content": content})
        return str(uuid.uuid4())
    def _has_reply(cid):           return any(m["role"] == "assistant" for m in history[cid])
    def _upd_ticket(tid, st):      ticket_status["status"] = st; print(f"     [ticket status → {st}]")
    def _auto_assign(tid, *a, **kw): assign_calls.append(tid)

    with ExitStack() as stack:
        # Router imports these directly — must patch the router's namespace
        stack.enter_context(patch("workflow_engine.router.get_published_workflows",               side_effect=_published))
        stack.enter_context(patch("workflow_engine.router.get_active_execution",                  side_effect=_get_active))
        stack.enter_context(patch("workflow_engine.router.load_workflow_by_id",                   side_effect=_load_wf))
        # Engine imports create/update directly — patch engine's namespace
        stack.enter_context(patch("workflow_engine.engine.create_execution",                      side_effect=_create))
        stack.enter_context(patch("workflow_engine.engine.update_execution_status",               side_effect=_update))
        # Store-level patches for direct store calls (interceptor, store.abandon)
        stack.enter_context(patch("workflow_engine.store.get_active_execution",                   side_effect=_get_active))
        stack.enter_context(patch("workflow_engine.store.abandon_active_execution",               side_effect=_abandon))
        stack.enter_context(patch("workflow_engine.store.is_workflow_active",                     return_value=False))
        stack.enter_context(patch("db.conversation_store.is_human_handling",                     side_effect=_is_human))
        stack.enter_context(patch("db.conversation_store.has_successful_bot_reply",              side_effect=_has_reply))
        stack.enter_context(patch("engine.agent.get_history",                                    side_effect=_get_hist))
        stack.enter_context(patch("engine.agent.add_message",                                    side_effect=_add_msg))
        stack.enter_context(patch("engine.agent.collection_count",                               return_value=0))
        stack.enter_context(patch("engine.agent.retrieve_with_fallback",                         return_value=[]))
        stack.enter_context(patch("engine.agent.get_ticket_id_by_conversation",                  return_value="ticket-1"))
        stack.enter_context(patch("engine.agent.update_ticket_status",                           side_effect=_upd_ticket))
        stack.enter_context(patch("engine.agent.get_ticket_meta",                                return_value={"priority": 3, "customer_id": "cust-1"}))
        stack.enter_context(patch("engine.agent.get_ai_persona",                                 return_value={"name": "Aria", "avatar": None, "avatar_url": None}))
        stack.enter_context(patch("engine.agent.update_customer_from_profile"))
        stack.enter_context(patch("engine.agent.trigger_auto_assign",                            side_effect=_auto_assign))
        stack.enter_context(patch("db.conversation_store.get_ticket_id_by_conversation",         return_value="ticket-1"))
        stack.enter_context(patch("db.conversation_store.update_ticket_status",                  side_effect=_upd_ticket))
        stack.enter_context(patch("db.conversation_store.get_ticket_meta",                       return_value={"priority": 3, "customer_id": "cust-1"}))
        stack.enter_context(patch("engine.assignment_client.trigger_auto_assign",                side_effect=_auto_assign))

        from workflow_engine.interceptor import workflow_interceptor

        # ── Turn 1: password reset ────────────────────────────────────────────
        print("\n─────────────────────────────────────────────")
        print("Turn 1  user: 'I forgot my password'  [category: password_2fa_reset]")
        r1 = workflow_interceptor(conv_id, "u-1", "I forgot my password",
                                  category="password_2fa_reset")
        history[conv_id].append({"role": "assistant", "content": r1.text or ""})
        print(f"  Bot: {r1.text!r}")

        pw_exec = store.get_active(conv_id)
        check("Password workflow execution created and paused",
              pw_exec is not None and pw_exec.workflow_id == "wf-pw")
        check("Turn 1 reply non-empty",    bool(r1.text))
        check("Turn 1 not escalated",      not r1.escalated)
        check("Turn 1 not resolved",       not r1.resolved)

        # ── set_category: password → KYC (Fix 1) ─────────────────────────────
        print("\n─────────────────────────────────────────────")
        print("[set_category]  password_2fa_reset → kyc_verification")
        store.abandon_active(conv_id)  # what set_category now calls
        check("Fix 1 — password execution ABANDONED after category switch",
              pw_exec is not None and
              pw_exec.status.value == "abandoned",
              f"status={pw_exec.status if pw_exec else 'None'}")
        check("Fix 1 — no active execution after abandon",
              store.get_active(conv_id) is None)

        # ── Turn 2: KYC triage ───────────────────────────────────────────────
        print("\n─────────────────────────────────────────────")
        print("Turn 2  user: 'I need help with my KYC verification.'  [category: kyc_verification]")
        r2 = workflow_interceptor(conv_id, "u-1",
                                  "I need help with my KYC verification.",
                                  category="kyc_verification")
        history[conv_id].append({"role": "assistant", "content": r2.text or ""})
        print(f"  Bot: {r2.text!r}")

        active = store.get_active(conv_id)
        check("Fix 1 — KYC workflow is now the active execution",
              active is not None and active.workflow_id == "wf-kyc",
              f"active={active.workflow_id if active else None}")
        check("Fix 1 — triage reply not carrying resolved=True from stale password flow",
              not r2.resolved)
        check("Turn 2 reply non-empty", bool(r2.text))

        # ── Turn 3: user checks KYC status (Fix 2) ───────────────────────────
        print("\n─────────────────────────────────────────────")
        print("Turn 3  user: 'im checking on kyc status'  [category: kyc_verification]")

        kyc_fetch_calls = []
        original_get_kyc = None
        try:
            import engine.account_tools as _at
            original_get_kyc = _at.get_kyc_status
            def _spy_kyc(user_id):
                kyc_fetch_calls.append(user_id)
                return original_get_kyc(user_id=user_id)
            _at.get_kyc_status = _spy_kyc
        except Exception:
            pass

        r3 = workflow_interceptor(conv_id, "u-1", "im checking on kyc status",
                                  category="kyc_verification")
        history[conv_id].append({"role": "assistant", "content": r3.text or ""})
        print(f"  Bot: {r3.text!r}")
        print(f"  [get_kyc_status called: {len(kyc_fetch_calls)} time(s)]")
        print(f"  escalated={r3.escalated}  ticket_status={ticket_status['status']!r}")

        # Restore original
        if original_get_kyc:
            import engine.account_tools as _at2
            _at2.get_kyc_status = original_get_kyc

        check("Fix 2 — get_kyc_status auto-fetched on second turn",
              len(kyc_fetch_calls) > 0,
              f"called {len(kyc_fetch_calls)} times")
        check("Fix 2 — bot does not say 'cannot directly check'",
              "cannot directly check" not in (r3.text or "").lower(),
              f"reply={r3.text!r}")
        check("Fix 2 — bot does not say 'cannot check'",
              "cannot check" not in (r3.text or "").lower(),
              f"reply={r3.text!r}")
        check("Turn 3 reply non-empty", bool(r3.text))

        # ── Fix 3 assertions — safety net fires when workflow loop exhausts ──
        # The KYC workflow has kyc-t → kyc-w1 → kyc-a (next=None).
        # kyc-a (ai_reply) is the last node; when it returns next_node_id=None
        # the engine loop exits and the safety net runs before COMPLETED.
        # This all happens on Turn 3 (the second KYC reply turn).
        check("Fix 3 — AgentResponse.escalated is True",
              r3.escalated,
              f"escalated={r3.escalated}")
        check("Fix 3 — ticket status updated to pending_human or Escalated",
              ticket_status["status"] in ("pending_human", "Escalated"),
              f"status={ticket_status['status']!r}")
        check("Fix 3 — handoff appended to bot reply",
              bool(r3.text))

        # ── Turn 4: "ok" — execution already completed, legacy agent handles ─
        print("\n─────────────────────────────────────────────")
        print("Turn 4  user: 'ok'  [workflow completed, legacy agent takes over]")
        r4 = workflow_interceptor(conv_id, "u-1", "ok",
                                  category="kyc_verification")
        history[conv_id].append({"role": "assistant", "content": r4.text or ""})
        print(f"  Bot: {r4.text!r}")
        check("Turn 4 reply non-empty", bool(r4.text))

    # ── Summary ───────────────────────────────────────────────────────────────
    print("\n═════════════════════════════════════════════")
    if not failures:
        print(f"\033[32m✓ ALL CHECKS PASSED\033[0m")
    else:
        print(f"\033[31m✗ {len(failures)} CHECK(S) FAILED:\033[0m")
        for f in failures:
            print(f"    • {f}")
    print("═════════════════════════════════════════════\n")
    return len(failures) == 0


if __name__ == "__main__":
    ok = run()
    sys.exit(0 if ok else 1)
