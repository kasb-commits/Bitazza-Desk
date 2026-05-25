"""
workflow_interceptor — the single entry point added to api/routes/chat.py.

Sits before engine.agent.chat(). Resolution:
  1. Router finds active execution or matching workflow → engine handles it
  2. Router returns fallthrough=True → legacy_agent_chat() called unchanged
  3. Engine raises → legacy_agent_chat() called (fail-open)

Returns an AgentResponse-compatible object in all cases so the chat
route needs zero changes beyond swapping one function call.
"""
from __future__ import annotations
import logging
from engine.agent import AgentResponse

logger = logging.getLogger(__name__)


def legacy_agent_chat(
    conversation_id: str,
    user_id: str | None,
    user_message: str,
    platform: str = "web",
    category: str | None = None,
    consecutive_low_confidence: int = 0,
    override_language: str | None = None,
) -> AgentResponse:
    """Direct delegation to the existing agent — exists for test patching."""
    from engine.agent import chat
    return chat(
        conversation_id=conversation_id,
        user_id=user_id,
        user_message=user_message,
        platform=platform,
        category=category,
        consecutive_low_confidence=consecutive_low_confidence,
        override_language=override_language,
    )


def _execution_to_agent_response(execution) -> AgentResponse:
    """Convert a WorkflowExecution result into an AgentResponse."""
    return AgentResponse(
        text=execution.output_reply or "",
        language=execution.variables.get("language", "en"),
        escalated=execution.escalated,
        resolved=execution.resolved,
        transition_message=execution.transition_message,
    )


def workflow_interceptor(
    conversation_id: str,
    user_id: str | None,
    user_message: str,
    platform: str = "web",
    category: str | None = None,
    consecutive_low_confidence: int = 0,
    override_language: str | None = None,
) -> AgentResponse:
    from workflow_engine.router import WorkflowRouter
    from workflow_engine.engine import WorkflowExecutionEngine
    from workflow_engine.channel_adapter import WidgetAdapter, EmailAdapter

    # Build ChannelMessage
    adapter = EmailAdapter() if platform == "email" else WidgetAdapter()
    if platform == "email":
        # Email path uses a minimal synthetic message (real parsed email
        # was already processed by the email route before this point)
        from workflow_engine.channel_adapter import ChannelMessage
        message = ChannelMessage(
            text=user_message,
            channel="email",
            category=category or "other",
            language="en",
            user_id=user_id,
            conversation_id=conversation_id,
            metadata={},
        )
    else:
        message = adapter.normalize(
            text=user_message,
            conversation_id=conversation_id,
            user_id=user_id,
            category=category or "other",
            language=None,  # detect from text
            metadata={},
        )

    # If no category was sent (or "other"), ask Gemini what the message is about.
    # This lets a published workflow fire even when the widget sends no category.
    # Guest sessions (user_id=None) must NOT be routed to account workflows — they
    # always stay on "other" and fall through to legacy_agent_chat with the guest prompt.
    if (not category or category.lower() == "other") and user_id is not None:
        try:
            from engine.mock_agents import classify_message_with_gemini
            detected = classify_message_with_gemini(user_message)
            if detected and detected != "other":
                message.category = detected
                logger.debug(
                    "interceptor: category upgraded from %r to %r via Gemini",
                    category,
                    detected,
                )
        except Exception:
            logger.debug("interceptor: Gemini classification failed — keeping 'other'")

    # Route
    router = WorkflowRouter()
    route_result = router.route(message)

    logger.info(
        "interceptor: conv=%s category=%s fallthrough=%s matched=%s",
        conversation_id, message.category, route_result.fallthrough,
        route_result.matched_workflow.name if route_result.matched_workflow else None,
    )

    if route_result.fallthrough:
        return legacy_agent_chat(
            conversation_id=conversation_id,
            user_id=user_id,
            user_message=user_message,
            platform=platform,
            category=category,
            consecutive_low_confidence=consecutive_low_confidence,
            override_language=override_language,
        )

    engine = WorkflowExecutionEngine()

    try:
        if route_result.active_execution is not None:
            execution = engine.resume(
                execution=route_result.active_execution,
                workflow=route_result.matched_workflow,
                message=message,
                category_upgrade=route_result.category_upgrade,
            )
        else:
            execution = engine.start(
                workflow=route_result.matched_workflow,
                message=message,
            )
        return _execution_to_agent_response(execution)

    except Exception:
        logger.exception(
            "workflow_interceptor failed for conversation %s — falling through to legacy agent",
            conversation_id,
        )
        return legacy_agent_chat(
            conversation_id=conversation_id,
            user_id=user_id,
            user_message=user_message,
            platform=platform,
            category=category,
            consecutive_low_confidence=consecutive_low_confidence,
            override_language=override_language,
        )
