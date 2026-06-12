"""
Local conftest for smoke tests — loads the real .env BEFORE the root conftest.py
sets the fake GEMINI_API_KEY via setdefault.

pytest loads conftest.py files top-down (root first), but a file named
conftest_smoke.py is NOT auto-loaded. Instead, the smoke test imports it
explicitly at the top of the file before any engine imports.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

_env_path = Path(__file__).parent.parent / ".env"
load_dotenv(dotenv_path=_env_path, override=True)
