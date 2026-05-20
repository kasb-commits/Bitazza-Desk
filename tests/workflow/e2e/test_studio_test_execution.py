"""
E2E tests: AI Studio test execution mode.

Verifies that:
- POST /studio/test-run executes workflow in dry-run mode
- Dry-run produces per-node step output without touching any live conversation
- Dry-run never persists execution state to DB
- Dry-run never sends replies (no WebSocket, no email)
- Broken workflow returns per-step error without crashing
- Test run uses sample message from request body
"""
import pytest
from unittest.mock import MagicMock, patch


@pytest.fixture
def client():
    with patch("db.vector_store.chromadb"):
        from api.main import app
        from fastapi.testclient import TestClient
        return TestClient(app)


def _sample_flow_json():
    return {
        "nodes": [
            {"id": "start", "type": "message",
             "data": {"kind": "message", "label": "Start",
                      "text": "Hello! How can I help?"}},
            {"id": "n-condition", "type": "condition",
             "data": {"kind": "condition", "label": "Check intent",
                      "variable": "category", "operator": "==", "value": "kyc_verification"}},
            {"id": "n-kyc", "type": "message",
             "data": {"kind": "message", "label": "KYC Reply",
                      "text": "Your KYC is under review."}},
            {"id": "n-handoff", "type": "handoff",
             "data": {"kind": "handoff", "label": "Handoff", "team": "kyc"}},
        ],
        "edges": [
            {"id": "e1", "source": "start", "target": "n-condition"},
            {"id": "e2", "source": "n-condition", "target": "n-kyc",
             "sourceHandle": "true"},
            {"id": "e3", "source": "n-condition", "target": "n-handoff",
             "sourceHandle": "false"},
            {"id": "e4", "source": "n-kyc", "target": "n-handoff"},
        ],
    }


def _workflow_body(**kwargs):
    """Build a TestRunRequest body — workflow is passed directly (not fetched by ID)."""
    return {
        "workflow": {
            "id": "flow-test-1",
            "name": "Test Flow",
            "nodes_json": "[]",
            "edges_json": "[]",
            "trigger_channel": "widget",
            "trigger_category": "kyc_verification",
            "published": True,
            "version": 1,
        },
        "sample_message": "What is my KYC status?",
        "channel": "widget",
        "category": "kyc_verification",
        "language": "en",
        **kwargs,
    }


# ── Test execution mode: dry run ──────────────────────────────────────────────

class TestStudioTestExecution:

    def test_test_run_returns_per_node_steps(self, client):
        """
        POST /studio/test-run returns a list of step results,
        one per node executed.
        """
        with patch("workflow_engine.test_runner.run_test_execution") as mock_runner:

            mock_runner.return_value = {
                "steps": [
                    {"node_id": "start", "kind": "message",
                     "input": {}, "output": {"reply": "Hello! How can I help?"}, "error": None},
                    {"node_id": "n-condition", "kind": "condition",
                     "input": {"category": "kyc_verification"},
                     "output": {"branch": "true", "next_node_id": "n-kyc"}, "error": None},
                    {"node_id": "n-kyc", "kind": "message",
                     "input": {}, "output": {"reply": "Your KYC is under review."}, "error": None},
                    {"node_id": "n-handoff", "kind": "handoff",
                     "input": {}, "output": {"escalated": True, "team": "kyc"}, "error": None},
                ],
                "completed": True,
                "error": None,
            }

            response = client.post("/studio/test-run", json=_workflow_body())

        assert response.status_code == 200
        data = response.json()
        assert "steps" in data
        assert len(data["steps"]) == 4

    def test_test_run_does_not_persist_execution(self, client):
        """Dry-run must NEVER write to workflow_executions table."""
        with patch("workflow_engine.test_runner.run_test_execution") as mock_runner, \
             patch("workflow_engine.store.create_execution") as mock_create:

            mock_runner.return_value = {"steps": [], "completed": True, "error": None}

            client.post("/studio/test-run", json=_workflow_body(
                sample_message="hello", category="other"
            ))

        mock_create.assert_not_called()

    def test_test_run_does_not_send_reply(self, client):
        """Dry-run must never broadcast to WebSocket or send an email."""
        with patch("workflow_engine.test_runner.run_test_execution") as mock_runner, \
             patch("workflow_engine.nodes.send_reply.websocket_broadcast") as mock_ws, \
             patch("workflow_engine.nodes.send_reply.email_send_reply") as mock_email:

            mock_runner.return_value = {
                "steps": [
                    {"node_id": "start", "kind": "message",
                     "input": {}, "output": {"reply": "Hello"}, "error": None}
                ],
                "completed": True, "error": None,
            }

            client.post("/studio/test-run", json=_workflow_body(sample_message="hello"))

        mock_ws.assert_not_called()
        mock_email.assert_not_called()

    def test_test_run_with_broken_node_returns_error_step(self, client):
        """A broken node must return error in its step, not crash the whole test run."""
        with patch("workflow_engine.test_runner.run_test_execution") as mock_runner:

            mock_runner.return_value = {
                "steps": [
                    {"node_id": "start", "kind": "message",
                     "input": {}, "output": {"reply": "Hi"}, "error": None},
                    {"node_id": "n-broken", "kind": "api_call",
                     "input": {}, "output": None,
                     "error": "Connection timeout: /api/account"},
                ],
                "completed": False,
                "error": "Execution stopped at node n-broken",
            }

            response = client.post("/studio/test-run", json=_workflow_body(sample_message="hello"))

        assert response.status_code == 200
        data = response.json()
        broken_step = next(s for s in data["steps"] if s["node_id"] == "n-broken")
        assert broken_step["error"] is not None
        assert data["completed"] is False

    def test_test_run_shows_variable_values_at_each_step(self, client):
        """Each step output must include the variable context at that point."""
        with patch("workflow_engine.test_runner.run_test_execution") as mock_runner:

            mock_runner.return_value = {
                "steps": [
                    {
                        "node_id": "n-lookup", "kind": "account_lookup",
                        "input": {"user_id": "user-1"},
                        "output": {
                            "profile": {"kyc": {"status": "approved"}},
                        },
                        "variables_after": {
                            "language": "en", "category": "kyc_verification",
                            "profile": {"kyc": {"status": "approved"}},
                        },
                        "error": None,
                    },
                ],
                "completed": True, "error": None,
            }

            response = client.post("/studio/test-run", json=_workflow_body(
                sample_message="my kyc", category="kyc_verification"
            ))

        assert response.status_code == 200
        step = response.json()["steps"][0]
        assert "variables_after" in step
        assert step["variables_after"]["category"] == "kyc_verification"


# ── Test runner unit tests ────────────────────────────────────────────────────

class TestRunnerDryRunMode:

    def test_dry_run_execution_context_has_dry_run_flag(self):
        """ExecutionContext in dry-run mode must have dry_run=True."""
        from workflow_engine.test_runner import build_dry_run_context

        ctx = build_dry_run_context(
            sample_message="hello",
            channel="widget",
            category="other",
            language="en",
            user_id="test-user",
        )

        assert ctx.dry_run is True

    def test_dry_run_send_reply_node_does_not_broadcast(self):
        """When dry_run=True, send_reply node skips the actual broadcast."""
        from workflow_engine.nodes.send_reply import SendReplyNode
        from workflow_engine.models import WorkflowNode, ExecutionContext

        node = WorkflowNode(id="n1", kind="send_reply",
                            config={"text": "Hi"}, next_node_id=None)
        ctx = ExecutionContext(
            variables={"language": "en", "channel": "widget",
                       "user_id": "u1", "conversation_id": "c1"},
            conversation_id="c1",
            user_id="u1",
            channel="widget",
            dry_run=True,
        )

        with patch("workflow_engine.nodes.send_reply.websocket_broadcast") as mock_ws:
            result = SendReplyNode().run(node, ctx)

        mock_ws.assert_not_called()
        # But output must still contain the reply text for inspection
        assert result.output.get("reply") == "Hi"

    def test_dry_run_escalate_node_does_not_update_ticket(self):
        """When dry_run=True, escalate node must not modify ticket status."""
        from workflow_engine.nodes.escalate import EscalateNode
        from workflow_engine.models import WorkflowNode, ExecutionContext

        node = WorkflowNode(id="n1", kind="escalate",
                            config={"team": "kyc"}, next_node_id=None)
        ctx = ExecutionContext(
            variables={"language": "en", "channel": "widget",
                       "user_id": "u1", "conversation_id": "c1"},
            conversation_id="c1",
            user_id="u1",
            channel="widget",
            dry_run=True,
        )

        with patch("workflow_engine.nodes.escalate.update_ticket_status") as mock_update, \
             patch("workflow_engine.nodes.escalate.get_ticket_id_by_conversation",
                   return_value="t1"):
            result = EscalateNode().run(node, ctx)

        mock_update.assert_not_called()
        assert result.output.get("escalated") is True
