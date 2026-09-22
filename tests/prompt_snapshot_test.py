
import asyncio
import hashlib
import json

import pytest

from app.agent_runtime.loop import LoopParams, LoopStopped, run_agent_loop
from app.agent_runtime.model_client import LoopModelClient, TurnDone
from app.agent_runtime.session import FileSessionStore, _canonical_bytes
from app.agent_runtime.system_prompt import Section, SystemPromptBuilder
from app.agent_runtime.token_estimate import estimate_request_tokens
from app.agent_runtime.tool_registry import ToolRegistry
from app.harness import builtin_bundle


def _hash(text):
    return hashlib.sha256(_canonical_bytes(text)).hexdigest()


def test_build_retains_rendered_section_identity_and_exact_text():
    rendered = []
    builder = SystemPromptBuilder()
    builder.add(Section("identity", "Identity", lambda ctx: " stable "))
    builder.add(Section("empty", "Empty", lambda ctx: "  "))

    def rules(ctx):
        rendered.append(ctx["rules"])
        return ctx["rules"]

    builder.add(Section("rules", "System", rules))
    first = builder.build({"rules": "old"})
    second = builder.build({"rules": "new"})

    assert first.text == "# Identity\nstable\n\n# System\nold"
    assert first.sections == (
        ("identity", _hash("# Identity\nstable")),
        ("rules", _hash("# System\nold")),
    )
    assert second.sections[0] == first.sections[0]
    assert second.sections[1] != first.sections[1]
    assert rendered == ["old", "new"]


def test_request_records_actual_prompt_hash_and_sections_without_rejecting(tmp_path):
    session = FileSessionStore(tmp_path).create("request")
    section_hashes = [["rules", _hash("# System\nold")]]
    session.start_turn()
    request = session.record_model_request(
        [], tools=[], step=1,
        header={"systemPrompt": "# System\nold", "systemPromptHash": "stale",
                "systemPromptSections": section_hashes},
    )
    assert request.data["systemPromptHash"] == _hash("# System\nold")
    assert request.data["systemPromptSections"] == section_hashes
    assert request.data["messagesHash"] == _hash([])


@pytest.mark.parametrize("resident", [False, True], ids=["cold", "resident"])
def test_resume_after_prompt_edit_uses_old_snapshot(tmp_path, monkeypatch, caplog, resident):
    version = {"rules": "old rules"}
    render_calls = []
    received = []

    def rules(ctx):
        render_calls.append(version["rules"])
        return version["rules"]

    monkeypatch.setattr(builtin_bundle, "default_sections", lambda: [
        Section("identity", "Identity", lambda ctx: "stable"),
        Section("rules", "System", rules),
    ])
    monkeypatch.setattr("app.ai_client.get_ai_config", lambda: ("", "", "fixture"))
    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("MAGIC_POINTER_BACKGROUND_REVIEW", "0")

    class Backend:
        def __init__(self, system_prompt):
            self.system_prompt = system_prompt

        def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
            received.append(self.system_prompt)
            yield TurnDone(usage=None, raw_text="done")

    def create_client(self, *, system_prompt, max_tokens, effort):
        return LoopModelClient(Backend(system_prompt))

    monkeypatch.setattr(builtin_bundle._MessagesLlmProvider, "create_client", create_client)
    runtime = {"session_id": "prompt-resume", "summarize": lambda text: text}

    def open_context():
        if resident:
            host = builtin_bundle.LoopHarnessHost(root=tmp_path, plugin_dir=tmp_path / "plugins")
            scope = host.open(runtime)
            return scope.ctx, lambda: (scope.close(), host.close())
        report = builtin_bundle.boot_loop_context(runtime, root=tmp_path)
        return report.ctx, report.ctx.unload

    def run(ctx):
        session = ctx.get("sessions").open_or_create("prompt-resume")

        async def collect():
            return [event async for event in run_agent_loop(LoopParams(
                user_input="continue", registry=ToolRegistry(),
                client=ctx.get("model_client"), session=session,
                request_header=ctx.get("model_request_header"),
            ))]

        assert isinstance(asyncio.run(collect())[-1], LoopStopped)
        return session

    first, close = open_context()
    try:
        run(first)
        old_text = received[-1]
        version["rules"] = "new rules that must not replace the saved prompt"
        run(first)
        assert render_calls == ["old rules"]
        assert received[-1] == old_text
    finally:
        close()

    resumed, close = open_context()
    try:
        session = run(resumed)
        assert received[-1] == old_text
        assert render_calls == ["old rules", version["rules"]]
        assert resumed.get("token_estimator")([]) == estimate_request_tokens(
            [], system_prompt=old_text,
        )
        requests = [e for e in session.events if e.type == "model/request"]
        assert all(e.data["systemPromptHash"] == _hash(old_text) for e in requests)
        assert all(e.data["systemPromptSections"] == requests[0].data["systemPromptSections"]
                   for e in requests)
        drift = [e for e in session.events if e.type == "prompt/drift"]
        assert len(drift) == 1
        assert drift[0].data["changedSections"] == ["rules"]
        assert drift[0].data["savedHash"] == _hash(old_text)
        assert drift[0].data["currentHash"] != _hash(old_text)
        assert "Using the saved system prompt" in caplog.text
        assert len([e for e in session.events if e.type == "prompt/frozen"]) == 1
        persisted = [json.loads(line) for line in session.path.read_text(encoding="utf-8").splitlines()]
        assert [e for e in persisted if e["type"] == "model/request"][-1]["data"] == requests[-1].data
    finally:
        close()


def test_freeze_before_first_request_and_resume_without_drift(tmp_path):
    store = FileSessionStore(tmp_path)
    session = store.create("before-model")
    selected = session.freeze_system_prompt("old", (("rules", _hash("old")),))
    restored = store.resume(session.id).freeze_system_prompt("old", (("rules", _hash("old")),))
    assert selected == restored
    assert len(store.resume(session.id).events) == 2
    changed = store.resume(session.id).freeze_system_prompt("new", (("rules", _hash("new")),))
    assert changed == selected


def test_old_request_preserves_text_and_marks_missing_section_ledger(tmp_path, caplog):
    store = FileSessionStore(tmp_path)
    session = store.create("old-format")
    turn = session.start_turn()
    session.append("model/request", {
        "turn": turn, "step": 1, "messageCount": 0,
        "messagesHash": _hash([]), "tools": [],
        "header": {"systemPrompt": "historical prompt"},
    })
    session.end_turn(turn, reason="completed")
    restored = store.resume(session.id)
    selected = restored.freeze_system_prompt("new", (("rules", _hash("new")),))
    assert selected["systemPrompt"] == "historical prompt"
    assert selected["systemPromptSections"] is None
    assert "section ledger is unavailable" in caplog.text


def test_old_session_without_prompt_is_explicitly_marked(tmp_path, caplog):
    session = FileSessionStore(tmp_path).create("missing-prompt")
    turn = session.start_turn()
    session.end_turn(turn, reason="interrupted")
    selected = session.freeze_system_prompt("current", ())
    assert selected["systemPrompt"] == "current"
    assert "No saved system prompt" in caplog.text
    assert any(e.type == "prompt/missing" for e in session.events)
