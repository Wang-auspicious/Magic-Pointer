from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

from app.ai_client import _httpx_client


def test_httpx_client_survives_invalid_no_proxy() -> None:
    original = os.environ.get("NO_PROXY")
    try:
        os.environ["NO_PROXY"] = "::1"
        with _httpx_client(httpx, timeout=1) as client:
            assert isinstance(client, httpx.Client)
    finally:
        if original is None:
            os.environ.pop("NO_PROXY", None)
        else:
            os.environ["NO_PROXY"] = original
