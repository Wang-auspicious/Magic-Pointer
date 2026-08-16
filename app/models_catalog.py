"""模型目录：DSH ui-model-selection 的 MP 等价物。

目录从真实网关来：优先 ``GET {base_url}/models``（OpenAI 兼容网关都有），
失败时诚实回落到当前配置的单条目并把原因带回去。切换写
``secrets/model.txt``——ai_client/loop/视觉链消费的同一份配置，不是渲染层
自己的状态；``MAGIC_POINTER_MODEL`` 环境变量在场时写入无效，拒绝而不是装成功。
"""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlsplit

from app import ai_client

__all__ = ["list_models", "provider_label", "select_model"]

ROOT = Path(__file__).resolve().parents[1]
SECRETS_DIR = ROOT / "secrets"
USER_SECRETS_DIR = (
    Path(os.environ.get("MAGIC_POINTER_USER_SECRETS_DIR") or Path.home() / ".magic-pointer" / "secrets")
    if os.name == "nt"
    else None
)

GATEWAY_TIMEOUT_S = 5.0


def _http_get_models(url: str, headers: dict | None = None, timeout: float | None = None):
    """GET ``{base_url}/models``。独立函数便于测试替换。"""
    import httpx

    return httpx.get(url, headers=headers, timeout=timeout)


def provider_label(base_url: str | None) -> str:
    host = urlsplit(str(base_url or "")).hostname or ""
    return host or "本地"


def _gateway_models(base_url: str, api_key: str | None, timeout_s: float) -> list[str]:
    url = base_url.rstrip("/") + "/models"
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    response = _http_get_models(url, headers=headers, timeout=timeout_s)
    if response.status_code != 200:
        raise RuntimeError(f"gateway /models HTTP {response.status_code}")
    payload = response.json()
    rows = payload.get("data") if isinstance(payload, dict) else None
    names = [str(row.get("id")).strip() for row in rows if isinstance(row, dict) and row.get("id")]
    return [name for name in names if name]


def list_models(timeout_s: float = GATEWAY_TIMEOUT_S) -> dict:
    """当前网关的模型目录（DSH provider group 形状）。

    - ``source``: ``gateway``（/models 成功）或 ``config``（回落到当前配置）；
    - ``groups``: 单组（文本网关）；``vision`` 标记该模型是否视觉档；
    - 独立视觉模型作为 ``visionModel`` 字段带出（它可能在不同网关上）。
    """
    api_key, base_url, model = ai_client.get_ai_config()
    vision_model = ai_client.get_vision_model(model)
    provider = provider_label(base_url)

    entries: list[dict] = []
    source = "config"
    error = ""
    if base_url:
        try:
            names = _gateway_models(base_url, api_key, timeout_s)
            if model not in names:
                names.insert(0, model)
            entries = [{"id": name, "vision": name == vision_model} for name in names]
            source = "gateway"
        except Exception as exc:  # noqa: BLE001 - 目录失败回落到配置，不阻断 UI
            error = f"网关模型列表不可用：{exc}"
    if not entries:
        entries = [{"id": model, "vision": model == vision_model}]

    return {
        "ok": True,
        "current": model,
        "visionModel": vision_model,
        "provider": provider,
        "source": source,
        "error": error,
        "groups": [{"id": provider, "name": provider, "models": entries}],
    }


def _secret_write_path() -> Path | None:
    if SECRETS_DIR.is_dir():
        return SECRETS_DIR / "model.txt"
    if USER_SECRETS_DIR is not None and USER_SECRETS_DIR.is_dir():
        return USER_SECRETS_DIR / "model.txt"
    return None


def select_model(model_id: str) -> dict:
    """把默认模型写到 ``secrets/model.txt``（全栈消费的那份配置）。"""
    name = str(model_id or "").strip()
    if not name or "/" in name or "\\" in name:
        return {"ok": False, "error": "模型名不能为空。"}
    if os.getenv("MAGIC_POINTER_MODEL"):
        return {"ok": False, "error": "环境变量 MAGIC_POINTER_MODEL 在优先级上覆盖文件，改文件不会生效；请先 unset。"}
    target = _secret_write_path()
    if target is None:
        return {"ok": False, "error": "没有可写的 secrets 目录（开发树或用户数据目录均不存在）。"}
    target.write_text(name + "\n", encoding="utf-8")
    return {"ok": True, "model": name}
