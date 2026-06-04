"""
ai_reply node — delegates to engine.agent.chat().

Security invariants enforced here (not configurable by workflow designer):
  pre_filter  runs BEFORE engine_chat
  post_filter runs AFTER  engine_chat

This order must never change — it mirrors engine/agent.py.
"""
from __future__ import annotations
import logging
from workflow_engine.models import WorkflowNode, ExecutionContext, NodeResult

logger = logging.getLogger(__name__)


def engine_chat(**kwargs):
    """Thin wrapper — exists so tests can patch it cleanly."""
    from engine.agent import chat
    return chat(**kwargs)


def pre_filter(message: str):
    from engine.security_filter import pre_filter as _pf
    return _pf(message)


def post_filter(text: str) -> str:
    from engine.security_filter import post_filter as _pf
    return _pf(text)


class AiReplyNode:

    def run(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        user_message = ctx.variables.get("user_message", "")
        language     = ctx.variables.get("language", "en")
        channel      = ctx.variables.get("channel", ctx.channel)
        category     = node.config.get("category") or ctx.variables.get("category", "other")

        # ── Security pre-filter (mandatory, not bypassable) ───────────────────
        check = pre_filter(user_message)
        if not check.allowed:
            blocked_msg = (
                "I'm unable to process that request. If you need help, please describe your issue normally."
                if language == "en"
                else "ไม่สามารถประมวลผลคำขอนั้นได้ หากคุณต้องการความช่วยเหลือ กรุณาอธิบายปัญหาของคุณตามปกติ"
            )
            return NodeResult(
                output={"reply": blocked_msg, "blocked": True},
                next_node_id=node.next_node_id,
            )

        # ── Bot persona override ──────────────────────────────────────────────
        # If the workflow designer pinned a specific bot to this node, assign it
        # before the reply is generated so the correct name/avatar appear in the widget.
        ai_persona = node.config.get("ai_persona")
        if ai_persona and not ctx.dry_run:
            from engine.mock_agents import AGENTS
            from db.conversation_store import assign_ai_persona
            agent = next((a for a in AGENTS if a["name"] == ai_persona), None)
            if agent:
                assign_ai_persona(ctx.conversation_id, agent["name"], agent["avatar"], agent["avatar_url"])

        # ── Inject workflow account data ──────────────────────────────────────
        # account_lookup nodes store fetched data in execution.variables under keys
        # like 'kyc', 'account', 'profile', etc. Pass these to the agent so Gemini
        # can answer account-specific follow-ups without re-calling tools or escalating.
        _ACCOUNT_KEYS = ("kyc", "account", "profile", "restrictions",
                         "transactions", "deposits", "trading")
        injected = {k: ctx.variables[k] for k in _ACCOUNT_KEYS if k in ctx.variables}

        # ── Delegate to engine ────────────────────────────────────────────────
        response = engine_chat(
            conversation_id=ctx.conversation_id,
            user_id=ctx.user_id,
            user_message=user_message,
            platform=channel,
            category=category,
            consecutive_low_confidence=ctx.variables.get("consecutive_low_confidence", 0),
            # Workflow owns escalation routing — suppress the "connecting you with a specialist"
            # sentence so the Escalate node sends it instead of the AI reply.
            suppress_handoff=True,
            injected_account_data=injected or None,
        )

        # ── Compliance post-filter (mandatory, not bypassable) ────────────────
        reply_text = post_filter(response.text)

        output: dict = {
            "reply":    reply_text,
            "language": response.language,
            "escalated": response.escalated,
            "resolved":  response.resolved,
            "confidence": response.confidence,
            "profile_fetched": getattr(response, "profile_fetched", False),
        }

        if response.upgraded_category:
            output["upgraded_category"] = response.upgraded_category
        if response.escalated:
            output["escalation_reason"] = getattr(response, "escalation_reason", "")

        return NodeResult(
            output=output,
            next_node_id=node.next_node_id,
        )
