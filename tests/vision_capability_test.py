from __future__ import annotations

from app.ai_client import (
    classify_vision_capability,
    get_vision_base_url,
    get_vision_key,
    get_vision_model,
)


def test_deepseek_family_is_text_only() -> None:
    assert classify_vision_capability("deepseek-v4-flash") is False
    assert classify_vision_capability("deepseek-v4-pro") is False
    assert classify_vision_capability("deepseek-chat") is False


def test_glm5_non_v_is_text_only_but_glm5v_is_not() -> None:
    assert classify_vision_capability("glm-5.1") is False
    assert classify_vision_capability("glm-5.2") is False
    assert classify_vision_capability("glm-5") is False
    assert classify_vision_capability("glm-5v-turbo") is not False
    assert classify_vision_capability("glm-4.6v") is not False


def test_kimi_k2_hyphen_text_only_k3_vision() -> None:
    assert classify_vision_capability("kimi-k2-turbo-preview") is False
    assert classify_vision_capability("kimi-k3") is True
    assert classify_vision_capability("kimi-k2.7-code") is True


def test_qwen_plus_line_is_vision() -> None:
    assert classify_vision_capability("qwen3.7-plus") is True
    assert classify_vision_capability("qwen3.8-max") is True
    assert classify_vision_capability("qwen3-coder") is False


def test_unknown_models_are_never_refused() -> None:
    assert classify_vision_capability("gpt-4o") is None
    assert classify_vision_capability("grok-4.5") is None
    assert classify_vision_capability("") is None
    assert classify_vision_capability("some-custom-vlm") is None


def test_hy3_is_text_only() -> None:
    assert classify_vision_capability("hy3") is False


def test_case_insensitive() -> None:
    assert classify_vision_capability("DeepSeek-V4-Flash") is False
    assert classify_vision_capability("QWEN3.7-PLUS") is True


def test_vision_model_override_precedence(monkeypatch) -> None:
    monkeypatch.setenv("MAGIC_POINTER_DISABLE_LOCAL_SECRETS", "1")
    assert get_vision_model("deepseek-v4-flash") == "deepseek-v4-flash"
    monkeypatch.setenv("MAGIC_POINTER_VISION_MODEL", "qwen3.7-plus")
    assert get_vision_model("deepseek-v4-flash") == "qwen3.7-plus"


def test_vision_base_url_override_precedence(monkeypatch) -> None:
    monkeypatch.setenv("MAGIC_POINTER_DISABLE_LOCAL_SECRETS", "1")
    assert get_vision_base_url("https://opencode.ai/zen/go/v1") == "https://opencode.ai/zen/go/v1"
    monkeypatch.setenv("MAGIC_POINTER_VISION_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
    assert get_vision_base_url("https://opencode.ai/zen/go/v1") == "https://dashscope.aliyuncs.com/compatible-mode/v1"


def test_vision_key_falls_back_to_text_path_key(monkeypatch) -> None:
    monkeypatch.setenv("MAGIC_POINTER_DISABLE_LOCAL_SECRETS", "1")
    assert get_vision_key("text-key") == "text-key"


def test_vision_key_env_override(monkeypatch) -> None:
    monkeypatch.setenv("MAGIC_POINTER_DISABLE_LOCAL_SECRETS", "1")
    monkeypatch.setenv("MAGIC_POINTER_VISION_KEY", "vision-key-env")
    assert get_vision_key("text-key") == "vision-key-env"


def test_vision_key_reads_vision_key_file(tmp_path, monkeypatch) -> None:
    import app.ai_client as ai_client

    secrets_dir = tmp_path / "secrets"
    secrets_dir.mkdir()
    (secrets_dir / "vision_key.txt").write_text("vision-key-file\n", encoding="utf-8")
    monkeypatch.setattr(ai_client, "SECRETS_DIR", secrets_dir)
    assert get_vision_key("text-key") == "vision-key-file"


def test_read_local_secret_tolerates_utf8_bom(tmp_path, monkeypatch) -> None:
    import app.ai_client as ai_client

    secrets_dir = tmp_path / "secrets"
    secrets_dir.mkdir()
    # PowerShell 5.1 Set-Content -Encoding UTF8 writes a BOM; the value must survive.
    (secrets_dir / "vision_model.txt").write_bytes(b"\xef\xbb\xbfgemini-2.5-flash")
    monkeypatch.setattr(ai_client, "SECRETS_DIR", secrets_dir)
    assert ai_client.read_local_secret("vision_model.txt") == "gemini-2.5-flash"
