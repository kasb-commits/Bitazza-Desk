"""
Scrape and ingest Freedom Platform and Bitazza Exchange blog posts into ChromaDB.
Usage: python ingestion/blog_ingester.py
"""
import uuid, time, re
import requests
from bs4 import BeautifulSoup
from db.vector_store import upsert_documents, collection_count
from db.conversation_store import create_knowledge_item

CHUNK_SIZE = 700
CHUNK_OVERLAP = 100

BLOG_SOURCES = [
    {
        "name": "bitazza_blog",
        "index_urls": [
            "https://blog.bitazza.com/blog",
        ],
        "article_selector": "a[href*='/blog/']",
        "base_url": "https://blog.bitazza.com",
        "content_selector": "article, .blog-content, .post-content, main",
    },
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; CSBot-Ingester/1.0)",
    "Accept-Language": "en,th;q=0.9",
}


def fetch(url: str, retries: int = 3) -> str | None:
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=15)
            r.raise_for_status()
            return r.text
        except Exception as e:
            if attempt == retries - 1:
                print(f"  FAILED {url}: {e}")
                return None
            time.sleep(2 ** attempt)
    return None


def extract_links(html: str, base_url: str, selector: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    links = set()
    for a in soup.select(selector):
        href = a.get("href", "")
        if href.startswith("http"):
            links.add(href)
        elif href.startswith("/"):
            links.add(base_url.rstrip("/") + href)
    return list(links)


def extract_text(html: str, selector: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    # Try specific selector first, fall back to body
    container = soup.select_one(selector) or soup.find("body")
    if not container:
        return ""
    # Remove nav, footer, scripts, styles
    for tag in container.select("nav, footer, script, style, header, .sidebar, .menu"):
        tag.decompose()
    text = container.get_text(separator="\n", strip=True)
    # Collapse whitespace
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def chunk_text(text: str, source_name: str, url: str) -> list[dict]:
    chunks = []
    start = 0
    while start < len(text):
        end = start + CHUNK_SIZE
        chunk = text[start:end].strip()
        if len(chunk) > 100:  # skip tiny fragments
            chunks.append({
                "id": f"blog_{uuid.uuid4().hex[:10]}",
                "text": chunk,
                "metadata": {
                    "source": source_name,
                    "doc_type": "blog",
                    "url": url,
                },
            })
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks


def ingest_source(source: dict) -> int:
    total_docs = 0
    seen_urls: set[str] = set()

    for index_url in source["index_urls"]:
        print(f"  Fetching index: {index_url}")
        html = fetch(index_url)
        if not html:
            continue

        article_urls = extract_links(html, source["base_url"], source["article_selector"])
        print(f"  Found {len(article_urls)} article links")

        for url in article_urls:
            if url in seen_urls:
                continue
            seen_urls.add(url)

            article_html = fetch(url)
            if not article_html:
                continue

            text = extract_text(article_html, source["content_selector"])
            if len(text) < 200:
                continue

            chunks = chunk_text(text, source["name"], url)
            if chunks:
                # Register in PostgreSQL so the dashboard KB list shows it
                title = url.rstrip("/").split("/")[-1].replace("-", " ").title()
                item = create_knowledge_item(
                    title=title[:255],
                    source_type="url",   # blog posts are web URLs
                    source_ref=url,
                    chunk_count=len(chunks),
                    created_by=None,
                )
                item_id = str(item["id"])
                for chunk in chunks:
                    chunk["metadata"]["knowledge_item_id"] = item_id
                upsert_documents(chunks)
                total_docs += len(chunks)
                print(f"    ✓ {url} → {len(chunks)} chunks (kb_item={item_id})")

            time.sleep(0.5)  # polite crawl delay

    return total_docs


def main():
    total = 0
    for source in BLOG_SOURCES:
        print(f"\nIngesting {source['name']}...")
        count = ingest_source(source)
        print(f"  → {count} chunks ingested")
        total += count

    print(f"\nDone. Total new chunks: {total}. Vector DB size: {collection_count()} docs.")


if __name__ == "__main__":
    main()
