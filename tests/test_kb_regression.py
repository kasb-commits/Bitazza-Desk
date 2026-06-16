"""
Regression tests for db.vector_store._translate_where.

These tests exercise the SQL translation layer directly — no DB connection needed.
They guard against regressions in filter behaviour that could silently allow
ARCHIVED chunks to leak into RAG responses or break retrieval of valid chunks.
"""
import os
import pytest

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-real")
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/test")
os.environ.setdefault("JWT_SECRET", "test-secret")

from db.vector_store import _translate_where


# ---------------------------------------------------------------------------
# $ne operator — null-safety regression
# ---------------------------------------------------------------------------

class TestRetrievalNullStatusChunksPassFilter:
    def test_retrieval_null_status_chunks_pass_filter(self):
        """
        $ne filter for status must include an IS NULL branch so that chunks
        ingested before the status column was added (i.e. metadata has no
        'status' key) are still returned by retrieval — they are not ARCHIVED.
        """
        sql, params = _translate_where({"status": {"$ne": "ARCHIVED"}})

        assert "IS NULL" in sql, (
            "SQL must include IS NULL branch to allow chunks without a status key"
        )


class TestRetrievalActiveStatusPasses:
    def test_retrieval_active_status_passes(self):
        """
        The $ne ARCHIVED filter must exclude ARCHIVED chunks but not ACTIVE ones.
        Concretely: params should bind 'ARCHIVED', not 'ACTIVE'.
        """
        sql, params = _translate_where({"status": {"$ne": "ARCHIVED"}})

        assert "ARCHIVED" in params, "ARCHIVED must be the bound exclusion value"
        assert "ACTIVE" not in params, (
            "ACTIVE must NOT appear in params — ACTIVE chunks should pass the filter"
        )


# ---------------------------------------------------------------------------
# doc_type exclusion
# ---------------------------------------------------------------------------

class TestRetrievalTicketChunksExcluded:
    def test_retrieval_ticket_chunks_excluded(self):
        """$ne filter on doc_type must reference the doc_type column."""
        sql, params = _translate_where({"doc_type": {"$ne": "ticket"}})

        assert "doc_type" in sql, "SQL must reference the doc_type column"
        assert "ticket" in params, "The excluded value 'ticket' must be in params"


# ---------------------------------------------------------------------------
# $eq operator
# ---------------------------------------------------------------------------

class TestTranslateWhereEqOperator:
    def test_translate_where_eq_operator(self):
        """$eq condition must generate an = %s fragment with the value in params."""
        sql, params = _translate_where({"doc_type": {"$eq": "kb"}})

        assert "= %s" in sql, f"Expected '= %s' in SQL; got: {sql!r}"
        assert params == ["kb"], f"Expected params=['kb']; got: {params!r}"


# ---------------------------------------------------------------------------
# $in operator
# ---------------------------------------------------------------------------

class TestTranslateWhereInOperator:
    def test_translate_where_in_operator(self):
        """$in condition must generate an IN (%s,%s) fragment with all values in params."""
        sql, params = _translate_where({"status": {"$in": ["ACTIVE", "PROCESSING"]}})

        assert "IN (%s,%s)" in sql, (
            f"Expected 'IN (%s,%s)' in SQL; got: {sql!r}"
        )
        assert params == ["ACTIVE", "PROCESSING"], (
            f"Expected params=['ACTIVE', 'PROCESSING']; got: {params!r}"
        )


# ---------------------------------------------------------------------------
# Empty dict
# ---------------------------------------------------------------------------

class TestTranslateWhereEmptyDict:
    def test_translate_where_empty_dict(self):
        """An empty where dict must return ('TRUE', []) — matches all rows."""
        sql, params = _translate_where({})

        assert sql == "TRUE", f"Expected 'TRUE'; got: {sql!r}"
        assert params == [], f"Expected empty params list; got: {params!r}"
