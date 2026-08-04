"""The handoff draft is one capability, not the destination of every command.

d9f92b1 hardcoded requestMode='agent_prompt' in the stage submit path, so every
bubble command became a codex handoff draft and the whole normal routing chain
became unreachable. Every automated test stayed green while all four real-machine
scenarios failed. These are the nails for that contract.
"""

from __future__ import annotations

from pathlib import Path

from scripts.selection_bridge import _agent_handoff_requested


def test_plain_commands_do_not_become_agent_handoffs() -> None:
    for command in (
        "OCR一下",
        "把这段改得更正式",
        "框起来",
        "翻译成英文",
        "这张表放进 excel",
        "总结三点",
    ):
        assert _agent_handoff_requested({"command": command, "requestMode": "auto"}) is False, command


def test_explicit_handoff_phrases_route_to_the_draft() -> None:
    for command in (
        "让 codex 修这个报错",
        "让claude看看这段",
        "交给 agent 处理",
        "send to codex and fix the failing test",
    ):
        assert _agent_handoff_requested({"command": command, "requestMode": "auto"}) is True, command


def test_explicit_request_mode_still_wins() -> None:
    assert _agent_handoff_requested({"command": "OCR一下", "requestMode": "agent_prompt"}) is True


def test_missing_request_mode_defaults_to_routing_not_handoff() -> None:
    assert _agent_handoff_requested({"command": "OCR一下"}) is False


def test_stage_submit_path_does_not_hardcode_agent_prompt() -> None:
    """Guard the exact regression: main.js must not force the handoff mode."""
    main_js = (Path(__file__).resolve().parents[1] / "electron" / "main.js").read_text(encoding="utf-8")
    assert "requestMode: 'agent_prompt'," not in main_js
    assert "payload?.requestMode === 'agent_prompt' ? 'agent_prompt' : 'auto'" in main_js
