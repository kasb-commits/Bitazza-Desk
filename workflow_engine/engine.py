"""
WorkflowExecutionEngine — stateful execution of workflow graphs.

Responsibilities:
- start():              create execution, inject built-in vars, run from first node
- resume():             continue a paused execution from current_node_id
- resume_from_trigger() continue execution waiting for an external HTTP trigger
- run_node():           dispatch to the correct node implementation
- _persist_execution(): save execution state to DB after every state change
- _fallthrough_to_legacy(): call legacy agent when workflow fails

Category upgrade (Option C):
  resume() accepts an optional category_upgrade kwarg. When set, the
  execution's category variable is updated and a transition message is
  generated — the execution itself is NOT terminated.

Security invariants:
  pre_filter and post_filter are enforced inside ai_reply.AiReplyNode,
  not here. This engine has no knowledge of security concerns.
"""
from __future__ import annotations
import logging
import uuid
from typing import Any

from workflow_engine.models import (
    Workflow, WorkflowExecution, WorkflowNode,
    ExecutionContext, NodeResult, ExecutionStatus, RouterResult,
)
from workflow_engine.channel_adapter import ChannelMessage
from workflow_engine.store import (
    create_execution, update_execution_status,
    load_execution_by_trigger_token,
)
from workflow_engine.exceptions import TriggerTokenExpiredError

logger = logging.getLogger(__name__)


# Re-exported for test patching
from engine.agent import _detect_upgrade as detect_upgrade


def build_upgrade_transition_message(category: str, language: str, specialist_name: str) -> str:
    from engine.agent import _UPGRADE_TRANSITION_MESSAGES
    templates = _UPGRADE_TRANSITION_MESSAGES.get(category, {})
    template = templates.get(language) or templates.get("en", "Connecting you to {specialist}.")
    return template.format(specialist=specialist_name)


_NODE_REGISTRY: dict[str, type] = {}


def _get_node_runner(kind: str):
    if not _NODE_REGISTRY:
        from workflow_engine.nodes.send_reply    import SendReplyNode
        from workflow_engine.nodes.ai_reply      import AiReplyNode
        from workflow_engine.nodes.account_lookup import AccountLookupNode
        from workflow_engine.nodes.condition     import ConditionNode
        from workflow_engine.nodes.escalate      import EscalateNode
        from workflow_engine.nodes.wait_for_reply import WaitForReplyNode
        from workflow_engine.nodes.wait_for_trigger import WaitForTriggerNode
        from workflow_engine.nodes.resolve_ticket import ResolveTicketNode
        from workflow_engine.nodes.set_variable  import SetVariableNode
        _NODE_REGISTRY.update({
            "send_reply":      SendReplyNode,
            "ai_reply":        AiReplyNode,
            "account_lookup":  AccountLookupNode,
            "condition":       ConditionNode,
            "escalate":        EscalateNode,
            "wait_for_reply":  WaitForReplyNode,
            "wait_for_trigger": WaitForTriggerNode,
            "resolve_ticket":  ResolveTicketNode,
            "set_variable":    SetVariableNode,
        })
    cls = _NODE_REGISTRY.get(kind)
    if cls is None:
        raise ValueError(f"Unknown node kind: {kind}")
    return cls()


def _build_builtin_vars(message: ChannelMessage) -> dict[str, Any]:
    return {
        "language":        message.language,
        "channel":         message.channel,
        "category":        message.category,
        "user_id":         message.user_id,
        "conversation_id": message.conversation_id,
        "user_message":    message.text,
        **message.metadata,
    }


class WorkflowExecutionEngine:

    # ── Public API ────────────────────────────────────────────────────────────

    def start(self, workflow: Workflow, message: ChannelMessage) -> WorkflowExecution:
        exec_id   = str(uuid.uuid4())
        variables = _build_builtin_vars(message)

        execution = WorkflowExecution(
            id=exec_id,
            workflow_id=workflow.id,
            conversation_id=message.conversation_id,
            current_node_id=workflow.first_node().id if workflow.first_node() else None,
            variables=variables,
            status=ExecutionStatus.RUNNING,
            waiting_for=None,
            channel=message.channel,
            category=message.category,
        )
        self._persist_execution(execution)
        logger.info("workflow_start", extra={
            "workflow_id": workflow.id,
            "workflow_name": getattr(workflow, "name", None),
            "conv_id": message.conversation_id,
            "channel": message.channel,
            "category": message.category,
        })

        try:
            return self._run_from_node(execution, workflow, message)
        except Exception:
            logger.exception("Workflow engine start() failed for workflow %s", workflow.id)
            self._fallthrough_to_legacy(message)
            execution.status = ExecutionStatus.FAILED
            self._persist_execution(execution)
            return execution

    def resume(
        self,
        execution: WorkflowExecution,
        workflow: Workflow,
        message: ChannelMessage,
        category_upgrade: str | None = None,
    ) -> WorkflowExecution:
        # Update variables with new message
        execution.variables.update(_build_builtin_vars(message))

        # Advance past the paused wait_for_reply node so the next node runs.
        # The wait node's current_node_id points to itself — move to next_node_id.
        if execution.waiting_for == "message" and execution.current_node_id:
            paused_node = workflow.get_node(execution.current_node_id)
            if paused_node and paused_node.next_node_id:
                execution.current_node_id = paused_node.next_node_id
        execution.waiting_for = None

        # Option C: carry upgrade forward without terminating execution
        if category_upgrade:
            execution.variables["category"] = category_upgrade
            execution.category = category_upgrade
            from engine.mock_agents import pick_agent
            specialist = pick_agent(category_upgrade)
            execution.transition_message = build_upgrade_transition_message(
                category_upgrade,
                message.language,
                specialist["name"],
            )

        execution.status = ExecutionStatus.RUNNING
        self._persist_execution(execution)
        logger.info("workflow_resume", extra={
            "execution_id": execution.id,
            "workflow_id": execution.workflow_id,
            "conv_id": execution.conversation_id,
            "current_node_id": execution.current_node_id,
            "category_upgrade": category_upgrade,
        })

        try:
            return self._run_from_node(execution, workflow, message)
        except Exception:
            logger.exception("Workflow engine resume() failed for execution %s", execution.id)
            self._fallthrough_to_legacy(message)
            execution.status = ExecutionStatus.FAILED
            self._persist_execution(execution)
            return execution

    def resume_from_trigger(self, token: str, trigger_data: dict) -> WorkflowExecution:
        result = load_execution_by_trigger_token(token)
        if result is None:
            raise TriggerTokenExpiredError(f"No execution found for token: {token}")

        execution, workflow = result
        execution.variables.update(trigger_data)
        execution.status = ExecutionStatus.RUNNING
        execution.waiting_for = None
        self._persist_execution(execution)

        # Build a minimal ChannelMessage from stored context
        msg = ChannelMessage(
            text=execution.variables.get("user_message", ""),
            channel=execution.channel,
            category=execution.category,
            language=execution.variables.get("language", "en"),
            user_id=execution.variables.get("user_id", ""),
            conversation_id=execution.conversation_id,
            metadata={k: v for k, v in execution.variables.items()
                      if k not in ("language", "channel", "category",
                                   "user_id", "conversation_id", "user_message")},
        )

        try:
            return self._run_from_node(execution, workflow, msg)
        except Exception:
            logger.exception("resume_from_trigger failed for token %s", token)
            self._fallthrough_to_legacy(msg)
            execution.status = ExecutionStatus.FAILED
            self._persist_execution(execution)
            return execution

    # ── Internal ──────────────────────────────────────────────────────────────

    def _run_from_node(
        self,
        execution: WorkflowExecution,
        workflow: Workflow,
        message: ChannelMessage,
    ) -> WorkflowExecution:
        current_node_id = execution.current_node_id

        escalate_node_ran = False
        while current_node_id:
            node = workflow.get_node(current_node_id)
            if node is None:
                logger.error("Node %s not found in workflow %s", current_node_id, workflow.id)
                break

            if node.kind == "escalate":
                escalate_node_ran = True

            ctx = ExecutionContext(
                variables=dict(execution.variables),
                conversation_id=execution.conversation_id,
                user_id=execution.variables.get("user_id", ""),
                channel=execution.channel,
                dry_run=False,
            )

            logger.debug("node_entry", extra={
                "execution_id": execution.id,
                "node_id": node.id,
                "node_kind": node.kind,
                "conv_id": execution.conversation_id,
            })

            try:
                result = self.run_node(node, ctx)
            except Exception as node_exc:
                if node.on_error_next_id:
                    logger.warning(
                        "Node %s (%s) raised — routing to error branch %s: %s",
                        node.id, node.kind, node.on_error_next_id, node_exc,
                    )
                    execution.variables["_last_error"] = str(node_exc)
                    current_node_id = node.on_error_next_id
                    continue
                raise

            logger.debug("node_exit", extra={
                "execution_id": execution.id,
                "node_id": node.id,
                "node_kind": node.kind,
                "next_node_id": result.next_node_id,
                "paused": result.pause,
            })

            # Merge node outputs into execution variables
            execution.variables.update(result.output)

            # Propagate reply and escalation flags to execution level
            if "reply" in result.output:
                execution.output_reply = result.output["reply"]
            # Only the EscalateNode sets "escalated_final" — this marks the execution as
            # truly handed off to a human. AiReplyNode sets "escalated" in variables so
            # the chk_esc condition can route, but that must NOT sticky execution.escalated
            # (which would suppress pills on all subsequent gathering turns).
            if result.output.get("escalated_final"):
                execution.escalated = True
            if result.output.get("resolved"):
                execution.resolved = True

            if result.pause:
                # Save paused state
                execution.current_node_id = node.id
                execution.waiting_for = result.waiting_for
                execution.status = (
                    ExecutionStatus.WAITING_TRIGGER
                    if result.waiting_for and result.waiting_for.startswith("external_trigger:")
                    else ExecutionStatus.WAITING_MESSAGE
                )
                self._persist_execution(execution)
                logger.info("workflow_paused", extra={
                    "execution_id": execution.id,
                    "node_id": node.id,
                    "node_kind": node.kind,
                    "waiting_for": result.waiting_for,
                    "conv_id": execution.conversation_id,
                })
                return execution

            current_node_id = result.next_node_id

        # Safety net: if the ai_reply node triggered escalation but the workflow
        # designer omitted an escalate node, still send the handoff message and
        # update the ticket status so the conversation isn't silently dropped.
        if execution.escalated and not escalate_node_ran:
            try:
                from engine.prompt_templates import build_handoff_message
                from db.conversation_store import (
                    get_ticket_id_by_conversation,
                    update_ticket_status,
                )
                category = execution.variables.get("category")
                language = execution.variables.get("language", "en")
                handoff  = build_handoff_message(category, language)
                suffix   = f"\n\n{handoff}"
                execution.output_reply = (execution.output_reply or "") + suffix
                status = "Escalated" if execution.channel == "email" else "pending_human"
                ticket_id = get_ticket_id_by_conversation(execution.conversation_id)
                if ticket_id:
                    update_ticket_status(ticket_id, status)
                logger.warning(
                    "Workflow %s escalated without an escalate node — safety net fired",
                    execution.workflow_id,
                )
            except Exception:
                logger.exception("Escalation safety net failed for execution %s", execution.id)

        # All nodes exhausted
        execution.status = ExecutionStatus.COMPLETED
        execution.current_node_id = None
        self._persist_execution(execution)
        logger.info("workflow_complete", extra={
            "execution_id": execution.id,
            "workflow_id": execution.workflow_id,
            "conv_id": execution.conversation_id,
            "escalated": execution.escalated,
            "resolved": execution.resolved,
        })
        return execution

    def run_node(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        runner = _get_node_runner(node.kind)
        return runner.run(node, ctx)

    def _persist_execution(self, execution: WorkflowExecution) -> None:
        try:
            update_execution_status(
                execution_id=execution.id,
                status=execution.status,
                current_node_id=execution.current_node_id,
                waiting_for=execution.waiting_for,
                variables=execution.variables,
            )
            logger.info("_persist_execution: updated %s status=%s", execution.id, execution.status)
        except Exception as update_err:
            logger.info("_persist_execution: update failed (%s), trying create", update_err)
            # On first save (execution doesn't exist yet), create it
            try:
                create_execution(
                    execution_id=execution.id,
                    workflow_id=execution.workflow_id,
                    conversation_id=execution.conversation_id,
                    current_node_id=execution.current_node_id,
                    variables=execution.variables,
                    status=execution.status,
                    channel=execution.channel,
                    category=execution.category,
                )
                logger.info("_persist_execution: created %s", execution.id)
            except Exception:
                logger.exception("Failed to persist execution %s", execution.id)

    def _fallthrough_to_legacy(self, message: ChannelMessage) -> None:
        """Log only — caller is responsible for invoking the legacy agent."""
        logger.warning(
            "Workflow engine failed — falling through to legacy agent for conversation %s",
            message.conversation_id,
        )
