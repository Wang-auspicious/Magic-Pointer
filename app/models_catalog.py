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
# 与 ai_client.read_local_secret 的读取候选链保持同一处:安装版里主进程传
# MAGIC_POINTER_USER_DATA_DIR(sync 把本机 secrets 放在 %LOCALAPPDATA% 下的
# 用户数据目录),开发树则直接写 ROOT/secrets。
USER_SECRETS_DIR = (
    Path(os.environ["MAGIC_POINTER_USER_DATA_DIR"]) / "secrets"
    if os.environ.get("MAGIC_POINTER_USER_DATA_DIR")
    else None
)

GATEWAY_TIMEOUT_S = 5.0


def _http_get_models(url: str, headers: dict | None = None, timeout: float | None = None):
    """GET ``{base_url}/models``。独立函数便于测试替换。"""
    import httpx

    return httpx.get(url, headers=headers, timeout=timeout)


def provider_label(base_url: str | None) -> str:
    url = urlsplit(str(base_url or ""))
    host = url.hostname or ""
    if host == "opencode.ai":
        service = url.path.strip("/").split("/", 1)[0]
        if service in {"go", "zen"}:
            return f"opencode-{service}"
    return host or "本地"


def _gateway_models(
    base_url: str,
    api_key: str | None,
    timeout_s: float,
    api_mode: str | None = None,
) -> list[dict]:
    mode = str(api_mode or "").strip().casefold()
    if mode == "messages":
        # Anthropic's Messages API exposes its model list under /v1/models,
        # while a configured base URL is often just https://api.anthropic.com.
        base = base_url.rstrip("/")
        url = base if base.endswith("/v1") else f"{base}/v1"
        url += "/models"
    else:
        url = base_url.rstrip("/") + "/models"
    headers = ai_client._completion_headers(api_key, mode, base_url=base_url)
    response = _http_get_models(url, headers=headers, timeout=timeout_s)
    if response.status_code != 200:
        raise RuntimeError(f"gateway /models HTTP {response.status_code}")
    payload = response.json()
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise RuntimeError("gateway /models missing data array")
    return [dict(row, id=str(row["id"]).strip()) for row in rows
            if isinstance(row, dict) and str(row.get("id") or "").strip()]


def list_models(timeout_s: float = GATEWAY_TIMEOUT_S) -> dict:
    """当前网关的模型目录（DSH provider group 形状）。

    - ``source``: ``gateway``（/models 成功）或 ``config``（回落到当前配置）；
    - ``groups``: 当前服务商模型，文字和图像共用用户选中的模型。
    """
    api_key, base_url, model = ai_client.get_ai_config()
    provider = provider_label(base_url)

    entries: list[dict] = []
    source = "config"
    error = ""
    declared = ai_client.get_ai_model_catalog()
    if declared:
        entries = declared
        source = "profile"
    elif base_url:
        try:
            entries = _gateway_models(
                base_url,
                api_key,
                timeout_s,
                ai_client.get_ai_api_mode(base_url),
            )
            source = "gateway"
        except Exception as exc:  # noqa: BLE001 - 目录失败回落到配置，不阻断 UI
            error = f"网关模型列表不可用：{exc}"
    by_id = {str(item.get("id") or item.get("model") or "").strip(): item for item in entries}
    by_id.pop("", None)
    if model not in by_id:
        by_id = {model: {}, **by_id}
    entries = [{
        "id": name,
        "vision": bool(item.get("vision", False)),
        "contextWindow": ai_client.get_ai_context_window(name, item),
    } for name, item in by_id.items()]

    return {
        "ok": True,
        "current": model,
        "provider": provider,
        "source": source,
        "error": error,
        "groups": [{"id": provider, "name": provider, "models": entries}],
    }


def _secret_write_path() -> Path | None:
    """与 ai_client 的读取顺序一致:开发树 secrets 优先,其次用户数据目录。

    用户目录不存在不算失败——写入本来就意味着创建它;只有连候选都没有
    (既不在开发树、也没有 MAGIC_POINTER_USER_DATA_DIR)才返回 None。
    """
    if SECRETS_DIR.is_dir():
        return SECRETS_DIR / "model.txt"
    if USER_SECRETS_DIR is not None:
        return USER_SECRETS_DIR / "model.txt"
    return None


def select_model(model_id: str) -> dict:
    """把默认模型写到 ``secrets/model.txt``（全栈消费的那份配置）。"""
    name = str(model_id or "").strip()
    # Provider-qualified ids (for example ``openai/gpt-oss-120b``) are valid
    # catalog values and must survive selection. The value is written as file
    # content, so slash is not a path traversal concern; reject only characters
    # that could corrupt the one-line settings file.
    if not name or "\\" in name or any(ord(char) < 32 for char in name):
        return {"ok": False, "error": "模型名不能为空。"}
    if os.getenv("MAGIC_POINTER_MODEL"):
        return {"ok": False, "error": "环境变量 MAGIC_POINTER_MODEL 在优先级上覆盖文件，改文件不会生效；请先 unset。"}
    target = _secret_write_path()
    if target is None:
        return {"ok": False, "error": "没有可写的 secrets 目录（开发树不存在，且未设置 MAGIC_POINTER_USER_DATA_DIR）。"}
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(name + "\n", encoding="utf-8")
    except OSError as exc:
        return {"ok": False, "error": f"secrets 写入失败（{target.parent}）：{exc}"}
    return {"ok": True, "model": name, "path": str(target)}
