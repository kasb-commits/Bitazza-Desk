"""
Escalation engine — decides when to hand off to a human agent.

There are 5 escalation triggers in total:

  1. user_requested_human    — message matches a phrase in ESCALATION_HUMAN_PHRASES
                               (e.g. "talk to a human", "live agent", "ต่อสาย")
  2. sensitive_keyword       — message contains a word in ESCALATION_KEYWORDS
                               (e.g. "fraud", "hack", "police")
  3. low_confidence          — estimated confidence < ESCALATION_CONFIDENCE_THRESHOLD (default 0.6)
  4. repeated_unclear_exchanges — 3+ consecutive low-confidence turns in a row
  5. resolution rejection ×2 — frontend-driven; NOT handled here.
                               When the customer clicks "No, I need more help" twice on the
                               resolution confirmation card, ChatWindow.tsx synthesises the
                               message "I need to speak to a human agent" and calls send(),
                               which routes through this function and fires trigger #1.
                               See: frontend/widget/src/ChatWindow.tsx (resolutionRejections state)
"""
import re
from config.settings import ESCALATION_CONFIDENCE_THRESHOLD, ESCALATION_KEYWORDS, ESCALATION_HUMAN_PHRASES


def should_escalate(
    user_message: str,
    confidence: float,
    consecutive_low_confidence: int = 0,
) -> tuple[bool, str]:
    """
    Returns (escalate: bool, reason: str).
    Checks confidence score, keywords, and explicit human requests.

    NOTE: A 5th trigger (resolution rejection ×2) exists in the widget frontend —
    see module docstring above for details.
    """
    msg_lower = user_message.lower()

    # Explicit human request (also fires when the widget sends a synthetic message
    # after the customer rejects the resolution card twice)
    if any(phrase in msg_lower for phrase in ESCALATION_HUMAN_PHRASES):
        return True, "user_requested_human"

    # Security/sensitive keywords
    if any(kw in msg_lower for kw in ESCALATION_KEYWORDS):
        return True, "sensitive_keyword"

    # Low confidence
    if confidence < ESCALATION_CONFIDENCE_THRESHOLD:
        return True, "low_confidence"

    # Repeated low-confidence turns
    if consecutive_low_confidence >= 3:
        return True, "repeated_unclear_exchanges"

    return False, ""


_HEDGE_PHRASES = [
    "i'm not sure", "i don't know", "not certain", "i cannot", "i can't",
    "unclear", "unsure", "no information", "ไม่แน่ใจ", "ไม่ทราบ",
]


def estimate_confidence(response: str, rag_chunks: list) -> float:
    """
    Heuristic confidence score in [0, 1] for a generated response.

    Starts at a base score, boosts when RAG chunks back the answer,
    and penalises hedging language or very short replies.
    """
    score = 0.7

    # Boost when supporting chunks were retrieved
    if rag_chunks:
        score += 0.2

    # Penalise hedging language
    response_lower = response.lower()
    hedge_hits = sum(1 for p in _HEDGE_PHRASES if p in response_lower)
    if hedge_hits:
        score -= 0.2 * hedge_hits

    # Penalise very short replies (likely non-answers)
    if len(response.strip()) < 20:
        score -= 0.3

    return max(0.0, min(1.0, score))
