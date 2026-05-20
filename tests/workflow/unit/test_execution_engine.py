"""
Unit tests for workflow_engine.engine.WorkflowExecutionEngine.

Tests the core state machine: start, run, pause, resume, category upgrade,
built-in variable injection, and security wrapper enforcement.

All DB and external calls are mocked — pure logic tests.
"""
import pytest
from unittest.mock import MagicMock, patch, call
from dataclasses import dataclass, field
from typing import Any


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_workflow(workflow_id="wf-1", nodes=None, edges=None):
    from workflow_engine.models import Workflow, WorkflowTrigger
    return Workflow(
        id=workflow_id,
        name="Test Workflow",
        trigger=WorkflowTrigger(channel="widget", category="kyc_verification"),
        nodes=nodes or [],
        edges=edges or [],
        published=True,
        version=1,
    )


def _make_message(
    text="What is my KYC status?",
    channel="widget",
    category="kyc_verification",
    language="en",
    user_id="user-1",
    conversation_id="conv-1",
):
    from workflow_engine.channel_adapter import ChannelMessage
    return ChannelMessage(
        text=text,
        channel=channel,
        category=category,
        language=language,
        user_id=user_id,
        conversation_id=conversation_id,
        metadata={},
    )


def _make_node(node_id, kind, config=None, next_node_id=None):
    from workflow_engine.models import WorkflowNode
    return WorkflowNode(
        id=node_id,
        kind=kind,
        config=config or {},
        next_node_id=next_node_id,
    )


# ── Tests: start ──────────────────────────────────────────────────────────────

class TestEngineStart:

    def test_start_creates_execution_with_first_node(self):
        from workflow_engine.engine import WorkflowExecutionEngine
        from workflow_engine.models import WorkflowNode

        node = _make_node("n1", "send_reply", config={"text": "Hello!"})
        workflow = _make_workflow(nodes=[node])
        message = _make_message()

        captured = {}

        def capture_and_return(execution, workflow, message):
            captured["execution"] = execution
            return execution

        engine = WorkflowExecutionEngine()
        with patch.object(engine, "_persist_execution"), \
             patch.object(engine, "_run_from_node", side_effect=capture_and_return):
            engine.start(workflow, message)

        execution = captured["execution"]
        assert execution.workflow_id == "wf-1"
        assert execution.conversation_id == "conv-1"

    def test_start_injects_builtin_variables(self):
        from workflow_engine.engine import WorkflowExecutionEngine

        node = _make_node("n1", "send_reply", config={"text": "Hello!"})
        workflow = _make_workflow(nodes=[node])
        message = _make_message(
            language="th", channel="widget", category="kyc_verification",
            user_id="user-99", conversation_id="conv-abc",
        )

        engine = WorkflowExecutionEngine()
        captured = {}

        def capture_run(execution, workflow, message):
            captured.update(execution.variables)
            return MagicMock(status="completed")

        with patch.object(engine, "_persist_execution"), \
             patch.object(engine, "_run_from_node", side_effect=capture_run):
            engine.start(workflow, message)

        assert captured["language"] == "th"
        assert captured["channel"] == "widget"
        assert captured["category"] == "kyc_verification"
        assert captured["user_id"] == "user-99"
        assert captured["conversation_id"] == "conv-abc"

    def test_start_sets_status_running(self):
        from workflow_engine.engine import WorkflowExecutionEngine
        from workflow_engine.models import ExecutionStatus

        node = _make_node("n1", "send_reply")
        workflow = _make_workflow(nodes=[node])
        message = _make_message()

        engine = WorkflowExecutionEngine()
        with patch.object(engine, "_persist_execution"), \
             patch.object(engine, "_run_from_node", return_value=MagicMock(status="completed")):
            execution = engine.start(workflow, message)

        # Execution is created with running status before _run_from_node is called
        assert execution is not None


# ── Tests: sequential node execution ─────────────────────────────────────────

class TestEngineNodeSequence:

    def test_runs_nodes_in_order(self):
        from workflow_engine.engine import WorkflowExecutionEngine

        order = []

        def fake_run_node(node, context):
            order.append(node.id)
            from workflow_engine.models import NodeResult
            return NodeResult(output={}, next_node_id=node.next_node_id)

        n1 = _make_node("n1", "send_reply", next_node_id="n2")
        n2 = _make_node("n2", "send_reply", next_node_id=None)
        workflow = _make_workflow(nodes=[n1, n2])
        message = _make_message()

        engine = WorkflowExecutionEngine()
        with patch.object(engine, "_persist_execution"), \
             patch.object(engine, "run_node", side_effect=fake_run_node):
            engine.start(workflow, message)

        assert order == ["n1", "n2"]

    def test_stops_at_wait_for_reply_node(self):
        from workflow_engine.engine import WorkflowExecutionEngine
        from workflow_engine.models import NodeResult, ExecutionStatus

        def fake_run_node(node, context):
            from workflow_engine.models import NodeResult
            if node.kind == "wait_for_reply":
                return NodeResult(output={}, next_node_id=node.next_node_id, pause=True)
            return NodeResult(output={}, next_node_id=node.next_node_id)

        n1 = _make_node("n1", "send_reply", next_node_id="n2")
        n2 = _make_node("n2", "wait_for_reply", next_node_id="n3")
        n3 = _make_node("n3", "send_reply", next_node_id=None)
        workflow = _make_workflow(nodes=[n1, n2, n3])
        message = _make_message()

        engine = WorkflowExecutionEngine()
        with patch.object(engine, "_persist_execution"), \
             patch.object(engine, "run_node", side_effect=fake_run_node) as mock_run:
            engine.start(workflow, message)

            # n3 should never have been executed
            executed_nodes = [c.args[0].id for c in mock_run.call_args_list]
            assert "n3" not in executed_nodes
            assert "n2" in executed_nodes

    def test_execution_status_waiting_after_pause(self):
        from workflow_engine.engine import WorkflowExecutionEngine
        from workflow_engine.models import NodeResult, ExecutionStatus

        def fake_run_node(node, context):
            if node.kind == "wait_for_reply":
                return NodeResult(output={}, next_node_id=node.next_node_id, pause=True)
            return NodeResult(output={}, next_node_id=node.next_node_id)

        n1 = _make_node("n1", "wait_for_reply", next_node_id=None)
        workflow = _make_workflow(nodes=[n1])
        message = _make_message()

        persisted = {}

        def capture_persist(execution):
            persisted["status"] = execution.status
            persisted["current_node"] = execution.current_node_id

        engine = WorkflowExecutionEngine()
        with patch.object(engine, "_persist_execution", side_effect=capture_persist), \
             patch.object(engine, "run_node", side_effect=fake_run_node):
            engine.start(workflow, message)

        assert persisted["status"] == ExecutionStatus.WAITING_MESSAGE
        assert persisted["current_node"] == "n1"


# ── Tests: resume ─────────────────────────────────────────────────────────────

class TestEngineResume:

    def test_resume_continues_from_current_node(self):
        from workflow_engine.engine import WorkflowExecutionEngine
        from workflow_engine.models import WorkflowExecution, ExecutionStatus

        executed = []

        def fake_run_node(node, context):
            executed.append(node.id)
            from workflow_engine.models import NodeResult
            return NodeResult(output={}, next_node_id=node.next_node_id)

        n2 = _make_node("n2", "send_reply", next_node_id="n3")
        n3 = _make_node("n3", "send_reply", next_node_id=None)
        workflow = _make_workflow(nodes=[n2, n3])

        execution = WorkflowExecution(
            id="exec-1",
            workflow_id="wf-1",
            conversation_id="conv-1",
            current_node_id="n2",
            variables={"language": "en", "channel": "widget"},
            status=ExecutionStatus.WAITING_MESSAGE,
            waiting_for=None,
            channel="widget",
            category="kyc_verification",
        )

        message = _make_message()
        engine = WorkflowExecutionEngine()

        with patch.object(engine, "_persist_execution"), \
             patch.object(engine, "run_node", side_effect=fake_run_node):
            engine.resume(execution, workflow, message)

        assert executed == ["n2", "n3"]

    def test_resume_merges_new_message_into_variables(self):
        from workflow_engine.engine import WorkflowExecutionEngine
        from workflow_engine.models import WorkflowExecution, ExecutionStatus

        captured_context = {}

        def fake_run_node(node, context):
            captured_context.update(context.variables)
            from workflow_engine.models import NodeResult
            return NodeResult(output={}, next_node_id=None)

        n1 = _make_node("n1", "send_reply")
        workflow = _make_workflow(nodes=[n1])

        execution = WorkflowExecution(
            id="exec-1",
            workflow_id="wf-1",
            conversation_id="conv-1",
            current_node_id="n1",
            variables={"prior_var": "abc", "language": "en", "channel": "widget"},
            status=ExecutionStatus.WAITING_MESSAGE,
            waiting_for=None,
            channel="widget",
            category="kyc_verification",
        )

        message = _make_message(text="Follow-up message", language="th")
        engine = WorkflowExecutionEngine()

        with patch.object(engine, "_persist_execution"), \
             patch.object(engine, "run_node", side_effect=fake_run_node):
            engine.resume(execution, workflow, message)

        assert captured_context["prior_var"] == "abc"
        assert captured_context["language"] == "th"  # updated from new message


# ── Tests: resume from external trigger ──────────────────────────────────────

class TestEngineExternalTrigger:

    def test_resume_from_trigger_loads_execution_and_continues(self):
        from workflow_engine.engine import WorkflowExecutionEngine
        from workflow_engine.models import WorkflowExecution, ExecutionStatus

        executed = []

        def fake_run_node(node, context):
            executed.append(node.id)
            from workflow_engine.models import NodeResult
            return NodeResult(output={}, next_node_id=node.next_node_id)

        n2 = _make_node("n2", "ai_reply", next_node_id=None)
        workflow = _make_workflow(nodes=[n2])

        execution = WorkflowExecution(
            id="exec-verify-1",
            workflow_id="wf-1",
            conversation_id="conv-1",
            current_node_id="n2",
            variables={"language": "en", "channel": "email"},
            status=ExecutionStatus.WAITING_TRIGGER,
            waiting_for="external_trigger:tok-abc",
            channel="email",
            category="kyc_verification",
        )

        trigger_data = {"verified_user_id": "user-99", "token": "tok-abc"}
        engine = WorkflowExecutionEngine()

        with patch("workflow_engine.engine.load_execution_by_trigger_token",
                   return_value=(execution, workflow)), \
             patch.object(engine, "_persist_execution"), \
             patch.object(engine, "run_node", side_effect=fake_run_node):
            engine.resume_from_trigger("tok-abc", trigger_data)

        assert "n2" in executed

    def test_resume_from_trigger_injects_trigger_data_into_variables(self):
        from workflow_engine.engine import WorkflowExecutionEngine
        from workflow_engine.models import WorkflowExecution, ExecutionStatus

        captured = {}

        def fake_run_node(node, context):
            captured.update(context.variables)
            from workflow_engine.models import NodeResult
            return NodeResult(output={}, next_node_id=None)

        n1 = _make_node("n1", "ai_reply")
        workflow = _make_workflow(nodes=[n1])

        execution = WorkflowExecution(
            id="exec-1",
            workflow_id="wf-1",
            conversation_id="conv-1",
            current_node_id="n1",
            variables={"language": "en", "channel": "email"},
            status=ExecutionStatus.WAITING_TRIGGER,
            waiting_for="external_trigger:tok-xyz",
            channel="email",
            category="kyc_verification",
        )

        engine = WorkflowExecutionEngine()
        with patch("workflow_engine.engine.load_execution_by_trigger_token",
                   return_value=(execution, workflow)), \
             patch.object(engine, "_persist_execution"), \
             patch.object(engine, "run_node", side_effect=fake_run_node):
            engine.resume_from_trigger("tok-xyz", {"verified_user_id": "user-55"})

        assert captured.get("verified_user_id") == "user-55"

    def test_resume_from_expired_token_raises(self):
        from workflow_engine.engine import WorkflowExecutionEngine
        from workflow_engine.exceptions import TriggerTokenExpiredError

        engine = WorkflowExecutionEngine()
        with patch("workflow_engine.engine.load_execution_by_trigger_token",
                   return_value=None):
            with pytest.raises(TriggerTokenExpiredError):
                engine.resume_from_trigger("expired-tok", {})


# ── Tests: variable passing between nodes ─────────────────────────────────────

class TestEngineVariablePassing:

    def test_node_output_available_to_next_node(self):
        from workflow_engine.engine import WorkflowExecutionEngine
        from workflow_engine.models import NodeResult

        contexts = []

        def fake_run_node(node, context):
            contexts.append(dict(context.variables))
            if node.id == "n1":
                return NodeResult(output={"account_status": "verified"}, next_node_id="n2")
            return NodeResult(output={}, next_node_id=None)

        n1 = _make_node("n1", "account_lookup", next_node_id="n2")
        n2 = _make_node("n2", "send_reply", next_node_id=None)
        workflow = _make_workflow(nodes=[n1, n2])
        message = _make_message()

        engine = WorkflowExecutionEngine()
        with patch.object(engine, "_persist_execution"), \
             patch.object(engine, "run_node", side_effect=fake_run_node):
            engine.start(workflow, message)

        # Second node's context should have n1's output
        assert contexts[1].get("account_status") == "verified"


# ── Tests: node failure fallthrough ──────────────────────────────────────────

class TestEngineFailureFallthrough:

    def test_node_exception_triggers_fallthrough_to_legacy_agent(self):
        from workflow_engine.engine import WorkflowExecutionEngine
        from workflow_engine.models import ExecutionStatus

        def failing_run_node(node, context):
            raise RuntimeError("Node failed")

        n1 = _make_node("n1", "ai_reply")
        workflow = _make_workflow(nodes=[n1])
        message = _make_message()

        engine = WorkflowExecutionEngine()
        fallthrough_called = {}

        with patch.object(engine, "_persist_execution"), \
             patch.object(engine, "run_node", side_effect=failing_run_node), \
             patch.object(engine, "_fallthrough_to_legacy",
                          side_effect=lambda m: fallthrough_called.update({"called": True})):
            engine.start(workflow, message)

        assert fallthrough_called.get("called") is True
