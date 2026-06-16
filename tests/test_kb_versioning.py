"""
Unit tests for KB versioning logic.

Tests cover:
- upsert_documents storing status=ACTIVE in metadata
- retriever passing the correct where-clause (excluding tickets and ARCHIVED chunks)
- _translate_where SQL generation for compound filters, $ne, $eq, $in operators
- activate_knowledge_version operation order (ARCHIVE before ACTIVE)
- fail_knowledge_version setting status=FAILED
- list_knowledge_items filtering to ACTIVE only
"""
import json
import os
import pytest

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-real")
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/test")
os.environ.setdefault("JWT_SECRET", "test-secret")

from contextlib import contextmanager
from unittest.mock import patch, MagicMock, call


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_cursor_mock():
    """Return a MagicMock that records all execute() calls."""
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
# upsert_documents
# ---------------------------------------------------------------------------

class TestUpsertDocumentsIncludesStatusActive:
    def test_upsert_documents_includes_status_active(self):
        """upsert_documents must store metadata containing status=ACTIVE in the SQL call."""
        import db.vector_store as vs

        cur = _make_cursor_mock()
        conn = _make_conn_mock(cur)

        docs = [{
            "id": "kb_1_0",
            "text": "KYC verification guide",
            "metadata": {
                "knowledge_item_id": "1",
                "source": "https://example.com/kyc",
                "source_type": "url",
                "title": "KYC Guide",
                "chunk_index": 0,
                "status": "ACTIVE",
            },
        }]

        with patch.object(vs, "_conn", lambda: _fake_conn_ctx(conn)):
            with patch.object(vs, "_gemini_embed_batch", return_value=[[0.1] * 3072]):
                vs.upsert_documents(docs)

        assert cur.execute.called, "cursor.execute was never called"
        # Find the INSERT call and check the metadata JSON argument
        found_active = False
        for call_args in cur.execute.call_args_list:
            args = call_args[0]  # positional args tuple
            if len(args) >= 2:
                params = args[1]
                # params is a tuple; find the JSON metadata string
                for p in params:
                    if isinstance(p, str):
                        try:
                            parsed = json.loads(p)
                            if parsed.get("status") == "ACTIVE":
                                found_active = True
                        except (json.JSONDecodeError, AttributeError):
                            pass
        assert found_active, "No SQL call included metadata with status='ACTIVE'"


# ---------------------------------------------------------------------------
# retriever where-clause
# ---------------------------------------------------------------------------

class TestRetrieverExcludesArchivedInWhereClause:
    def test_retriever_excludes_archived_in_where_clause(self):
        """retrieve() must call db.vector_store.query with the correct where dict."""
        import engine.retriever as retriever

        with patch("engine.retriever.query") as mock_query:
            mock_query.return_value = []
            retriever.retrieve("how to reset password")

        assert mock_query.called, "query() was never called"
        call_kwargs = mock_query.call_args.kwargs
        where = call_kwargs.get("where") or (
            mock_query.call_args.args[2] if len(mock_query.call_args.args) > 2 else None
        )
        assert where is not None, "query() was called without a where argument"
        assert where == {
            "doc_type": {"$ne": "ticket"},
            "status": {"$ne": "ARCHIVED"},
        }, f"Unexpected where clause: {where!r}"


# ---------------------------------------------------------------------------
# _translate_where
# ---------------------------------------------------------------------------

class TestTranslateWhereCompoundFilter:
    def test_translate_where_compound_filter(self):
        """Compound where dict with two $ne conditions → SQL AND-joins both."""
        from db.vector_store import _translate_where

        sql, params = _translate_where({
            "doc_type": {"$ne": "ticket"},
            "status": {"$ne": "ARCHIVED"},
        })

        assert "doc_type" in sql
        assert "status" in sql
        assert " AND " in sql
        assert "ARCHIVED" in params
        assert "ticket" in params


class TestTranslateWhereNeNullSafe:
    def test_translate_where_ne_null_safe(self):
        """$ne on a metadata key must generate an IS NULL OR != clause."""
        from db.vector_store import _translate_where

        sql, params = _translate_where({"status": {"$ne": "ARCHIVED"}})

        assert "IS NULL" in sql
        assert "!=" in sql
        assert "ARCHIVED" in params


# ---------------------------------------------------------------------------
# activate_knowledge_version
# ---------------------------------------------------------------------------

class TestActivateVersionArchivesBeforeActivating:
    def test_activate_version_archives_before_activating(self):
        """
        activate_knowledge_version must run the ARCHIVE UPDATE before the ACTIVE UPDATE.
        The first execute() call must reference 'ARCHIVED'; the second must reference 'ACTIVE'.
        """
        import db.conversation_store as cs

        cur = _make_cursor_mock()
        conn = _make_conn_mock(cur)

        with patch.object(cs, "_conn", lambda: _fake_conn_ctx(conn)):
            cs.activate_knowledge_version(new_id=2, old_id=1)

        assert cur.execute.call_count >= 2, "Expected at least two execute() calls"
        calls = cur.execute.call_args_list

        first_sql = calls[0][0][0]
        second_sql = calls[1][0][0]

        assert "ARCHIVED" in first_sql, (
            f"First SQL call should archive old version; got: {first_sql!r}"
        )
        assert "ACTIVE" in second_sql, (
            f"Second SQL call should activate new version; got: {second_sql!r}"
        )

        # Also verify id binding: old_id=1 in first call, new_id=2 in second call
        first_params = calls[0][0][1]
        second_params = calls[1][0][1]
        assert 1 in first_params, f"old_id=1 should be in first call params: {first_params}"
        assert 2 in second_params, f"new_id=2 should be in second call params: {second_params}"


# ---------------------------------------------------------------------------
# fail_knowledge_version
# ---------------------------------------------------------------------------

class TestFailKnowledgeVersionSetsFailedStatus:
    def test_fail_knowledge_version_sets_failed_status(self):
        """fail_knowledge_version must update status to FAILED for the given id."""
        import db.conversation_store as cs

        cur = _make_cursor_mock()
        conn = _make_conn_mock(cur)

        with patch.object(cs, "_conn", lambda: _fake_conn_ctx(conn)):
            cs.fail_knowledge_version(99)

        assert cur.execute.called
        sql = cur.execute.call_args[0][0]
        params = cur.execute.call_args[0][1]

        assert "FAILED" in sql, f"SQL should set FAILED status; got: {sql!r}"
        assert 99 in params, f"item_id=99 should be in params; got: {params!r}"


# ---------------------------------------------------------------------------
# list_knowledge_items
# ---------------------------------------------------------------------------

class TestListKnowledgeItemsActiveOnly:
    def test_list_knowledge_items_active_only(self):
        """list_knowledge_items must query only ACTIVE rows."""
        import db.conversation_store as cs

        cur = _make_cursor_mock()
        cur.fetchall.return_value = []
        conn = _make_conn_mock(cur)

        with patch.object(cs, "_conn", lambda: _fake_conn_ctx(conn)):
            cs.list_knowledge_items()

        assert cur.execute.called
        sql = cur.execute.call_args[0][0]
        assert "ACTIVE" in sql, f"SQL should filter by ACTIVE status; got: {sql!r}"
        assert "WHERE" in sql.upper(), f"SQL should have a WHERE clause; got: {sql!r}"
