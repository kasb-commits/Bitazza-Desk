"""
Outbound email sender — uses Gmail API to send replies.

Responsibilities:
- Send formal replies preserving Gmail thread (In-Reply-To + References headers)
- Wrap agent reply text in formal email structure (salutation, body, sign-off)
- Append CSAT rating links to closing emails
- Append rejected-attachment notices when applicable
- Return the sent Gmail Message-ID for threading records

Tone: formal / official — distinct from the casual widget tone.
"""

import base64
import logging
import re
import urllib.request
from email.mime.base import MIMEBase
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, make_msgid

from config import settings

logger = logging.getLogger(__name__)

SUPPORT_EMAIL: str = getattr(settings, "GMAIL_SUPPORT_EMAIL", "support@bitazza.com")
SUPPORT_NAME: str = "Bitazza Support"
API_BASE_URL: str = getattr(settings, "API_BASE_URL", "https://api.bitazza.com")


# ── Formal email wrapper ──────────────────────────────────────────────────────

def _build_formal_body(
    agent_reply: str,
    customer_name: str,
    ticket_id: str,
    language: str,
    csat_html: str = "",
    attachment_notice: str = "",
    inline_images: list[dict] | None = None,
) -> tuple[str, str]:
    """
    Wrap the agent's reply text in a formal email structure.
    Returns (plain_text_body, html_body).
    """
    short_id = ticket_id[:8].upper()

    if language == "th":
        salutation = f"เรียน คุณ{customer_name}," if customer_name else "เรียน ลูกค้า,"
        sign_off = (
            f"ขอแสดงความนับถือ\n"
            f"ทีมสนับสนุนลูกค้า Bitazza\n"
            f"หมายเลขอ้างอิง: #{short_id}"
        )
        sign_off_html = (
            f"ขอแสดงความนับถือ<br>"
            f"<strong>ทีมสนับสนุนลูกค้า Bitazza</strong><br>"
            f"<span style='color:#888;font-size:12px;'>หมายเลขอ้างอิง: #{short_id}</span>"
        )
    else:
        salutation = f"Dear {customer_name}," if customer_name else "Dear Valued Customer,"
        sign_off = (
            f"Kind regards,\n"
            f"Bitazza Customer Support\n"
            f"Reference: #{short_id}"
        )
        sign_off_html = (
            f"Kind regards,<br>"
            f"<strong>Bitazza Customer Support</strong><br>"
            f"<span style='color:#888;font-size:12px;'>Reference: #{short_id}</span>"
        )

    # Plain text
    plain = f"{salutation}\n\n{agent_reply}{attachment_notice}\n\n{sign_off}"

    # HTML — embed inline image references if provided
    reply_html = agent_reply.replace("\n", "<br>")
    attachment_html = attachment_notice.replace("\n", "<br>") if attachment_notice else ""
    images_html = ""
    if inline_images:
        imgs = "".join(
            f'<div style="margin:8px 0;"><img src="cid:{img["cid"]}" alt="{img["name"]}" '
            f'style="max-width:100%;border-radius:6px;border:1px solid #eee;" /></div>'
            for img in inline_images
        )
        images_html = f'<div style="margin-top:16px;">{imgs}</div>'

    html = f"""<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:600px;margin:0 auto;padding:20px;">
  <p>{salutation}</p>
  <p style="line-height:1.6;">{reply_html}</p>
  {images_html}
  {f'<p style="color:#c0392b;font-size:13px;">{attachment_html}</p>' if attachment_html else ''}
  {csat_html}
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
  <p style="font-size:13px;color:#555;">{sign_off_html}</p>
</body>
</html>"""

    return plain, html


# ── CSAT footer ───────────────────────────────────────────────────────────────

def build_csat_html(ticket_id: str, csat_tokens: dict[int, str], language: str) -> str:
    """
    Build the CSAT star-rating HTML block for closing emails.

    Args:
        ticket_id: The ticket ID
        csat_tokens: {score: token} mapping e.g. {1: 'tok1', 2: 'tok2', ...}
        language: 'en' or 'th'
    """
    if not csat_tokens:
        return ""

    if language == "th":
        prompt = "คุณพอใจกับบริการของเราแค่ไหน?"
        labels = ["แย่", "พอใช้", "ดี", "ดีมาก", "ยอดเยี่ยม"]
    else:
        prompt = "How did we do?"
        labels = ["Poor", "Fair", "Good", "Great", "Excellent"]

    stars_html = ""
    for score in range(1, 6):
        token = csat_tokens.get(score, "")
        url = f"{API_BASE_URL}/email/csat/{ticket_id}?score={score}&token={token}"
        label = labels[score - 1]
        stars_html += (
            f'<a href="{url}" style="text-decoration:none;margin:0 6px;">'
            f'{"⭐" * score}<br>'
            f'<span style="font-size:11px;color:#666;">{label}</span>'
            f'</a>'
        )

    return f"""
<div style="background:#f9f9f9;border:1px solid #eee;border-radius:8px;padding:16px;margin:24px 0;text-align:center;">
  <p style="margin:0 0 12px;font-size:13px;color:#555;">{prompt}</p>
  <div style="display:flex;justify-content:center;gap:4px;">
    {stars_html}
  </div>
</div>"""


# ── Gmail API send ────────────────────────────────────────────────────────────

def _encode_message(msg: MIMEMultipart) -> str:
    """Base64url-encode a MIME message for the Gmail API."""
    raw = msg.as_bytes()
    return base64.urlsafe_b64encode(raw).decode("utf-8")


def send_reply(
    gmail_service,
    *,
    to_email: str,
    to_name: str,
    subject: str,
    agent_reply: str,
    thread_id: str,
    in_reply_to_message_id: str,
    references: str,
    ticket_id: str,
    language: str,
    is_closing: bool = False,
    csat_tokens: dict[int, str] | None = None,
    attachment_notice: str = "",
    attachments: list[dict] | None = None,
) -> str:
    """
    Send a reply email via the Gmail API.

    Args:
        gmail_service: Authenticated Gmail API service object (from googleapiclient)
        to_email: Recipient email address
        to_name: Recipient display name
        subject: Email subject (Re: ... prefix added if not present)
        agent_reply: The AI or human agent's reply text
        thread_id: Gmail thread ID to keep the reply in the same thread
        in_reply_to_message_id: Message-ID of the email being replied to
        references: Full References header chain from the inbound email
        ticket_id: Our internal ticket ID (for reference number in footer)
        language: 'en' or 'th'
        is_closing: If True, CSAT footer is appended
        csat_tokens: {score: token} dict — required if is_closing=True
        attachment_notice: Optional notice about rejected attachments

    Returns:
        The Gmail Message-ID of the sent email (for threading records)
    """
    csat_html = ""
    if is_closing and csat_tokens:
        csat_html = build_csat_html(ticket_id, csat_tokens, language)

    # ── Fetch and classify attachments ────────────────────────────────────────
    # Images are embedded inline (CID references); PDFs/other files are attached.
    inline_images: list[dict] = []   # {cid, name, data, subtype}
    file_attachments: list[dict] = []  # {name, data, mime_type}

    for att in (attachments or []):
        url = att.get("url", "")
        name = att.get("name", "attachment")
        mime_type = att.get("mime_type", "application/octet-stream")
        if not url:
            continue
        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                data = resp.read()
        except Exception as exc:
            logger.warning("Could not fetch attachment %s for email: %s", url, exc)
            continue
        if mime_type.startswith("image/"):
            cid = make_msgid(domain="bitazza.com").strip("<>")
            inline_images.append({"cid": cid, "name": name, "data": data, "subtype": mime_type.split("/")[1]})
        else:
            file_attachments.append({"name": name, "data": data, "mime_type": mime_type})

    plain_body, html_body = _build_formal_body(
        agent_reply=agent_reply,
        customer_name=to_name,
        ticket_id=ticket_id,
        language=language,
        csat_html=csat_html,
        attachment_notice=attachment_notice,
        inline_images=inline_images if inline_images else None,
    )

    # Ensure subject has Re: prefix
    if not re.match(r"^Re:", subject, re.IGNORECASE):
        subject = f"Re: {subject}"

    # ── Build MIME structure ──────────────────────────────────────────────────
    # No attachments: simple multipart/alternative (plain + html)
    # With inline images: multipart/related wrapping alternative + image parts
    # With file attachments: outer multipart/mixed
    has_inline = bool(inline_images)
    has_files = bool(file_attachments)

    alt_part = MIMEMultipart("alternative")
    alt_part.attach(MIMEText(plain_body, "plain", "utf-8"))
    alt_part.attach(MIMEText(html_body, "html", "utf-8"))

    if has_inline:
        related_part = MIMEMultipart("related")
        related_part.attach(alt_part)
        for img in inline_images:
            mime_img = MIMEImage(img["data"], _subtype=img["subtype"])
            mime_img.add_header("Content-ID", f"<{img['cid']}>")
            mime_img.add_header("Content-Disposition", "inline", filename=img["name"])
            related_part.attach(mime_img)
        inner = related_part
    else:
        inner = alt_part

    if has_files:
        outer = MIMEMultipart("mixed")
        outer.attach(inner)
        for f in file_attachments:
            part = MIMEBase(*f["mime_type"].split("/", 1))
            part.set_payload(f["data"])
            from email import encoders
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", "attachment", filename=f["name"])
            outer.attach(part)
        msg = outer
    else:
        msg = inner

    msg["From"] = formataddr((SUPPORT_NAME, SUPPORT_EMAIL))
    msg["To"] = formataddr((to_name, to_email)) if to_name else to_email
    msg["Subject"] = subject
    msg["In-Reply-To"] = in_reply_to_message_id
    msg["References"] = (
        f"{references} {in_reply_to_message_id}".strip()
        if references
        else in_reply_to_message_id
    )

    encoded = _encode_message(msg)
    sent = gmail_service.send_message(encoded, thread_id=thread_id)

    sent_id = sent.get("id", "")
    logger.info("Sent reply to %s | ticket=%s | gmail_msg_id=%s", to_email, ticket_id, sent_id)
    return sent_id


def send_identity_request(
    gmail_service,
    *,
    to_email: str,
    to_name: str,
    subject: str,
    thread_id: str,
    in_reply_to_message_id: str,
    references: str,
    ticket_id: str,
    verification_url: str,
    language: str,
) -> str:
    """
    Send an identity verification request email.
    Used when an unmatched sender submits an account-aware inquiry.
    """
    short_id = ticket_id[:8].upper()

    if language == "th":
        body = (
            f"เราได้รับคำร้องของท่านแล้ว (อ้างอิง #{short_id})\n\n"
            f"เนื่องจากไม่พบบัญชีที่เชื่อมโยงกับอีเมลนี้ในระบบของเรา "
            f"กรุณายืนยันตัวตนของท่านโดยคลิกลิงก์ด้านล่าง:\n\n"
            f"{verification_url}\n\n"
            f"ลิงก์นี้จะหมดอายุใน 24 ชั่วโมง และใช้ได้เพียงครั้งเดียวเท่านั้น "
            f"เมื่อยืนยันแล้ว ทีมงานจะดำเนินการตามคำร้องของท่านทันที"
        )
    else:
        body = (
            f"We have received your request (Reference #{short_id}).\n\n"
            f"We were unable to find an account linked to this email address. "
            f"To protect our customers' security, please verify your identity by clicking the link below:\n\n"
            f"{verification_url}\n\n"
            f"This link expires in 24 hours and can only be used once. "
            f"Once verified, we will proceed with your request immediately."
        )

    return send_reply(
        gmail_service,
        to_email=to_email,
        to_name=to_name,
        subject=subject,
        agent_reply=body,
        thread_id=thread_id,
        in_reply_to_message_id=in_reply_to_message_id,
        references=references,
        ticket_id=ticket_id,
        language=language,
        is_closing=False,
    )


def send_password_reset_email_mismatch(
    gmail_service,
    *,
    to_email: str,
    to_name: str,
    subject: str,
    thread_id: str,
    in_reply_to_message_id: str,
    references: str,
    ticket_id: str,
    language: str,
) -> str:
    """
    Sent when a password/2FA reset request comes from an email not registered
    in our system. Instructs them to write from their registered email.
    """
    if language == "th":
        body = (
            "ขออภัย เราไม่พบบัญชีที่ลงทะเบียนด้วยอีเมลนี้ในระบบ\n\n"
            "กรุณาส่งอีเมลมาใหม่จากอีเมลที่ท่านใช้ลงทะเบียนบัญชี Bitazza "
            "เพื่อที่เราจะสามารถดำเนินการตามคำร้องได้อย่างปลอดภัย"
        )
    else:
        body = (
            "We could not find an account registered with this email address.\n\n"
            "For security purposes, please send your request from the email address "
            "you used to register your Bitazza account, so we can process it safely."
        )

    return send_reply(
        gmail_service,
        to_email=to_email,
        to_name=to_name,
        subject=subject,
        agent_reply=body,
        thread_id=thread_id,
        in_reply_to_message_id=in_reply_to_message_id,
        references=references,
        ticket_id=ticket_id,
        language=language,
        is_closing=False,
    )
