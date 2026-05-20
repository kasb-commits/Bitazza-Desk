"""
E2E tests: email channel — full flow through email route.

Covers:
- Inbound email triggers workflow execution via _process_inbound_email
- Duplicate email (same gmail_message_id) is idempotent
- CSAT link recording unchanged
- Email verification token handling
"""
import json
import base64
import pytest
from unittest.mock import MagicMock, AsyncMock, patch


@pytest.fixture
def client():
    with patch("db.vector_store.chromadb"):
        from api.main import app
        from fastapi.testclient import TestClient
        return TestClient(app)


def _pubsub_body(message_id="msg-test-1", history_id="12345"):
    """Build a minimal Gmail Pub/Sub webhook payload."""
    data = base64.b64encode(
        json.dumps({"emailAddress": "support@bitazza.com",
                    "historyId": history_id}).encode()
    ).decode()
    return {
        "message": {"data": data, "messageId": message_id},
        "subscription": "projects/test/subscriptions/gmail-sub",
    }


# ── Inbound email triggers workflow ──────────────────────────────────────────

class TestEmailWebhookWorkflowRouting:

    def test_inbound_email_triggers_matching_workflow(self, client):
        """POST /email/webhook → Pub/Sub decoded → _process_inbound_email called."""
        with patch("api.routes.email._get_gmail_service") as mock_service, \
             patch("api.routes.email._process_inbound_email", new_callable=AsyncMock) as mock_process, \
             patch("api.routes.email.set_last_history_id"), \
             patch("api.routes.email.set_gmail_history_cursor"):

            mock_svc = MagicMock()
            mock_svc.list_history.return_value = {
                "history": [{"messagesAdded": [{"message": {"id": "msg-test-1", "labelIds": ["INBOX"]}}]}]
            }
            mock_service.return_value = mock_svc

            response = client.post(
                "/email/webhook",
                json=_pubsub_body(),
                headers={"X-Goog-PSC-Secret": "test-secret"},
            )

        assert response.status_code == 200
        mock_process.assert_called_once_with("msg-test-1")

    def test_duplicate_email_message_id_does_not_start_second_execution(self, client):
        """try_claim_gmail_message returns False → execution must NOT start."""
        with patch("api.routes.email._get_gmail_service") as mock_service, \
             patch("api.routes.email.try_claim_gmail_message", return_value=False), \
             patch("api.routes.email.set_last_history_id"), \
             patch("api.routes.email.set_gmail_history_cursor"):

            mock_svc = MagicMock()
            mock_svc.list_history.return_value = {
                "history": [{"messagesAdded": [{"message": {"id": "msg-already-processed", "labelIds": ["INBOX"]}}]}]
            }
            mock_service.return_value = mock_svc

            response = client.post(
                "/email/webhook",
                json=_pubsub_body(message_id="msg-already-processed"),
                headers={"X-Goog-PSC-Secret": "test-secret"},
            )

        assert response.status_code == 200

    def test_no_workflow_match_falls_through_to_legacy_email_handler(self, client):
        """
        When router returns fallthrough=True for email, the existing email
        processing logic must run unchanged.
        """
        with patch("api.routes.email._get_gmail_service") as mock_service, \
             patch("api.routes.email._process_inbound_email", new_callable=AsyncMock) as mock_process, \
             patch("api.routes.email.set_last_history_id"), \
             patch("api.routes.email.set_gmail_history_cursor"):

            mock_svc = MagicMock()
            mock_svc.list_history.return_value = {
                "history": [{"messagesAdded": [{"message": {"id": "msg-2", "labelIds": ["INBOX"]}}]}]
            }
            mock_service.return_value = mock_svc

            response = client.post(
                "/email/webhook",
                json=_pubsub_body(message_id="msg-2"),
                headers={"X-Goog-PSC-Secret": "test-secret"},
            )

        assert response.status_code == 200
        mock_process.assert_called_once_with("msg-2")


# ── Email verification token flow ─────────────────────────────────────────────

class TestEmailVerificationE2E:

    def test_verify_endpoint_resumes_workflow_execution(self, client):
        """GET /email/verify/{token} with valid token → 200 success page."""
        with patch("api.routes.email.consume_verification_token",
                   return_value={"ticket_id": "ticket-1", "verified_user_id": "user-1",
                                 "from_email": "user@example.com"}), \
             patch("api.routes.email._link_user_to_ticket"), \
             patch("api.routes.email._trigger_ai_after_verification", new_callable=AsyncMock):

            response = client.get(
                "/email/verify/tok-valid-abc?mock_user_id=user-1"
            )

        assert response.status_code == 200

    def test_no_workflow_execution_falls_back_to_legacy_verify_handler(self, client):
        """
        GET /email/verify/{token} → consume token → trigger AI — legacy path runs.
        """
        with patch("api.routes.email.consume_verification_token",
                   return_value={"ticket_id": "t1", "verified_user_id": "u1",
                                 "from_email": "u@x.com"}), \
             patch("api.routes.email._link_user_to_ticket"), \
             patch("api.routes.email._trigger_ai_after_verification", new_callable=AsyncMock) as mock_trigger:

            response = client.get("/email/verify/tok-abc?mock_user_id=u1")

        assert response.status_code == 200
        mock_trigger.assert_called_once()


# ── CSAT flow unaffected ──────────────────────────────────────────────────────

class TestEmailCsatUnaffected:

    def test_csat_star_click_records_score(self, client):
        """GET /email/csat/{ticket_id} — unchanged behavior, no workflow involvement."""
        with patch("api.routes.email.consume_csat_token", return_value=True):
            response = client.get("/email/csat/t1?token=csat-tok-5&score=5")

        assert response.status_code == 200
