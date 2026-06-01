"""
WorkflowRouter — determines what handles an incoming message.

Resolution order:
1. Active execution for this conversation_id → resume it
2. Published workflow matching (channel + category) → start it
3. Neither → fallthrough to legacy agent

Category upgrade (Option C) is detected when an active execution exists
and the user's message contains upgrade keywords. The upgrade is reported
as a RouterResult field — the engine decides what to do with it.
"""
from __future__ import annotations
import logging
from workflow_engine.models import RouterResult, Workflow, WorkflowExecution
from workflow_engine.channel_adapter import ChannelMessage
from workflow_engine.store import get_active_execution, get_published_workflows, load_workflow_by_id

logger = logging.getLogger(__name__)

# Re-export for test patching convenience
from engine.agent import _detect_upgrade as detect_upgrade


def _trigger_matches(workflow: Workflow, channel: str, category: str) -> bool:
    ch_ok = workflow.trigger.channel in (channel, "any")
    cat_ok = workflow.trigger.category in (category, "any")
    return ch_ok and cat_ok


class WorkflowRouter:

    def route(self, message: ChannelMessage) -> RouterResult:
        # 1. Check for active execution
        active_execution: WorkflowExecution | None = get_active_execution(
            message.conversation_id
        )

        if active_execution is not None:
            workflow = load_workflow_by_id(active_execution.workflow_id)
            # If the workflow was deactivated after this execution started, fall through.
            if workflow is None or not workflow.published:
                return RouterResult(
                    matched_workflow=None,
                    active_execution=None,
                    fallthrough=True,
                    category_upgrade=None,
                )
            upgrade = detect_upgrade(message.text, active_execution.category)
            return RouterResult(
                matched_workflow=workflow,
                active_execution=active_execution,
                fallthrough=False,
                category_upgrade=upgrade,
            )

        # 2. Match a published workflow by trigger.
        # If the ticket is already escalated, don't restart the workflow from scratch —
        # fall through so the legacy agent path (and its is_human_handling guard) handles it.
        from db.conversation_store import is_human_handling
        if is_human_handling(message.conversation_id):
            return RouterResult(
                matched_workflow=None,
                active_execution=None,
                fallthrough=True,
                category_upgrade=None,
            )

        workflows = get_published_workflows()
        for wf in workflows:
            if _trigger_matches(wf, message.channel, message.category):
                return RouterResult(
                    matched_workflow=wf,
                    active_execution=None,
                    fallthrough=False,
                    category_upgrade=None,
                )

        # 3. No match — fall through to legacy agent
        return RouterResult(
            matched_workflow=None,
            active_execution=None,
            fallthrough=True,
            category_upgrade=None,
        )
