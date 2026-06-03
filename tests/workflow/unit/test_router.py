"""
Unit tests for workflow_engine.router.WorkflowRouter.

Tests: trigger matching (channel + category), active execution lookup,
no-match fallthrough, and category-upgrade-aware routing (Option C).
"""
import pytest
from unittest.mock import MagicMock, patch


@pytest.fixture(autouse=True)
def mock_is_human_handling():
    with patch("db.conversation_store.is_human_handling", return_value=False):
        yield


def _make_trigger(channel="widget", category="kyc_verification"):
    from workflow_engine.models import WorkflowTrigger
    return WorkflowTrigger(channel=channel, category=category)


def _make_workflow(workflow_id="wf-1", channel="widget", category="kyc_verification",
                   published=True):
    from workflow_engine.models import Workflow
    return Workflow(
        id=workflow_id,
        name="Test",
        trigger=_make_trigger(channel=channel, category=category),
        nodes=[],
        edges=[],
        published=published,
        version=1,
    )


def _make_message(channel="widget", category="kyc_verification", conversation_id="conv-1"):
    from workflow_engine.channel_adapter import ChannelMessage
    return ChannelMessage(
        text="What is my KYC status?",
        channel=channel,
        category=category,
        language="en",
        user_id="user-1",
        conversation_id=conversation_id,
        metadata={},
    )


# ── Trigger matching ──────────────────────────────────────────────────────────

class TestRouterTriggerMatching:

    def test_matches_exact_channel_and_category(self):
        from workflow_engine.router import WorkflowRouter

        workflow = _make_workflow(channel="widget", category="kyc_verification")
        msg = _make_message(channel="widget", category="kyc_verification")

        router = WorkflowRouter()
        with patch("workflow_engine.router.get_published_workflows", return_value=[workflow]), \
             patch("workflow_engine.router.get_active_execution", return_value=None):
            result = router.route(msg)

        assert result.matched_workflow.id == "wf-1"

    def test_no_match_different_category(self):
        from workflow_engine.router import WorkflowRouter

        workflow = _make_workflow(channel="widget", category="kyc_verification")
        msg = _make_message(channel="widget", category="withdrawal_issue")

        router = WorkflowRouter()
        with patch("workflow_engine.router.get_published_workflows", return_value=[workflow]), \
             patch("workflow_engine.router.get_active_execution", return_value=None):
            result = router.route(msg)

        assert result.matched_workflow is None
        assert result.fallthrough is True

    def test_no_match_different_channel(self):
        from workflow_engine.router import WorkflowRouter

        workflow = _make_workflow(channel="widget", category="kyc_verification")
        msg = _make_message(channel="email", category="kyc_verification")

        router = WorkflowRouter()
        with patch("workflow_engine.router.get_published_workflows", return_value=[workflow]), \
             patch("workflow_engine.router.get_active_execution", return_value=None):
            result = router.route(msg)

        assert result.fallthrough is True

    def test_wildcard_channel_matches_any_channel(self):
        from workflow_engine.router import WorkflowRouter

        workflow = _make_workflow(channel="any", category="kyc_verification")
        msg = _make_message(channel="email", category="kyc_verification")

        router = WorkflowRouter()
        with patch("workflow_engine.router.get_published_workflows", return_value=[workflow]), \
             patch("workflow_engine.router.get_active_execution", return_value=None):
            result = router.route(msg)

        assert result.matched_workflow is not None

    def test_wildcard_category_matches_any_category(self):
        from workflow_engine.router import WorkflowRouter

        workflow = _make_workflow(channel="widget", category="any")
        msg = _make_message(channel="widget", category="withdrawal_issue")

        router = WorkflowRouter()
        with patch("workflow_engine.router.get_published_workflows", return_value=[workflow]), \
             patch("workflow_engine.router.get_active_execution", return_value=None):
            result = router.route(msg)

        assert result.matched_workflow is not None

    def test_unpublished_workflow_not_matched(self):
        from workflow_engine.router import WorkflowRouter

        workflow = _make_workflow(published=False)
        msg = _make_message()

        router = WorkflowRouter()
        with patch("workflow_engine.router.get_published_workflows", return_value=[]), \
             patch("workflow_engine.router.get_active_execution", return_value=None):
            result = router.route(msg)

        assert result.fallthrough is True


# ── Active execution lookup ───────────────────────────────────────────────────

class TestRouterActiveExecution:

    def test_returns_active_execution_when_found(self):
        from workflow_engine.router import WorkflowRouter
        from workflow_engine.models import WorkflowExecution, ExecutionStatus

        execution = WorkflowExecution(
            id="exec-1",
            workflow_id="wf-1",
            conversation_id="conv-1",
            current_node_id="n2",
            variables={},
            status=ExecutionStatus.WAITING_MESSAGE,
            waiting_for=None,
            channel="widget",
            category="kyc_verification",
        )
        workflow = _make_workflow()
        msg = _make_message()

        router = WorkflowRouter()
        with patch("workflow_engine.router.get_active_execution", return_value=execution), \
             patch("workflow_engine.router.load_workflow_by_id", return_value=workflow):
            result = router.route(msg)

        assert result.active_execution is not None
        assert result.active_execution.id == "exec-1"
        assert result.matched_workflow is not None

    def test_active_execution_takes_priority_over_trigger_match(self):
        """If an execution is already running, don't start a new one."""
        from workflow_engine.router import WorkflowRouter
        from workflow_engine.models import WorkflowExecution, ExecutionStatus

        execution = WorkflowExecution(
            id="exec-running",
            workflow_id="wf-1",
            conversation_id="conv-1",
            current_node_id="n3",
            variables={},
            status=ExecutionStatus.WAITING_MESSAGE,
            waiting_for=None,
            channel="widget",
            category="kyc_verification",
        )
        different_workflow = _make_workflow(workflow_id="wf-new")
        msg = _make_message()

        router = WorkflowRouter()
        with patch("workflow_engine.router.get_active_execution", return_value=execution), \
             patch("workflow_engine.router.load_workflow_by_id", return_value=_make_workflow()), \
             patch("workflow_engine.router.get_published_workflows",
                   return_value=[different_workflow]):
            result = router.route(msg)

        # Must resume the running execution, not start the new workflow
        assert result.active_execution.id == "exec-running"


# ── No match fallthrough ──────────────────────────────────────────────────────

class TestRouterFallthrough:

    def test_fallthrough_when_no_workflows_exist(self):
        from workflow_engine.router import WorkflowRouter

        msg = _make_message()
        router = WorkflowRouter()
        with patch("workflow_engine.router.get_published_workflows", return_value=[]), \
             patch("workflow_engine.router.get_active_execution", return_value=None):
            result = router.route(msg)

        assert result.fallthrough is True
        assert result.matched_workflow is None

    def test_fallthrough_result_has_no_execution(self):
        from workflow_engine.router import WorkflowRouter

        msg = _make_message()
        router = WorkflowRouter()
        with patch("workflow_engine.router.get_published_workflows", return_value=[]), \
             patch("workflow_engine.router.get_active_execution", return_value=None):
            result = router.route(msg)

        assert result.active_execution is None


# ── Category upgrade routing (Option C) ──────────────────────────────────────

class TestRouterCategoryUpgrade:

    def test_upgrade_detected_during_active_execution_fires_event(self):
        """
        When a category upgrade is detected while a workflow is running,
        router should fire a category_upgraded event — not terminate the execution.
        """
        from workflow_engine.router import WorkflowRouter
        from workflow_engine.models import WorkflowExecution, ExecutionStatus

        execution = WorkflowExecution(
            id="exec-general",
            workflow_id="wf-general",
            conversation_id="conv-1",
            current_node_id="n2",
            variables={"category": "other"},
            status=ExecutionStatus.WAITING_MESSAGE,
            waiting_for=None,
            channel="widget",
            category="other",
        )
        general_workflow = _make_workflow(workflow_id="wf-general", category="other")
        kyc_workflow = _make_workflow(workflow_id="wf-kyc", category="kyc_verification")

        # Message contains KYC upgrade keyword
        from workflow_engine.channel_adapter import ChannelMessage
        msg = ChannelMessage(
            text="actually my KYC verification is stuck",
            channel="widget",
            category="other",
            language="en",
            user_id="user-1",
            conversation_id="conv-1",
            metadata={},
        )

        router = WorkflowRouter()
        with patch("workflow_engine.router.get_active_execution", return_value=execution), \
             patch("workflow_engine.router.load_workflow_by_id", return_value=general_workflow), \
             patch("workflow_engine.router.get_published_workflows",
                   return_value=[general_workflow, kyc_workflow]), \
             patch("workflow_engine.router.detect_upgrade",
                   return_value="kyc_verification") as mock_upgrade:
            result = router.route(msg)

        # Should carry the upgrade_to field
        assert result.category_upgrade == "kyc_verification"
        # Should NOT terminate — execution is still active
        assert result.active_execution is not None

    def test_no_upgrade_when_category_not_upgradeable(self):
        """Category upgrade only fires from 'other' — not from specific categories."""
        from workflow_engine.router import WorkflowRouter
        from workflow_engine.models import WorkflowExecution, ExecutionStatus

        execution = WorkflowExecution(
            id="exec-kyc",
            workflow_id="wf-kyc",
            conversation_id="conv-1",
            current_node_id="n1",
            variables={"category": "kyc_verification"},
            status=ExecutionStatus.WAITING_MESSAGE,
            waiting_for=None,
            channel="widget",
            category="kyc_verification",
        )

        msg = _make_message(category="kyc_verification")
        msg = msg.__class__(
            text="what about my withdrawal",
            channel="widget",
            category="kyc_verification",
            language="en",
            user_id="user-1",
            conversation_id="conv-1",
            metadata={},
        )

        router = WorkflowRouter()
        with patch("workflow_engine.router.get_active_execution", return_value=execution), \
             patch("workflow_engine.router.load_workflow_by_id",
                   return_value=_make_workflow(category="kyc_verification")), \
             patch("workflow_engine.router.detect_upgrade", return_value=None):
            result = router.route(msg)

        assert result.category_upgrade is None
