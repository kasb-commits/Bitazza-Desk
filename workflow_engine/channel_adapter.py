"""
Channel adapter — normalizes widget and email inputs into a common
ChannelMessage, and provides channel-specific reply functions.

Built-in variables injected into every message:
  language, channel, category, user_id, conversation_id
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable


def _detect_language(text: str) -> str:
    """Mirror of engine.agent.detect_language — Thai detection by Unicode range."""
    thai_chars = sum(1 for c in text if "\u0e00" <= c <= "\u0e7f")
    return "th" if thai_chars / max(len(text), 1) > 0.1 else "en"


@dataclass
class ChannelMessage:
    text: str
    channel: str          # "widget" | "email"
    category: str
    language: str
    user_id: str | None   # None for guest (unauthenticated) sessions
    conversation_id: str
    metadata: dict[str, Any]   # thread_id, message_id, from_email, subject (email only)
    reply_fn: Callable[[str], None] | None = field(default=None, repr=False)


class WidgetAdapter:

    def normalize(
        self,
        text: str,
        conversation_id: str,
        user_id: str | None,
        category: str,
        language: str | None,
        metadata: dict[str, Any],
        reply_fn: Callable[[str], None] | None = None,
    ) -> ChannelMessage:
        lang = language or _detect_language(text)
        return ChannelMessage(
            text=text,
            channel="widget",
            category=category,
            language=lang,
            user_id=user_id,
            conversation_id=conversation_id,
            metadata=metadata,
            reply_fn=reply_fn,
        )

    def make_reply_fn(
        self,
        conversation_id: str,
        broadcast_fn: Callable[[str, str], None],
    ) -> Callable[[str], None]:
        def reply(text: str) -> None:
            broadcast_fn(conversation_id, text)
        return reply


class EmailAdapter:

    def normalize(
        self,
        parsed_email: Any,
        conversation_id: str,
        user_id: str | None,
        category: str,
        reply_fn: Callable[[str], None] | None = None,
    ) -> ChannelMessage:
        lang = getattr(parsed_email, "language", None) or _detect_language(parsed_email.body)
        metadata = {
            "thread_id":   parsed_email.thread_id,
            "message_id":  parsed_email.message_id,
            "from_email":  parsed_email.from_email,
            "subject":     getattr(parsed_email, "subject", ""),
        }
        return ChannelMessage(
            text=parsed_email.body,
            channel="email",
            category=category,
            language=lang,
            user_id=user_id,
            conversation_id=conversation_id,
            metadata=metadata,
            reply_fn=reply_fn,
        )

    def make_reply_fn(
        self,
        thread_id: str,
        to_email: str,
        subject: str,
        send_fn: Callable[..., None],
    ) -> Callable[[str], None]:
        def reply(text: str) -> None:
            send_fn(
                thread_id=thread_id,
                to_email=to_email,
                subject=subject,
                body=text,
            )
        return reply
