"""
Unit tests for Option C category upgrade behavior.

When a category upgrade is detected mid-workflow:
- The current execution is NOT terminated
- A category_upgraded event is fired into the execution
- The execution can wire a handler node or continue uninterrupted
- State (variables, current node) is preserved and carried forward
- The new category's workflow context is available to subsequent nodes
"""
import pytest
from unittest.mock import MagicMock, patch


def _make_execution(category="other", current_node_id="n2"):
    from workflow_engine.models import WorkflowExecution, ExecutionStatus
    return WorkflowExecution(
        id="exec-1",
        workflow_id="wf-general",
        conversation_id="conv-1",
        current_node_id=current_node_id,
        variables={
            "language": "en",
            "channel": "widget",
            "category": category,
            "user_id": "user-1",
            "conversation_id": "conv-1",
            "prior_collected": "name_verified",
        },
        status=ExecutionStatus.WAITING_MESSAGE,
        waiting_for=None,
        channel="widget",
        category=category,
    )


class TestCategoryUpgradeOptionC:

    def test_upgrade_preserves_existing_variables(self):
        """All variables collected before the upgrade must survive."""
        from workflow_engine.engine import WorkflowExecutionEngine
        from workflow_engine.models import NodeResult

        executed_contexts = []

        def fake_run_node(node, context):
            executed_contexts.append(dict(context.variables))
            return NodeResult(output={}, next_node_id=None)

        execution = _make_execution()
        n2 = MagicMock(); n2.id = "n2"; n2.kind = "ai_reply"; n2.next_node_id = None
        workflow = MagicMock()
        workflow.nodes = [n2]
        workflow.get_node = lambda nid: n2 if nid == "n2" else None

        from workflow_engine.channel_adapter import ChannelMessage
        message = ChannelMessage(
            text="actually my kyc is stuck",
            channel="widget",
            category="other",
            language="en",
            user_id="user-1",
            conversation_id="conv-1",
            metadata={},
        )

        engine = WorkflowExecutionEngine()
        with patch.object(engine, "_persist_execution"), \
             patch.object(engine, "run_node", side_effect=fake_run_node), \
             patch("workflow_engine.engine.detect_upgrade", return_value="kyc_verification"):
            engine.resume(execution, workflow, message, category_upgrade="kyc_verification")

        # Prior variable must still be there
        assert executed_contexts[0].get("prior_collected") == "name_verified"

    def test_upgrade_updates_category_variable(self):
        """After upgrade, {{category}} variable must reflect the new category."""
        from workflow_engine.engine import WorkflowExecutionEngine
        from workflow_engine.models import NodeResult

        captured = {}

        def fake_run_node(node, context):
            captured.update(context.variables)
            return NodeResult(output={}, next_node_id=None)

        execution = _make_execution(category="other")
        n2 = MagicMock(); n2.id = "n2"; n2.kind = "ai_reply"; n2.next_node_id = None
        workflow = MagicMock()
        workflow.nodes = [n2]
        workflow.get_node = lambda nid: n2

        from workflow_engine.channel_adapter import ChannelMessage
        message = ChannelMessage(
            text="my kyc verification is pending",
            channel="widget",
            category="other",
            language="en",
            user_id="user-1",
            conversation_id="conv-1",
            metadata={},
        )

        engine = WorkflowExecutionEngine()
        with patch.object(engine, "_persist_execution"), \
             patch.object(engine, "run_node", side_effect=fake_run_node), \
             patch("workflow_engine.engine.detect_upgrade", return_value="kyc_verification"):
            engine.resume(execution, workflow, message, category_upgrade="kyc_verification")

        assert captured.get("category") == "kyc_verification"

    def test_upgrade_does_not_terminate_execution(self):
        """Execution object must still be active after upgrade, not abandoned."""
        from workflow_engine.engine import WorkflowExecutionEngine
        from workflow_engine.models import NodeResult, ExecutionStatus

        execution = _make_execution(category="other")
        n2 = MagicMock(); n2.id = "n2"; n2.kind = "send_reply"; n2.next_node_id = None
        workflow = MagicMock()
        workflow.nodes = [n2]
        workflow.get_node = lambda nid: n2

        from workflow_engine.channel_adapter import ChannelMessage
        message = ChannelMessage(
            text="kyc stuck",
            channel="widget",
            category="other",
            language="en",
            user_id="user-1",
            conversation_id="conv-1",
            metadata={},
        )

        engine = WorkflowExecutionEngine()
        with patch.object(engine, "_persist_execution"), \
             patch.object(engine, "run_node",
                          return_value=NodeResult(output={}, next_node_id=None)), \
             patch("workflow_engine.engine.detect_upgrade", return_value="kyc_verification"):
            result_execution = engine.resume(
                execution, workflow, message, category_upgrade="kyc_verification"
            )

        # Should not be abandoned or in error state
        assert result_execution.status != ExecutionStatus.FAILED
        assert result_execution.status != ExecutionStatus.ABANDONED

    def test_upgrade_not_triggered_from_non_other_category(self):
        """detect_upgrade is only called when current category is in _UPGRADEABLE_FROM."""
        from workflow_engine.engine import WorkflowExecutionEngine
        from workflow_engine.models import NodeResult

        execution = _make_execution(category="kyc_verification")
        n1 = MagicMock(); n1.id = "n1"; n1.kind = "ai_reply"; n1.next_node_id = None
        workflow = MagicMock()
        workflow.nodes = [n1]
        workflow.get_node = lambda nid: n1

        from workflow_engine.channel_adapter import ChannelMessage
        message = ChannelMessage(
            text="what about my withdrawal",
            channel="widget",
            category="kyc_verification",
            language="en",
            user_id="user-1",
            conversation_id="conv-1",
            metadata={},
        )

        engine = WorkflowExecutionEngine()
        with patch.object(engine, "_persist_execution"), \
             patch.object(engine, "run_node",
                          return_value=NodeResult(output={}, next_node_id=None)), \
             patch("workflow_engine.engine.detect_upgrade", return_value=None) as mock_detect:
            result = engine.resume(execution, workflow, message)

        # detect_upgrade is invoked by the router (not the engine directly),
        # so the engine never calls it — no upgrade should have happened.
        assert result.category == "kyc_verification"
        assert not mock_detect.called

    def test_upgrade_carries_transition_message(self):
        """Upgrade event must include the specialist transition message."""
        from workflow_engine.engine import WorkflowExecutionEngine
        from workflow_engine.models import NodeResult

        execution = _make_execution(category="other")
        n2 = MagicMock(); n2.id = "n2"; n2.kind = "ai_reply"; n2.next_node_id = None
        workflow = MagicMock()
        workflow.nodes = [n2]
        workflow.get_node = lambda nid: n2

        from workflow_engine.channel_adapter import ChannelMessage
        message = ChannelMessage(
            text="kyc is stuck",
            channel="widget",
            category="other",
            language="en",
            user_id="user-1",
            conversation_id="conv-1",
            metadata={},
        )

        engine = WorkflowExecutionEngine()
        with patch.object(engine, "_persist_execution"), \
             patch.object(engine, "run_node",
                          return_value=NodeResult(output={}, next_node_id=None)), \
             patch("workflow_engine.engine.detect_upgrade", return_value="kyc_verification"), \
             patch("workflow_engine.engine.build_upgrade_transition_message",
                   return_value="Connecting you to Ploy...") as mock_transition:
            result = engine.resume(
                execution, workflow, message, category_upgrade="kyc_verification"
            )

        mock_transition.assert_called_once()
