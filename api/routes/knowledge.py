"""
Knowledge Base management routes.

Supports ingesting content from:
- URLs (scraped via BeautifulSoup)
- PDF files (via pypdf)
- DOCX files (via python-docx)

All content is chunked and stored in ChromaDB so the RAG retriever
automatically picks it up when answering customer queries.
"""
import io
import logging
import uuid

import requests as _requests
from bs4 import BeautifulSoup
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel

from api.middleware.auth import get_user_id, get_optional_user_id
from db.conversation_store import (
    create_knowledge_item,
    list_knowledge_items,
    get_knowledge_item,
    delete_knowledge_item,
)
from db.vector_store import upsert_documents, delete_by_metadata, get_chunks_by_item

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])


# ── Text chunking ─────────────────────────────────────────────────────────────

def _chunk_text(text: str, size: int = 800, overlap: int = 100) -> list[str]:
    """Split text into overlapping chunks of ~size characters."""
    # Prefer paragraph splits first
    paragraphs: list[str] = []
    for para in text.split("\n\n"):
        para = para.strip()
        if para:
            paragraphs.append(para)

    chunks: list[str] = []
    current = ""
    for para in paragraphs:
        if len(current) + len(para) + 2 <= size:
            current = (current + "\n\n" + para).strip()
        else:
            if current:
                chunks.append(current)
            # If a single paragraph is > size, split by words
            if len(para) > size:
                words = para.split()
                buf = ""
                for w in words:
                    if len(buf) + len(w) + 1 <= size:
                        buf = (buf + " " + w).strip()
                    else:
                        if buf:
                            chunks.append(buf)
                        # Carry overlap
                        overlap_words = buf.split()[-max(1, overlap // 6):]
                        buf = " ".join(overlap_words) + " " + w
                if buf:
                    current = buf
            else:
                # Carry overlap from previous chunk
                if chunks:
                    prev_words = chunks[-1].split()
                    carry = " ".join(prev_words[-max(1, overlap // 6):])
                    current = (carry + "\n\n" + para).strip()
                else:
                    current = para

    if current:
        chunks.append(current)

    return [c for c in chunks if c.strip()]


# ── URL ingestion ─────────────────────────────────────────────────────────────

class AddUrlRequest(BaseModel):
    url: str


@router.post("/url")
def add_url(body: AddUrlRequest, agent_id: str = Depends(get_user_id)):
    """Scrape a URL, chunk its content, and store in the vector DB."""
    url = body.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=422, detail="URL must start with http:// or https://")

    try:
        resp = _requests.get(url, timeout=15, headers={"User-Agent": "CSBot/1.0"})
        resp.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Failed to fetch URL: {exc}") from exc

    soup = BeautifulSoup(resp.text, "html.parser")

    # Remove boilerplate elements
    for tag in soup.find_all(["script", "style", "nav", "footer", "header", "aside"]):
        tag.decompose()

    # Title
    title_tag = soup.find("title") or soup.find("h1")
    title = title_tag.get_text(strip=True) if title_tag else url

    body_text = soup.get_text(separator="\n", strip=True)
    if not body_text.strip():
        raise HTTPException(status_code=422, detail="No readable content found at URL")

    chunks = _chunk_text(body_text)
    if not chunks:
        raise HTTPException(status_code=422, detail="Could not extract any text from URL")

    # Persist to DB first to get the item ID
    item = create_knowledge_item(
        title=title[:255],
        source_type="url",
        source_ref=url,
        chunk_count=len(chunks),
        created_by=agent_id,
    )
    item_id = str(item["id"])

    # Upsert chunks to vector store
    docs = [
        {
            "id": f"kb_{item_id}_{i}",
            "text": chunk,
            "metadata": {
                "knowledge_item_id": item_id,
                "source": url,
                "source_type": "url",
                "title": title[:255],
                "chunk_index": i,
            },
        }
        for i, chunk in enumerate(chunks)
    ]
    try:
        upsert_documents(docs)
    except Exception as exc:
        logger.exception("Vector upsert failed for knowledge item %s", item_id)
        raise HTTPException(status_code=500, detail=f"Vector store error: {exc}") from exc

    return item


# ── File upload ingestion ─────────────────────────────────────────────────────

@router.post("/upload")
async def upload_file(file: UploadFile = File(...), agent_id: str = Depends(get_user_id)):
    """Upload a PDF or DOCX file, extract its text, and store in the vector DB."""
    filename = file.filename or ""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    content_type = (file.content_type or "").lower()

    is_pdf = ext == "pdf" or "pdf" in content_type
    is_docx = ext == "docx" or "wordprocessingml" in content_type

    if not (is_pdf or is_docx):
        raise HTTPException(
            status_code=422,
            detail="Only PDF (.pdf) and Word (.docx) files are supported"
        )

    raw = await file.read()
    buf = io.BytesIO(raw)
    text = ""

    if is_pdf:
        try:
            import pypdf  # type: ignore
        except ImportError:
            raise HTTPException(
                status_code=422,
                detail="PDF support requires pypdf. Run: pip install pypdf"
            )
        try:
            reader = pypdf.PdfReader(buf)
            pages = [page.extract_text() or "" for page in reader.pages]
            text = "\n\n".join(p for p in pages if p.strip())
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Could not read PDF: {exc}") from exc

    elif is_docx:
        try:
            import docx  # type: ignore  # python-docx
        except ImportError:
            raise HTTPException(
                status_code=422,
                detail="DOCX support requires python-docx. Run: pip install python-docx"
            )
        try:
            doc = docx.Document(buf)
            text = "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Could not read DOCX: {exc}") from exc

    if not text.strip():
        raise HTTPException(status_code=422, detail="No readable text found in the uploaded file")

    chunks = _chunk_text(text)
    if not chunks:
        raise HTTPException(status_code=422, detail="Could not extract any text from the file")

    title = filename.rsplit(".", 1)[0].replace("_", " ").replace("-", " ") if filename else "Uploaded document"

    item = create_knowledge_item(
        title=title[:255],
        source_type=ext if ext in ("pdf", "docx") else "pdf",
        source_ref=filename,
        chunk_count=len(chunks),
        created_by=agent_id,
    )
    item_id = str(item["id"])

    docs = [
        {
            "id": f"kb_{item_id}_{i}",
            "text": chunk,
            "metadata": {
                "knowledge_item_id": item_id,
                "source": filename,
                "source_type": ext,
                "title": title[:255],
                "chunk_index": i,
            },
        }
        for i, chunk in enumerate(chunks)
    ]
    try:
        upsert_documents(docs)
    except Exception as exc:
        logger.exception("Vector upsert failed for knowledge item %s", item_id)
        raise HTTPException(status_code=500, detail=f"Vector store error: {exc}") from exc

    return item


# ── List ──────────────────────────────────────────────────────────────────────

@router.get("")
def get_knowledge_items(_agent_id: str = Depends(get_user_id)):
    """List all knowledge base items."""
    items = list_knowledge_items()
    return {"items": items}


# ── Preview chunks ────────────────────────────────────────────────────────────

@router.get("/{item_id}/chunks")
def get_chunks(item_id: int, _agent_id: str = Depends(get_optional_user_id)):
    """Return all indexed text chunks for a knowledge item."""
    item = get_knowledge_item(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Knowledge item not found")
    try:
        chunks = get_chunks_by_item(item_id)
        return {"item_id": item_id, "chunks": chunks}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/{item_id}", status_code=204)
def delete_item(item_id: int, _agent_id: str = Depends(get_user_id)):
    """Delete a knowledge item and all its vector chunks."""
    item = get_knowledge_item(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Knowledge item not found")

    # Remove all chunks from vector store
    deleted = delete_by_metadata("knowledge_item_id", str(item_id))
    logger.info("Deleted %d vector chunks for knowledge item %d", deleted, item_id)

    delete_knowledge_item(item_id)
