"""模型目录（DSH ui-model-selection 的 MP 等价物）。

目录从真实网关来：优先 ``GET {base_url}/models``（OpenAI 兼容网关都有），
失败时诚实回落到当前配置的单条目。切换写 ``secrets/model.txt``——全栈
（ai_client/loop/视觉链）消费的同一份配置，不是渲染层自己的状态。
"""

from __future__ import annotations

from pathlib import Path

import app.ai_client as ai_client
from app.models_catalog import list_models, provider_label, select_model


class _FakeResponse:
    def __init__(self, payload: dict, status: int = 200) -> None:
        self._payload = payload
        self.status_code = status

    def json(self) -> dict:
        return self._payload


def _configured(monkeypatch, base_url="https://opencode.ai/zen/go/v1", model="deepseek-v4-flash"):
    monkeypatch.setattr(ai_client, "read_local_secret", lambda name: {"openai_base_url.txt": base_url, "model.txt": model}.get(name))
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("MAGIC_POINTER_MODEL", raising=False)
    monkeypatch.delenv("MAGIC_POINTER_VISION_MODEL", raising=False)
    monkeypatch.setattr(ai_client, "get_vision_model", lambda text: "gemini-2.5-flash")


def test_provider_label_from_base_url() -> None:
    assert provider_label("https://opencode.ai/zen/go/v1") == "opencode.ai"
    assert provider_label("https://api.groq.com/openai/v1") == "api.groq.com"
    assert provider_label(None) == "本地"


def test_list_models_from_gateway(monkeypatch) -> None:
    _configured(monkeypatch)
    seen: dict = {}

    def fake_get(url, headers=None, timeout=None):  # noqa: ANN001
        seen["url"] = url
        return _FakeResponse({"data": [{"id": "deepseek-v4-flash"}, {"id": "kimi-k3"}, {"id": "qwen3.7-plus"}]})

    monkeypatch.setattr("app.models_catalog._http_get_models", fake_get)
    catalog = list_models()
    assert seen["url"].endswith("/models")
    assert catalog["source"] == "gateway"
    assert catalog["current"] == "deepseek-v4-flash"
    assert catalog["visionModel"] == "gemini-2.5-flash"
    group = catalog["groups"][0]
    assert group["id"] == "opencode.ai"
    assert [m["id"] for m in group["models"]] == ["deepseek-v4-flash", "kimi-k3", "qwen3.7-plus"]
    assert [m["contextWindow"] for m in group["models"]] == [128_000, 256_000, 128_000]
    # 目录条目标记视觉档（独立视觉模型不在同组也标出来）
    assert next(m for m in group["models"] if m["id"] == "deepseek-v4-flash")["vision"] is False


def test_list_models_falls_back_to_config_on_gateway_failure(monkeypatch) -> None:
    _configured(monkeypatch)

    def boom(url, headers=None, timeout=None):  # noqa: ANN001
        raise RuntimeError("network down")

    monkeypatch.setattr("app.models_catalog._http_get_models", boom)
    catalog = list_models()
    assert catalog["source"] == "config"
    assert catalog["current"] == "deepseek-v4-flash"
    assert [m["id"] for m in catalog["groups"][0]["models"]] == ["deepseek-v4-flash"]
    assert catalog["error"]  # 诚实带上失败原因


def test_select_model_writes_secret_and_refuses_env_override(monkeypatch, tmp_path) -> None:
    _configured(monkeypatch)
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    monkeypatch.setattr("app.models_catalog.SECRETS_DIR", secrets)
    monkeypatch.setattr("app.models_catalog.USER_SECRETS_DIR", None)

    result = select_model("kimi-k3")
    assert result["ok"] is True
    assert (secrets / "model.txt").read_text(encoding="utf-8").strip() == "kimi-k3"

    monkeypatch.setenv("MAGIC_POINTER_MODEL", "env-wins")
    refused = select_model("kimi-k3")
    assert refused["ok"] is False
    assert "环境变量" in refused["error"]


def test_select_model_rejects_blank(monkeypatch, tmp_path) -> None:
    _configured(monkeypatch)
    result = select_model("   ")
    assert result["ok"] is False


def test_select_model_creates_user_data_secrets_dir_and_writes_there(monkeypatch, tmp_path) -> None:
    """安装版常态:开发树 secrets 不进包;写入必须落在 MAGIC_POINTER_USER_DATA_DIR
    下的 secrets(与 ai_client.read_local_secret 的读取候选链同一处),目录不存在就创建。"""
    _configured(monkeypatch)
    dev_secrets = tmp_path / "app-bundle" / "secrets"  # 不存在(安装包里没有)
    monkeypatch.setattr("app.models_catalog.SECRETS_DIR", dev_secrets)
    user_data = tmp_path / "UserData" / "Magic Pointer"
    monkeypatch.setattr("app.models_catalog.USER_SECRETS_DIR", user_data / "secrets")

    result = select_model("kimi-k3")
    assert result["ok"] is True, result
    written = user_data / "secrets" / "model.txt"
    assert written.is_file(), "user secrets dir must be created on write"
    assert written.read_text(encoding="utf-8").strip() == "kimi-k3"
    assert result["path"] == str(written)


def test_select_model_prefers_dev_tree_secrets_when_present(monkeypatch, tmp_path) -> None:
    _configured(monkeypatch)
    dev_secrets = tmp_path / "dev" / "secrets"
    dev_secrets.mkdir(parents=True)
    monkeypatch.setattr("app.models_catalog.SECRETS_DIR", dev_secrets)
    user_secrets = tmp_path / "user" / "secrets"
    user_secrets.mkdir(parents=True)
    monkeypatch.setattr("app.models_catalog.USER_SECRETS_DIR", user_secrets)

    result = select_model("deepseek-v4-flash")
    assert result["ok"] is True
    assert (dev_secrets / "model.txt").read_text(encoding="utf-8").strip() == "deepseek-v4-flash"
    assert not (user_secrets / "model.txt").exists()
