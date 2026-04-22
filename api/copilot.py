"""AI Copilot — agent-assisting features powered by Gemini Flash."""
import json
import logging

from config.settings import GEMINI_API_KEY, MODEL

logger = logging.getLogger(__name__)

try:
    from google import genai as _genai
    _client = _genai.Client(api_key=GEMINI_API_KEY)
except Exception:
    logger.exception("Failed to initialise Gemini client — copilot features disabled")
    _client = None


async def _call(prompt: str) -> str:
    if not _client:
        return ""
    try:
        resp = _client.models.generate_content(
            model=MODEL,
            contents=prompt,
        )
        return resp.text.strip()
    except Exception:
        logger.exception("Gemini copilot call failed — returning empty string")
        return ""


def _fmt_history(history: list[dict]) -> str:
    lines = []
    for m in history:
        role = m.get("role", "unknown")
        content = m.get("content", "")
        lines.append(f"{role.upper()}: {content}")
    return "\n".join(lines)


async def suggest_reply(history: list[dict]) -> str:
    thread = _fmt_history(history[-10:])
    prompt = (
        "You are a Bitazza customer support agent. "
        "Read the conversation below and write a concise, professional reply for the agent to send next. "
        "Match the language (Thai or English) used by the customer. "
        "Reply with ONLY the draft message text, no explanation.\n\n"
        f"CONVERSATION:\n{thread}\n\nDRAFT REPLY:"
    )
    return await _call(prompt)


async def summarize_conversation(history: list[dict]) -> str:
    thread = _fmt_history(history)
    prompt = (
        "Summarize this customer support conversation in 3-5 sentences in English. "
        "Cover: what the customer's issue is, what steps have been taken, and current status/next action. "
        "Be concise and factual.\n\n"
        f"CONVERSATION:\n{thread}\n\nSUMMARY:"
    )
    return await _call(prompt)


async def classify_sentiment(message: str) -> str:
    prompt = (
        "Classify the sentiment of the following customer message as exactly one of: positive, neutral, negative. "
        "Reply with only the single word.\n\n"
        f"MESSAGE: {message}\n\nSENTIMENT:"
    )
    result = await _call(prompt)
    result = result.lower().strip()
    return result if result in {"positive", "neutral", "negative"} else "neutral"


async def draft_reply_with_instruction(
    history: list[dict],
    instruction: str = "",
    partial_draft: str = "",
) -> str:
    thread = _fmt_history(history[-10:])
    parts = [
        "You are a Bitazza customer support agent helping a human agent compose a reply.",
        "Match the language (Thai or English) used by the customer.",
        "Reply with ONLY the draft message text — no explanation, no preamble.",
        "",
        f"CONVERSATION:\n{thread}",
    ]
    if partial_draft.strip():
        parts += ["", f"AGENT'S PARTIAL DRAFT (improve/complete this):\n{partial_draft.strip()}"]
    if instruction.strip():
        parts += ["", f"AGENT'S INSTRUCTION: {instruction.strip()}"]
    parts += ["", "DRAFT REPLY:"]
    return await _call("\n".join(parts))


async def find_related_tickets(first_message: str) -> list[dict]:
    # Stub — returns mock related tickets until vector search over tickets is wired up
    return [
        {"id": "TKT-00101", "category": "kyc", "status": "closed", "resolved_at": None, "summary": "Customer submitted wrong ID document type during KYC."},
        {"id": "TKT-00089", "category": "account_security", "status": "closed", "resolved_at": None, "summary": "2FA reset requested after phone number change."},
        {"id": "TKT-00234", "category": "deposit_fiat", "status": "resolved", "resolved_at": None, "summary": "PromptPay deposit not credited within SLA window."},
    ]
