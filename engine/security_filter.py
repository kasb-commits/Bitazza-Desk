"""
Security and compliance filters.
- pre_filter: runs BEFORE sending to Claude (blocks malicious inputs)
- post_filter: runs AFTER Claude response (strips policy violations)
"""
import re

# ── Patterns ──────────────────────────────────────────────────────────────────

_INJECTION_PATTERNS = [
    r"ignore (previous|above|all) instructions",
    r"you are now",
    r"act as (a|an|the)\s+\w+",
    r"pretend (you are|to be)",
    r"disregard (your|all) (instructions|rules|guidelines)",
    r"reveal (your|the) (system prompt|instructions|prompt)",
    r"what (is|are) your (instructions|system prompt)",
    r"jailbreak",
    r"DAN mode",
    r"developer mode",
    r"bypass (safety|filter|restriction)",
]

_SOCIAL_ENGINEERING_PATTERNS = [
    r"my (friend|colleague|boss|manager) at (bitazza|freedom)",
    r"i (work|am employed) (at|for) (bitazza|freedom)",
    r"this is an? (internal|admin|staff|employee) (test|check|request)",
    r"give me (admin|root|full|all) access",
    r"reset (all|every) (password|account)",
    r"transfer (all|the) funds",
]

_FINANCIAL_ADVICE_PATTERNS = [
    r"\b(should i|would you recommend|is it (a )?good (idea|time) to) (buy|sell|invest|hold|trade)\b",
    r"\bwill (the )?(price|btc|eth|bitcoin|ethereum|crypto) (go|rise|fall|drop|increase|decrease)\b",
    r"\bwill (btc|eth|bitcoin|ethereum|crypto) price\b",
    r"\bprice prediction\b",
    r"\bbest (coin|token|crypto|investment)\b",
]

# Applied to bot OUTPUT — scrub sensitive data that account tools might return
_PII_PATTERNS_OUTPUT = [
    (r"\b\d{13}\b", "[PHONE_OR_ID]"),                        # Thai national ID / phone
    (r"\b[A-Z]{2}\d{7}\b", "[PASSPORT]"),                   # Passport
    (r"\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b", "[CARD_NUMBER]"),  # Card number
]

# Applied to user INPUT only — emails are intentionally excluded from bot output scrubbing
# so the bot can safely mention addresses like support@bitazza.com
_PII_PATTERNS_INPUT = _PII_PATTERNS_OUTPUT + [
    (r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b", "[EMAIL]"),  # Email
]


def _matches_any(text: str, patterns: list[str]) -> bool:
    text_lower = text.lower()
    return any(re.search(p, text_lower) for p in patterns)


# ── Public API ────────────────────────────────────────────────────────────────

class FilterResult:
    def __init__(self, allowed: bool, reason: str = ""):
        self.allowed = allowed
        self.reason = reason


def pre_filter(user_message: str) -> FilterResult:
    """Block prompt injection and social engineering before calling Claude.
    Also scrubs PII (including email addresses) from the user message."""
    if _matches_any(user_message, _INJECTION_PATTERNS):
        return FilterResult(False, "prompt_injection")
    if _matches_any(user_message, _SOCIAL_ENGINEERING_PATTERNS):
        return FilterResult(False, "social_engineering")
    return FilterResult(True)


def scrub_user_input(user_message: str) -> str:
    """Redact PII from user input before it reaches the AI."""
    text = user_message
    for pattern, replacement in _PII_PATTERNS_INPUT:
        text = re.sub(pattern, replacement, text)
    return text


def post_filter(response_text: str) -> str:
    """Scrub sensitive account data from bot responses.
    Email addresses are NOT scrubbed here — the bot must be able to mention
    addresses like support@bitazza.com in its replies."""
    text = response_text
    for pattern, replacement in _PII_PATTERNS_OUTPUT:
        text = re.sub(pattern, replacement, text)
    return text


def contains_financial_advice_request(user_message: str) -> bool:
    return _matches_any(user_message, _FINANCIAL_ADVICE_PATTERNS)
