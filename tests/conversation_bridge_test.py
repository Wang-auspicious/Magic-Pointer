from __future__ import annotations

from scripts import conversation_bridge


def test_answer_conversation_uses_bounded_history(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_ask(prompt: str, **kwargs: object) -> str:
        captured["prompt"] = prompt
        captured.update(kwargs)
        return "这是继续回答。"

    monkeypatch.setattr(conversation_bridge, "ask_text_model", fake_ask)
    result = conversation_bridge.answer_conversation(
        "再解释一下 200ms 的来源",
        [{"question": "这个数是什么？", "answer": "这是硬超时兜底。"}],
        {"app": "VS Code", "label": "uia_text_adapter.py"},
    )

    assert result["ok"] is True
    assert result["answer"] == "这是继续回答。"
    assert result["usedBackend"] == "app.ai_client.ask_text_model"
    assert "VS Code" in str(captured["context_text"])
    assert "硬超时兜底" in str(captured["context_text"])


def test_answer_conversation_rejects_empty_question() -> None:
    result = conversation_bridge.answer_conversation("  ", [], {})
    assert result == {"ok": False, "error": "问题不能为空。"}
