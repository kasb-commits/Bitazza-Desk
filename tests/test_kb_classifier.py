"""
Unit tests for engine/kb_classifier.py

Covers: valid classification, category filtering, chunk truncation,
model config usage, Gemini failure handling, and malformed JSON handling.
"""
import json
import os
import pytest

os.environ.setdefault("GEMINI_API_KEY", "test-key-not-real")
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/test")
os.environ.setdefault("JWT_SECRET", "test-secret")

from unittest.mock import patch, MagicMock

from engine.kb_classifier import classify_kb_item, ISSUE_CATEGORIES


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_mock_response(payload: dict) -> MagicMock:
    """Build a fake Gemini response whose .text is the JSON-serialised payload."""
    resp = MagicMock()
    resp.text = json.dumps(payload)
    return resp


def _make_client_mock(response: MagicMock) -> MagicMock:
    """Return a mock genai.Client whose models.generate_content returns response."""
    client = MagicMock()
    client.models.generate_content.return_value = response
    return client


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestClassifyReturnsValidShape:
    def test_classify_returns_valid_shape(self):
        """classify_kb_item with a valid LLM response returns the three expected keys."""
        payload = {
            "categories": ["KYC"],
            "keywords": ["identity", "verification"],
            "coverage_score": 0.9,
        }
        mock_response = _make_mock_response(payload)
        mock_client = _make_client_mock(mock_response)

        # classify_kb_item imports genai locally inside its try block, so patch
        # the google.genai module-level Client constructor and types.
        with patch("google.genai.Client", return_value=mock_client):
            with patch("google.genai.types") as mock_types:
                mock_types.GenerateContentConfig.return_value = MagicMock()
                mock_types.Content.return_value = MagicMock()
                mock_types.Part.return_value = MagicMock()
                result = classify_kb_item(1, "KYC Guide", ["chunk text"])

        assert "categories" in result
        assert "keywords" in result
        assert "coverage_score" in result
        assert result["categories"] == ["KYC"]
        assert result["keywords"] == ["identity", "verification"]
        assert abs(result["coverage_score"] - 0.9) < 1e-6


class TestClassifyFiltersUnknownCategories:
    def test_classify_filters_unknown_categories(self):
        """Categories not in ISSUE_CATEGORIES taxonomy must be stripped from result."""
        payload = {
            "categories": ["KYC", "InventedCategory", "MadeUpTopic"],
            "keywords": ["kyc"],
            "coverage_score": 0.7,
        }
        mock_response = _make_mock_response(payload)
        mock_client = _make_client_mock(mock_response)

        with patch("google.genai.Client", return_value=mock_client):
            with patch("google.genai.types") as mock_types:
                mock_types.GenerateContentConfig.return_value = MagicMock()
                mock_types.Content.return_value = MagicMock()
                mock_types.Part.return_value = MagicMock()
                result = classify_kb_item(2, "Mixed Doc", ["chunk"])

        assert result["categories"] == ["KYC"]
        assert "InventedCategory" not in result["categories"]
        assert "MadeUpTopic" not in result["categories"]


class TestClassifySendsAtMost3Chunks:
    def test_classify_sends_at_most_3_chunks(self):
        """When called with 10 chunks, the prompt sent to Gemini contains at most 3 chunks."""
        chunks = [f"chunk text number {i}" for i in range(10)]
        payload = {"categories": [], "keywords": [], "coverage_score": 0.5}
        mock_response = _make_mock_response(payload)
        mock_client = _make_client_mock(mock_response)

        captured_contents = []

        def capture_generate(*args, **kwargs):
            captured_contents.append(kwargs.get("contents") or (args[1] if len(args) > 1 else None))
            return mock_response

        mock_client.models.generate_content.side_effect = capture_generate

        with patch("google.genai.Client", return_value=mock_client):
            with patch("google.genai.types") as mock_types:
                mock_types.GenerateContentConfig.return_value = MagicMock()

                # Capture the Part text to inspect the prompt
                captured_prompts = []

                def capture_part(text):
                    captured_prompts.append(text)
                    return MagicMock()

                mock_types.Part.side_effect = capture_part
                mock_types.Content.return_value = MagicMock()
                classify_kb_item(3, "Test Doc", chunks)

        assert len(captured_prompts) >= 1
        prompt_text = captured_prompts[0]
        # Chunks 4–9 must not appear in the prompt
        for i in range(3, 10):
            assert f"chunk text number {i}" not in prompt_text
        # At least the first chunk must appear
        assert "chunk text number 0" in prompt_text


class TestClassifyUsesConfigModel:
    def test_classify_uses_config_model(self):
        """classify_kb_item must pass config.MODEL to generate_content, not a hardcoded string."""
        from config.settings import MODEL

        payload = {"categories": [], "keywords": [], "coverage_score": 0.0}
        mock_response = _make_mock_response(payload)
        mock_client = _make_client_mock(mock_response)

        with patch("google.genai.Client", return_value=mock_client):
            with patch("google.genai.types") as mock_types:
                mock_types.GenerateContentConfig.return_value = MagicMock()
                mock_types.Content.return_value = MagicMock()
                mock_types.Part.return_value = MagicMock()
                classify_kb_item(4, "Doc", ["chunk"])

        call_kwargs = mock_client.models.generate_content.call_args
        # model is passed as the first positional arg or as kwarg 'model'
        called_model = (
            call_kwargs.kwargs.get("model")
            or (call_kwargs.args[0] if call_kwargs.args else None)
        )
        assert called_model == MODEL, (
            f"Expected model={MODEL!r} from config, got {called_model!r}"
        )


class TestClassifyHandlesGeminiFailure:
    def test_classify_handles_gemini_failure(self):
        """When generate_content raises, classify_kb_item returns the empty result without raising."""
        mock_client = MagicMock()
        mock_client.models.generate_content.side_effect = RuntimeError("API quota exceeded")

        with patch("google.genai.Client", return_value=mock_client):
            with patch("google.genai.types") as mock_types:
                mock_types.GenerateContentConfig.return_value = MagicMock()
                mock_types.Content.return_value = MagicMock()
                mock_types.Part.return_value = MagicMock()
                result = classify_kb_item(5, "Doc", ["chunk"])

        assert result == {"categories": [], "keywords": [], "coverage_score": None}


class TestClassifyHandlesMalformedJsonResponse:
    def test_classify_handles_malformed_json_response(self):
        """When the LLM returns non-JSON text, the function returns the empty result."""
        mock_response = MagicMock()
        mock_response.text = "NOT JSON — sorry, I can't help with that."
        mock_client = _make_client_mock(mock_response)

        with patch("google.genai.Client", return_value=mock_client):
            with patch("google.genai.types") as mock_types:
                mock_types.GenerateContentConfig.return_value = MagicMock()
                mock_types.Content.return_value = MagicMock()
                mock_types.Part.return_value = MagicMock()
                result = classify_kb_item(6, "Doc", ["chunk"])

        assert result == {"categories": [], "keywords": [], "coverage_score": None}
