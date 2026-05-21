"""
File attachment upload endpoint.

POST /api/uploads/attachment
  - Accepts multipart/form-data with a single `file` field
  - Validates MIME type against allowlist
  - Validates file size (max 10 MB)
  - Re-encodes images through Pillow to strip metadata / steganography
  - Saves to uploads/attachments/<uuid>_<sanitized_name>
  - Returns { id, url, name, mime_type, size }

AI never reads uploaded content — files go straight to human agents.
"""
import io
import os
import re
import uuid

from fastapi import APIRouter, HTTPException, UploadFile, File, Request

router = APIRouter()

# ── Constants ─────────────────────────────────────────────────────────────────

_ALLOWED_MIME = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/heic",
    "image/heif",
    "application/pdf",
}

# HEIC/HEIF are converted to JPEG before storage — map their MIME types here
_HEIC_MIME = {"image/heic", "image/heif"}

_MAX_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB

_UPLOAD_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "uploads",
    "attachments",
)

# ── Helpers ───────────────────────────────────────────────────────────────────

def _sanitize_filename(name: str) -> str:
    """Strip path components and replace unsafe characters."""
    name = os.path.basename(name)
    name = re.sub(r"[^\w.\-]", "_", name)
    return name[:120]  # cap length


def _strip_image_metadata(data: bytes, mime_type: str) -> tuple[bytes, str]:
    """
    Re-encode image through Pillow to strip EXIF, XMP, and steganographic payloads.
    HEIC/HEIF files are converted to JPEG.
    Returns (processed_bytes, effective_mime_type).
    """
    try:
        if mime_type in _HEIC_MIME:
            # Register HEIF opener so Pillow can read HEIC/HEIF files
            try:
                from pillow_heif import register_heif_opener
                register_heif_opener()
            except ImportError:
                raise HTTPException(status_code=415, detail="HEIC/HEIF support not available on this server.")
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        # Convert palette or HEIC images to RGB/RGBA for JPEG/PNG compatibility
        if img.mode in ("P", "PA"):
            img = img.convert("RGBA")
        if mime_type in _HEIC_MIME:
            # Always convert HEIC → JPEG
            if img.mode in ("RGBA", "LA", "P"):
                img = img.convert("RGB")
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=92, exif=b"")
            return buf.getvalue(), "image/jpeg"
        buf = io.BytesIO()
        fmt_map = {
            "image/jpeg": "JPEG",
            "image/png": "PNG",
            "image/webp": "WEBP",
            "image/gif": "GIF",
        }
        fmt = fmt_map.get(mime_type, "PNG")
        if fmt == "JPEG":
            img.save(buf, format=fmt, quality=92, exif=b"")
        else:
            img.save(buf, format=fmt)
        return buf.getvalue(), mime_type
    except HTTPException:
        raise
    except Exception:
        # If Pillow fails for any reason, reject rather than pass raw bytes
        raise HTTPException(status_code=422, detail="Could not process image file.")


# ── Route ─────────────────────────────────────────────────────────────────────

@router.post("/attachment")
async def upload_attachment(request: Request, file: UploadFile = File(...)):
    # 1. MIME type check
    mime = file.content_type or ""
    if mime not in _ALLOWED_MIME:
        raise HTTPException(
            status_code=415,
            detail=f"File type '{mime}' is not allowed. Accepted: jpeg, png, webp, gif, pdf.",
        )

    # 2. Read and size check
    data = await file.read()
    if len(data) > _MAX_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds the 10 MB size limit.")

    # 3. Strip image metadata (PDFs are passed through as-is — no LLM reads them)
    if mime.startswith("image/"):
        data, mime = _strip_image_metadata(data, mime)

    # 4. Build safe filename and save
    os.makedirs(_UPLOAD_DIR, exist_ok=True)
    file_id = str(uuid.uuid4())
    original_name = file.filename or "upload"
    # HEIC files are saved as .jpg after conversion
    if original_name.lower().endswith((".heic", ".heif")):
        original_name = re.sub(r"\.(heic|heif)$", ".jpg", original_name, flags=re.IGNORECASE)
    safe_name = _sanitize_filename(original_name)
    stored_name = f"{file_id}_{safe_name}"
    dest = os.path.join(_UPLOAD_DIR, stored_name)
    with open(dest, "wb") as f:
        f.write(data)

    # 5. Build public URL
    base_url = str(request.base_url).rstrip("/")
    url = f"{base_url}/uploads/attachments/{stored_name}"

    return {
        "id": file_id,
        "url": url,
        "name": safe_name,
        "mime_type": mime,
        "size": len(data),
    }
