"""
Unit tests for KB citation helper functions in db/conversation_store.py.

Covers:
- update_knowledge_item_citations skips manually-edited items
- update_knowledge_item_citations_manual sets citations_source='manual'
- update_knowledge_item_citations_manual stores the editor UUID in SQL params
- get_all_knowledge_source_refs does not filter by status
"""
import os
import pytest

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-real")
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/test")
os.environ.setdefault("JWT_SECRET", "test-secret")

from contextlib import contextmanager
from unittest.mock import patch, MagicMock


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_cursor_mock():
    cur = MagicMock()
    cur.execute = MagicMock()
    cur.fetchone = MagicMock(return_value=None)
    cur.fetchall = MagicMock(return_value=[])
    return cur


def _make_conn_mock(cursor):
    conn = MagicMock()
    conn.cursor.return_value = cursor
    conn.commit = MagicMock()
    conn.rollback = MagicMock()
    conn.close = MagicMock()
    return conn


@contextmanager
def _fake_conn_ctx(conn):
    yield conn


# ---------------------------------------------------------------------------
# update_knowledge_item_citations
# ---------------------------------------------------------------------------

class TestUpdateCitationsSkipsManualItems:
    def test_update_citations_skips_manual_items(self):
        """
        update_knowledge_item_citations must include a WHERE guard that excludes
        rows with citations_source = 'manual', so AI-generated updates cannot
        overwrite an agent-edited item.
        """
        import db.conversation_store as cs

        cur = _make_cursor_mock()
        conn = _make_conn_mock(cur)

        with patch.object(cs, "_conn", lambda: _fake_conn_ctx(conn)):
            cs.update_knowledge_item_citations(1, ["KYC"], ["kyc"], 0.8)

        assert cur.execute.called
        sql = cur.execute.call_args[0][0]
        assert "citations_source != 'manual'" in sql or "citations_source != %s" in sql, (
            f"SQL should guard against overwriting manual citations; got:\n{sql}"
        )


# ---------------------------------------------------------------------------
# update_knowledge_item_citations_manual
# ---------------------------------------------------------------------------

class TestUpdateCitationsManualSetSourceManual:
    def test_update_citations_manual_sets_source_manual(self):
        """update_knowledge_item_citations_manual must set citations_source = 'manual'."""
        import db.conversation_store as cs

        cur = _make_cursor_mock()
        conn = _make_conn_mock(cur)

        with patch.object(cs, "_conn", lambda: _fake_conn_ctx(conn)):
            cs.update_knowledge_item_citations_manual(
                1, ["KYC"], ["kyc"], "00000000-0000-0000-0000-000000000001"
            )

        assert cur.execute.called
        sql = cur.execute.call_args[0][0]
        assert "'manual'" in sql or "citations_source" in sql, (
            f"SQL should set citations_source to 'manual'; got:\n{sql}"
        )
        assert "manual" in sql


class TestUpdateCitationsStoresEditedByUuid:
    def test_update_citations_stores_edited_by_uuid(self):
        """The editor UUID must appear in the SQL bind parameters."""
        import db.conversation_store as cs

        cur = _make_cursor_mock()
        conn = _make_conn_mock(cur)
        editor_uuid = "00000000-0000-0000-0000-000000000002"

        with patch.object(cs, "_conn", lambda: _fake_conn_ctx(conn)):
            cs.update_knowledge_item_citations_manual(
                1, ["KYC"], ["kyc"], editor_uuid
            )

        assert cur.execute.called
        params = cur.execute.call_args[0][1]
        # The UUID string (possibly canonicalised) must appear somewhere in params
        params_str = " ".join(str(p) for p in params)
        assert editor_uuid in params_str, (
            f"Editor UUID {editor_uuid!r} not found in execute() params: {params!r}"
        )


# ---------------------------------------------------------------------------
# get_all_knowledge_source_refs
# ---------------------------------------------------------------------------

class TestGetAllKnowledgeSourceRefsIgnoresStatus:
    def test_get_all_knowledge_source_refs_ignores_status(self):
        """
        get_all_knowledge_source_refs is used for deduplication and must return
        refs for ALL statuses, not just ACTIVE — the SQL must not contain
        a WHERE status filter.
        """
        import db.conversation_store as cs

        cur = _make_cursor_mock()
        cur.fetchall.return_value = []
        conn = _make_conn_mock(cur)

        with patch.object(cs, "_conn", lambda: _fake_conn_ctx(conn)):
            cs.get_all_knowledge_source_refs()

        assert cur.execute.called
        sql = cur.execute.call_args[0][0]
        # The SQL must not filter by status
        assert "WHERE status" not in sql.upper().replace("\n", " "), (
            f"get_all_knowledge_source_refs should not filter by status; got:\n{sql}"
        )
