"""
KB Citation Classifier

Generates issue categories, retrieval keywords, and a coverage score for a
knowledge base item by sending a single LLM call with the item's first 3 chunks.

Design constraints:
- Synchronous — matches all existing Gemini + psycopg2 patterns in this codebase.
- Never raises — returns an empty result on any failure so callers are never blocked.
- Uses config.MODEL — never hardcodes a model string.
- Categories are constrained to ISSUE_CATEGORIES taxonomy to prevent hallucination drift.
"""
import json
import logging
import re

import httpx as _httpx
from google import genai as _genai
from google.genai import types as _genai_types

from config.settings import GEMINI_API_KEY, MODEL

logger = logging.getLogger(__name__)

# Build once at module level — same pattern as engine/agent.py.
# Includes both sync and async clients so trust_env proxy settings apply
# identically to the main agent client.
_http_options = _genai_types.HttpOptions(
    httpxClient=_httpx.Client(trust_env=True),
    httpxAsyncClient=_httpx.AsyncClient(trust_env=True),
)
_client = _genai.Client(api_key=GEMINI_API_KEY, http_options=_http_options)

ISSUE_CATEGORIES = [
    "Exchange Fees",
    "Account Verification",
    "Deposits",
    "Withdrawals",
    "Refunds",
    "Transaction Delays",
    "Security",
    "KYC",
    "API Usage",
    "Password Reset",
    "Account Restriction",
    "Fraud",
]

_EMPTY_RESULT: dict = {"categories": [], "keywords": [], "coverage_score": None}

_MAX_CHUNKS = 3
_MAX_CHARS_PER_CHUNK = 800


def classify_kb_item(item_id: int, title: str, chunks: list[str]) -> dict:
    """
    Classify a KB item and return citation metadata.

    Returns:
        {
            "categories": list[str],   subset of ISSUE_CATEGORIES
            "keywords":   list[str],   retrieval keywords (3-10 terms)
            "coverage_score": float|None   0.0–1.0 confidence
        }

    Never raises. On any failure logs the error and returns _EMPTY_RESULT.
    """
    if not chunks:
        return _EMPTY_RESULT

    # Use at most 3 chunks, truncated, to stay within a reasonable token budget
    sample_chunks = chunks[:_MAX_CHUNKS]
    context = "\n\n".join(c[:_MAX_CHARS_PER_CHUNK] for c in sample_chunks)

    taxonomy_str = "\n".join(f"- {c}" for c in ISSUE_CATEGORIES)

    prompt = f"""You are classifying a customer support knowledge base document for a cryptocurrency exchange platform.

Document title: {title}

Document content (excerpt):
{context}

Your task:
1. Identify which of the following issue categories this document covers. Choose only from this exact list — do not invent new categories:
{taxonomy_str}

2. Extract 3–10 short retrieval keywords (single words or 2-word phrases) that a customer support agent would use to search for this document.

3. Rate how strongly this document maps to the identified categories on a scale of 0.0 to 1.0 (1.0 = completely dedicated to those topics, 0.5 = partial coverage, 0.2 = tangential mention).

Respond with ONLY valid JSON in this exact format — no explanation, no markdown fences:
{{"categories": ["Category Name", ...], "keywords": ["word1", "phrase2", ...], "coverage_score": 0.0}}"""

    try:
        # Disable thinking for the classifier — this is a simple extraction task
        # that doesn't benefit from chain-of-thought, and thinking tokens eat the
        # output budget causing MAX_TOKENS truncation on gemini-2.5-flash.
        cfg = _genai_types.GenerateContentConfig(
            temperature=0.1,
            max_output_tokens=1024,
            thinking_config=_genai_types.ThinkingConfig(thinking_budget=0),
        )
        response = _client.models.generate_content(
            model=MODEL,
            contents=[_genai_types.Content(role="user", parts=[_genai_types.Part(text=prompt)])],
            config=cfg,
        )
        raw = response.text or ""
    except Exception as exc:
        logger.warning("kb_classifier: Gemini call failed for item %d — %s", item_id, exc)
        return _EMPTY_RESULT

    return _parse_response(item_id, raw)


def _parse_response(item_id: int, raw: str) -> dict:
    """Parse and validate the LLM JSON response. Returns _EMPTY_RESULT on any parse failure."""
    # Strip markdown fences if the model added them despite instructions
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        logger.warning("kb_classifier: item %d — could not parse JSON from: %.200s", item_id, raw)
        return _EMPTY_RESULT

    # Validate categories — only keep known taxonomy entries
    raw_cats = data.get("categories", [])
    if not isinstance(raw_cats, list):
        raw_cats = []
    categories = [c for c in raw_cats if isinstance(c, str) and c in ISSUE_CATEGORIES]

    # Keywords — any non-empty strings, max 20
    raw_kw = data.get("keywords", [])
    if not isinstance(raw_kw, list):
        raw_kw = []
    keywords = [k.strip() for k in raw_kw if isinstance(k, str) and k.strip()][:20]

    # Coverage score — clamp to [0, 1]
    score_raw = data.get("coverage_score")
    try:
        score = float(score_raw)
        score = max(0.0, min(1.0, score))
    except (TypeError, ValueError):
        score = None

    return {"categories": categories, "keywords": keywords, "coverage_score": score}
