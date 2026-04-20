"""FastAPI application entry point."""
import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from config import settings
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from api.routes.auth import router as auth_router
from api.routes.chat import router as chat_router
from api.routes.copilot import router as copilot_router
from api.routes.dashboard import router as dashboard_router
from api.routes.email import router as email_router
from api.routes.knowledge import router as knowledge_router
from api.routes.studio import router as studio_router
from api.routes.notifications import router as notifications_router
from db.conversation_store import init_db
from engine.auto_transitions import start_auto_transition_loop
from engine.report_sender import start_report_scheduler_loop


def _activate_gmail_watch() -> None:
    """
    Tell Gmail to push new-email notifications to our Pub/Sub topic.
    Watch expires after 7 days — this is called on every server start so
    a redeploy within 7 days keeps it alive. Also called by GET /email/renew-watch.
    No-op in mock mode (GMAIL_CREDENTIALS_JSON is empty).
    """
    if not settings.GMAIL_CREDENTIALS_JSON or settings.GMAIL_CREDENTIALS_JSON == "{}":
        return
    try:
        from api.routes.email import _get_gmail_service
        service = _get_gmail_service()
        result = service.watch(settings.GOOGLE_PUBSUB_TOPIC)
        import logging
        logging.getLogger(__name__).info(
            "Gmail watch activated — historyId=%s expiration=%s",
            result.get("historyId"), result.get("expiration"),
        )
        # Store historyId so the webhook can catch emails that arrived before
        # the first Pub/Sub notification after a server restart
        from api.routes.email import set_last_history_id
        from db.conversation_store import get_gmail_history_cursor, set_gmail_history_cursor
        if result.get("historyId"):
            history_id_str = str(result["historyId"])
            set_last_history_id(history_id_str)
            # Only seed the DB cursor if it's not already set — don't overwrite
            # a valid bookmark with the watch() historyId (which is always "latest")
            if not get_gmail_history_cursor():
                set_gmail_history_cursor(history_id_str)
    except Exception:
        import logging
        logging.getLogger(__name__).warning(
            "Gmail watch() failed — email channel will not receive push notifications",
            exc_info=True,
        )


async def _email_safety_net_loop() -> None:
    """Run the email safety-net scanner every 5 minutes."""
    import logging
    log = logging.getLogger(__name__)
    # Wait 60s after startup before the first run (let the server fully initialize)
    await asyncio.sleep(60)
    while True:
        try:
            from api.routes.email import run_email_safety_net
            await run_email_safety_net()
        except Exception:
            log.exception("Email safety-net loop error")
        await asyncio.sleep(5 * 60)  # 5 minutes


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    asyncio.create_task(start_auto_transition_loop())
    asyncio.create_task(_email_safety_net_loop())
    asyncio.create_task(start_report_scheduler_loop())
    asyncio.create_task(asyncio.to_thread(_activate_gmail_watch))
    yield


app = FastAPI(
    title="CS Bot API",
    description="AI Customer Support Agent — Freedom Platform & Bitazza Exchange",
    version="1.0.0",
    lifespan=lifespan,
)

_raw_origins = os.getenv(
    "ALLOWED_ORIGINS",
    "https://dashboard-nine-zeta-63.vercel.app,http://localhost:3001,http://localhost:3002,http://localhost:5173",
)
_allowed_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(chat_router)
app.include_router(copilot_router)
app.include_router(dashboard_router)
app.include_router(email_router)
app.include_router(knowledge_router)
app.include_router(studio_router)
app.include_router(notifications_router)

# Mount mock User/KYC API and token issuer only in development
if settings.USE_MOCK_USER_API:
    from engine.mock_api.router import router as mock_user_router
    from engine.mock_api.auth import router as mock_auth_router
    app.include_router(mock_user_router)
    app.include_router(mock_auth_router)

_assets_dir = Path(__file__).parent.parent / "engine" / "assets"
app.mount("/assets", StaticFiles(directory=_assets_dir), name="assets")

_uploads_dir = Path(__file__).parent.parent / "uploads"
_uploads_dir.mkdir(exist_ok=True)
app.mount("/uploads", StaticFiles(directory=_uploads_dir), name="uploads")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/email/renew-watch")
def renew_gmail_watch():
    """Manually renew Gmail push watch. Call this if watch expires between deploys."""
    _activate_gmail_watch()
    return {"ok": True}
