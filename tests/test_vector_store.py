"""Tests for vector store abstraction (pgvector backend)."""
import pytest
from unittest.mock import MagicMock, patch, call
from contextlib import contextmanager


def _make_conn_mock(fetchall=None, fetchone=None, rowcount=0):
    """Build a mock _conn() context manager that returns a mock cursor."""
    mock_cursor = MagicMock()
    mock_cursor.fetchall.return_value = fetchall or []
    mock_cursor.fetchone.return_value = fetchone
    mock_cursor.rowcount = rowcount

    mock_conn = MagicMock()
    mock_conn.cursor.return_value = mock_cursor

    @contextmanager
    def _fake_conn():
        yield mock_conn

    return _fake_conn, mock_cursor


@pytest.fixture(autouse=True)
def reset_gemini(monkeypatch):
    """Prevent real Gemini API calls — use word-hash embeddings in all tests."""
    import db.vector_store as vs
    monkeypatch.setattr(vs, "_gemini_embed_batch", lambda texts: None)
    monkeypatch.setattr(vs, "_gemini_client", None)


def test_upsert_and_query():
    import db.vector_store as vs
    fake_conn, cursor = _make_conn_mock()
    with patch.object(vs, "_conn", fake_conn):
        vs.upsert_documents([
            {"id": "doc1", "text": "KYC verification requires passport and selfie", "metadata": {"source": "docs"}},
            {"id": "doc2", "text": "Withdrawal processing takes 1-3 business days", "metadata": {"source": "docs"}},
            {"id": "doc3", "text": "How to reset your password and 2FA", "metadata": {"source": "docs"}},
        ])
    # One cursor.execute per document
    assert cursor.execute.call_count == 3


def test_query_returns_results():
    import db.vector_store as vs
    fake_rows = [
        {"content": "KYC verification requires government ID", "metadata": {"source": "test"}, "doc_type": None, "distance": 0.25},
        {"content": "Deposit money via bank transfer", "metadata": {"source": "test"}, "doc_type": None, "distance": 0.45},
    ]
    fake_conn, _ = _make_conn_mock(fetchall=fake_rows)
    with patch.object(vs, "_conn", fake_conn):
        results = vs.query("KYC documents required", n_results=2)
    assert len(results) == 2
    assert all("text" in r for r in results)
    assert results[0]["distance"] == pytest.approx(0.25)


def test_upsert_deduplicates():
    """Upsert of same external_id should produce one execute, not two (ON CONFLICT DO UPDATE)."""
    import db.vector_store as vs
    fake_conn, cursor = _make_conn_mock()
    with patch.object(vs, "_conn", fake_conn):
        vs.upsert_documents([{"id": "dup1", "text": "Original text", "metadata": {}}])
    first_call_count = cursor.execute.call_count

    cursor.reset_mock()
    with patch.object(vs, "_conn", fake_conn):
        vs.upsert_documents([{"id": "dup1", "text": "Updated text", "metadata": {}}])
    # Both calls use ON CONFLICT DO UPDATE — each triggers exactly one execute
    assert cursor.execute.call_count == 1


def test_collection_count_zero_on_empty():
    import db.vector_store as vs
    fake_conn, cursor = _make_conn_mock(fetchone={"n": 0})
    with patch.object(vs, "_conn", fake_conn):
        count = vs.collection_count()
    assert count == 0


def test_collection_count_returns_value():
    import db.vector_store as vs
    fake_conn, cursor = _make_conn_mock(fetchone={"n": 42})
    with patch.object(vs, "_conn", fake_conn):
        count = vs.collection_count()
    assert count == 42


def test_delete_by_metadata():
    import db.vector_store as vs
    fake_conn, cursor = _make_conn_mock(rowcount=3)
    with patch.object(vs, "_conn", fake_conn):
        deleted = vs.delete_by_metadata("knowledge_item_id", "7")
    assert deleted == 3


def test_get_chunks_by_item():
    import db.vector_store as vs
    fake_rows = [
        {"content": "chunk zero", "metadata": {"chunk_index": 0, "knowledge_item_id": "5"}},
        {"content": "chunk one",  "metadata": {"chunk_index": 1, "knowledge_item_id": "5"}},
    ]
    fake_conn, _ = _make_conn_mock(fetchall=fake_rows)
    with patch.object(vs, "_conn", fake_conn):
        chunks = vs.get_chunks_by_item(5)
    assert len(chunks) == 2
    assert chunks[0]["index"] == 0
    assert chunks[1]["text"] == "chunk one"
