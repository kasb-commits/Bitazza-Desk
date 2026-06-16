"""Central config — all values from environment variables."""
import os
from dotenv import load_dotenv

load_dotenv()

# AI
GEMINI_API_KEY: str = os.environ["GEMINI_API_KEY"]
MODEL: str = os.getenv("MODEL", "gemini-2.5-flash")
CLASSIFIER_MODEL: str = os.getenv("CLASSIFIER_MODEL", "gemini-2.5-flash-lite")
MAX_TOKENS: int = int(os.getenv("MAX_TOKENS", "2048"))
MAX_RAG_CHUNKS: int = int(os.getenv("MAX_RAG_CHUNKS", "5"))

# Freshdesk
FRESHDESK_API_KEY: str = os.environ["FRESHDESK_API_KEY"]
FRESHDESK_SUBDOMAIN: str = os.environ["FRESHDESK_SUBDOMAIN"]

# Database
DATABASE_URL: str = os.getenv("DATABASE_URL", "postgresql://user:password@localhost:5432/csbot")

# Vector store
CHROMA_PATH: str = os.getenv("CHROMA_PATH", "./data/chroma")

# Environment
ENV: str = os.getenv("ENV", "development")  # set to "production" in prod

# Auth
JWT_SECRET: str = os.getenv("JWT_SECRET", "dev-secret-change-in-prod")
JWT_ALGORITHM: str = "HS256"
INTERNAL_SERVICE_TOKEN: str = os.getenv("INTERNAL_SERVICE_TOKEN", "")

# Escalation
ESCALATION_CONFIDENCE_THRESHOLD: float = float(os.getenv("ESCALATION_CONFIDENCE_THRESHOLD", "0.6"))
ESCALATION_KEYWORDS: list[str] = ["fraud", "hack", "stolen", "lawyer", "regulation", "complaint", "sue", "police", "scam"]
ESCALATION_HUMAN_PHRASES: list[str] = [
    "i need a human", "talk to a human", "speak to a human", "real support agent",
    "talk to someone", "speak to someone", "connect me to an agent",
    "transfer me to", "i want to escalate", "escalate this",
    "talk to a specialist", "speak to a specialist", "connect me to a specialist",
    "live agent", "live support", "real person",
    "ต่อสาย", "คุยกับคน", "ขอคุยกับ", "เจ้าหน้าที่จริง", "โอนสาย",
]

# Rate limiting
RATE_LIMIT_PER_MINUTE: int = int(os.getenv("RATE_LIMIT_PER_MINUTE", "20"))

# User / KYC API
USE_MOCK_USER_API: bool = os.getenv("USE_MOCK_USER_API", "true").lower() == "true"
USER_API_BASE_URL: str = os.getenv("USER_API_BASE_URL", "http://localhost:8000")
USER_API_KEY: str = os.getenv("USER_API_KEY", "mock-dev-token")

# Bitazza Exchange — Widget Session (auth + KYC).
# Gates ONLY the auth + KYC path; USE_MOCK_USER_API still controls every other
# account tool (restrictions, deposits, balances, ...). Default off = mock behaviour.
USE_EXCHANGE_API: bool = os.getenv("USE_EXCHANGE_API", "false").lower() == "true"
EXCHANGE_BE_BASE_URL: str = os.getenv("EXCHANGE_BE_BASE_URL", "")  # e.g. https://gateway.bitazza-staging.com
WIDGET_HMAC_SECRET: str = os.getenv("WIDGET_HMAC_SECRET", "")      # shared HMAC secret — set in env only
WIDGET_CLIENT_ID: str = os.getenv("WIDGET_CLIENT_ID", "")          # X-Client-Id value

# Freedom / Bitazza internal APIs
FREEDOM_API_URL: str = os.getenv("FREEDOM_API_URL", "")
BITAZZA_API_URL: str = os.getenv("BITAZZA_API_URL", "")
INTERNAL_API_KEY: str = os.getenv("INTERNAL_API_KEY", "")

# Email channel — Gmail API
GMAIL_CREDENTIALS_JSON: str = os.getenv("GMAIL_CREDENTIALS_JSON", "")
GMAIL_SUPPORT_EMAIL: str = os.getenv("GMAIL_SUPPORT_EMAIL", "support@bitazza.com")
GOOGLE_PUBSUB_TOPIC: str = os.getenv("GOOGLE_PUBSUB_TOPIC", "")
GMAIL_PUBSUB_SECRET: str = os.getenv("GMAIL_PUBSUB_SECRET", "")
API_BASE_URL: str = os.getenv("API_BASE_URL", "http://localhost:8000")

# Email channel — attachments
EMAIL_ATTACHMENT_STORAGE_PATH: str = os.getenv("EMAIL_ATTACHMENT_STORAGE_PATH", "./uploads/email-attachments")
EMAIL_ATTACHMENT_MAX_MB: int = int(os.getenv("EMAIL_ATTACHMENT_MAX_MB", "10"))

# Email channel — identity verification
USE_MOCK_EMAIL_VERIFY: bool = os.getenv("USE_MOCK_EMAIL_VERIFY", "true").lower() == "true"
EMAIL_VERIFICATION_EXPIRY_HOURS: int = int(os.getenv("EMAIL_VERIFICATION_EXPIRY_HOURS", "24"))

# Email channel — CSAT
CSAT_TOKEN_SECRET: str = os.getenv("CSAT_TOKEN_SECRET", "dev-csat-secret-change-in-prod")
