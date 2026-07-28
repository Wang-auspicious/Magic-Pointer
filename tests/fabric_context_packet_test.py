from __future__ import annotations

import json
import subprocess
from pathlib import Path

from app.fabric.capture_policy import CaptureDecision
from app.fabric.context_packet import (
    ContextPacketBuilder,
    build_agent_prompt,
    write_context_packet_artifact,
)


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        encoding="utf-8",
    )


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    _git(repo, "config", "user.email", "pointer@example.test")
    _git(repo, "config", "user.name", "Magic Pointer Test")
    (repo / "app.py").write_text("print('first')\n", encoding="utf-8")
    _git(repo, "add", "app.py")
    _git(repo, "commit", "-m", "initial")
    (repo / "app.py").write_text("print('changed')\n", encoding="utf-8")
    return repo


def _screen(image: Path) -> dict:
    return {
        "id": "screen-1",
        "kind": "screen_region",
        "label": "THIS · broken save button",
        "content": "Save button overlaps the footer",
        "bbox": [10, 20, 300, 240],
        "elements": [{"role": "button", "name": "Save", "bbox": [20, 30, 90, 55]}],
        "source": {
            "app": "code.exe",
            "title": "app.py - Visual Studio Code",
            "hwnd": 42,
            "processId": 314,
            "path": str(image),
            "screenshotPath": str(image),
            "url": "",
        },
    }


def _decision(mode: str, *, upload: bool) -> CaptureDecision:
    return CaptureDecision(
        object_id="screen-1",
        configured_mode=mode,
        mode=mode,
        allow_structure=mode != "deny",
        allow_local_pixels=mode not in {"deny", "structured_only"},
        allow_upload=upload,
        reason="test",
    )


def _lease() -> dict:
    return {
        "schemaVersion": 1,
        "leaseId": "lease-1",
        "expiresAt": "2026-07-26T10:00:00+00:00",
        "objectFingerprint": "abc",
        "requiresLiveValidation": True,
        "window": {"hwnd": 42, "processId": 314},
    }


def test_packet_contains_repo_scope_and_omits_withheld_image(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    image = tmp_path / "capture.png"
    image.write_bytes(b"pixels")
    packet = ContextPacketBuilder().build(
        command="让 Codex 修这个界面",
        recipe_id="agent.handoff",
        objects=[_screen(image)],
        cwd=repo,
        target_lease=_lease(),
        capture_decisions=[_decision("structured_only", upload=False)],
        capabilities=[{"id": "agent.handoff", "title": "Agent 现场交付"}],
        terminal_excerpt="npm test\n1 failed",
        attachments=[str(image), str(repo / "app.py")],
    )

    encoded = json.dumps(packet, ensure_ascii=False)
    assert packet["schemaVersion"] == 2
    assert packet["workspace"]["cwd"] == str(repo.resolve())
    assert packet["workspace"]["repoRoot"] == str(repo.resolve())
    assert packet["workspace"]["branch"] == "main"
    assert packet["workspace"]["isDirty"] is True
    assert "app.py" in packet["workspace"]["changedFiles"]
    assert "capture.png" not in encoded
    assert "screenshotPath" not in encoded
    assert packet["objects"][0]["content"] == "Save button overlaps the footer"
    assert packet["artifacts"] == [str((repo / "app.py").resolve())]
    assert packet["runtime"]["terminalExcerpt"] == "npm test\n1 failed"


def test_packet_preserves_bounded_perception_provenance_for_agent(tmp_path: Path) -> None:
    image = tmp_path / "capture.png"
    image.write_bytes(b"pixels")
    pointed = _screen(image)
    pointed["source"]["perceptionTrace"] = {
        "schemaVersion": 1,
        "selectedLayer": "uia",
        "selectedAdapter": "uia_text_selection",
        "selectedMethod": "uia:element-from-point",
        "pixelFallbackUsed": False,
        "fallbackReason": None,
        "policyMode": "structured_only",
        "attempts": [{
            "layer": "uia",
            "adapter": "uia_text_selection",
            "method": "uia:element-from-point",
            "status": "succeeded",
            "reason": "structured_context_available",
            "privateTitle": "must-drop",
        }],
        "privateTitle": "must-drop",
    }

    packet = ContextPacketBuilder().build(
        command="修复这个控件",
        recipe_id="agent.handoff",
        objects=[pointed],
        cwd=tmp_path,
        target_lease=_lease(),
        capture_decisions=[_decision("structured_only", upload=False)],
        capabilities=[],
    )
    trace = packet["objects"][0]["source"]["perceptionTrace"]
    prompt = build_agent_prompt(packet, artifact_path=tmp_path / "packet.json")

    assert trace["selectedLayer"] == "uia"
    assert trace["attempts"][0]["method"] == "uia:element-from-point"
    assert "must-drop" not in json.dumps(trace)
    assert "perception=uia / uia:element-from-point" in prompt


def test_uploadable_packet_keeps_visual_path_in_an_explicit_field(tmp_path: Path) -> None:
    image = tmp_path / "capture.png"
    image.write_bytes(b"pixels")
    packet = ContextPacketBuilder().build(
        command="解释这个布局",
        recipe_id="vision.prompt_bridge",
        objects=[_screen(image)],
        cwd=tmp_path,
        target_lease=_lease(),
        capture_decisions=[_decision("upload_screenshot", upload=True)],
        capabilities=[],
        attachments=[str(image)],
    )
    assert packet["objects"][0]["source"]["visualPaths"] == [str(image.resolve())]
    assert packet["artifacts"] == [str(image.resolve())]
    assert packet["privacy"]["uploadableVisualObjectCount"] == 1


def test_packet_artifact_is_atomic_and_prompt_is_bounded_and_actionable(tmp_path: Path) -> None:
    image = tmp_path / "capture.png"
    image.write_bytes(b"pixels")
    packet = ContextPacketBuilder().build(
        command="让 Pi 在当前项目修这个",
        recipe_id="agent.handoff",
        objects=[_screen(image)],
        cwd=tmp_path,
        target_lease=_lease(),
        capture_decisions=[_decision("structured_only", upload=False)],
        capabilities=[
            {"id": "agent.handoff", "title": "Agent 现场交付", "risk": "external_send"},
            {"id": "vision.prompt_bridge", "title": "视觉桥", "risk": "local_write"},
        ],
        visual_relays=[{
            "schemaVersion": 1,
            "mode": "structured_text",
            "target": {"objectId": "screen-1", "label": "Save", "kind": "ui-control"},
            "grounding": {"ocr": "Save", "role": "button", "hierarchy": ["Settings", "Actions"]},
            "appearance": {"foreground": "#1266D4", "background": "#FFFFFF", "shape": "rounded-rectangle"},
            "spatial": {"relativeToPointer": "under-pointer", "neighbors": ["Cancel is left"]},
            "uncertainty": [],
            "provenance": ["UIA", "RapidOCR"],
            "attachments": [],
            "structuredText": "Control Save; role button; hierarchy Settings > Actions; shape rounded-rectangle.",
        }],
    )
    artifact = write_context_packet_artifact(packet, root=tmp_path)
    prompt = build_agent_prompt(packet, artifact_path=artifact)

    assert artifact.exists()
    assert not artifact.with_suffix(".json.tmp").exists()
    assert json.loads(artifact.read_text(encoding="utf-8"))["packetId"] == packet["packetId"]
    assert str(artifact) in prompt
    assert "agent.handoff" in prompt
    assert "Save button overlaps the footer" in prompt
    assert packet["visualRelays"][0]["mode"] == "structured_text"
    assert "Visual relay for text-only models" in prompt
    assert "rounded-rectangle" in prompt
    assert "Inspect the current workspace" in prompt
    assert len(prompt) < 20_000


def test_denied_object_never_enters_packet(tmp_path: Path) -> None:
    image = tmp_path / "capture.png"
    image.write_bytes(b"pixels")
    packet = ContextPacketBuilder().build(
        command="读取这个",
        recipe_id="ground.this",
        objects=[_screen(image)],
        cwd=tmp_path,
        target_lease=_lease(),
        capture_decisions=[_decision("deny", upload=False)],
        capabilities=[],
    )
    assert packet["objects"] == []
    assert packet["privacy"]["deniedObjectIds"] == ["screen-1"]


def test_terminal_evidence_is_bounded_in_packet_and_agent_prompt(tmp_path: Path) -> None:
    pointed = _screen(tmp_path / "unused.png")
    pointed["kind"] = "native_selection"
    pointed["source"]["app"] = "terminal"
    pointed["source"]["terminalEvidence"] = {
        "schemaVersion": 1,
        "state": "resolved",
        "method": "uia:terminal-text-pattern",
        "capturedAt": "2026-07-27T20:14:04+08:00",
        "timestamp": "2026-07-27T20:14:03+08:00",
        "command": "python verify.py --token secret",
        "exitCode": 7,
        "anchor": {"line": 3, "text": "Error: broken"},
        "window": {
            "startLine": 1,
            "endLine": 5,
            "lineCount": 5,
            "before": "working",
            "error": "Error: broken\nProcess exited with code 7",
            "after": "cleanup",
            "text": "working\nError: broken\nProcess exited with code 7\ncleanup",
        },
        "pixelFallbackUsed": False,
        "uncertainty": [],
        "private": "drop",
    }
    packet = ContextPacketBuilder().build(
        command="fix this terminal error",
        recipe_id="agent.handoff",
        objects=[pointed],
        cwd=tmp_path,
        target_lease=_lease(),
        capture_decisions=[_decision("structured_only", upload=False)],
        capabilities=[],
    )
    evidence = packet["runtime"]["terminalEvidence"]
    prompt = build_agent_prompt(packet, artifact_path=tmp_path / "packet.json")

    assert evidence["method"] == "uia:terminal-text-pattern"
    assert evidence["command"] == "python verify.py --token [redacted]"
    assert evidence["exitCode"] == 7
    assert packet["runtime"]["terminalExcerpt"] == evidence["window"]["text"]
    assert "## Terminal error evidence" in prompt
    assert "exit code: 7" in prompt
    assert "Error: broken" in prompt
    assert "private" not in json.dumps(packet)
    assert "secret" not in json.dumps(packet)


def test_legacy_terminal_excerpt_is_parsed_without_inventing_exit_code(tmp_path: Path) -> None:
    packet = ContextPacketBuilder().build(
        command="fix this failure",
        recipe_id="agent.handoff",
        objects=[_screen(tmp_path / "unused.png")],
        cwd=tmp_path,
        target_lease=_lease(),
        capture_decisions=[_decision("structured_only", upload=False)],
        capabilities=[],
        terminal_excerpt="npm ERR! build failed",
    )
    evidence = packet["runtime"]["terminalEvidence"]
    assert evidence["method"] == "provided_excerpt"
    assert evidence["exitCode"] is None
    assert evidence["state"] == "partial"


def test_browser_context_enters_packet_and_prompt_without_private_fields(tmp_path: Path) -> None:
    pointed = _screen(tmp_path / "unused.png")
    pointed["source"]["app"] = "browser"
    pointed["source"]["browserContext"] = {
        "schemaVersion": 1,
        "state": "resolved",
        "method": "cdp:dom-point",
        "page": {"title": "Checkout", "url": "https://example.test/checkout?token=secret"},
        "node": {"tag": "button", "role": "button", "accessibleName": "Retry payment", "text": "Retry", "attributes": {"data-testid": "retry"}},
        "selector": 'button[data-testid="retry"]',
        "coordinates": {"pointerScreenPhysical": {"x": 640, "y": 520}, "pointerViewportCss": {"x": 500, "y": 240}},
        "networkFailures": [{"url": "https://api.example.test/pay?token=secret", "errorText": "net::ERR_FAILED", "source": "devtools_log"}],
        "provenance": {"endpoint": "http://127.0.0.1:9222", "targetId": "page-1", "structural": True},
        "private": "drop",
    }
    packet = ContextPacketBuilder().build(
        command="fix this browser failure",
        recipe_id="agent.handoff",
        objects=[pointed],
        cwd=tmp_path,
        target_lease=_lease(),
        capture_decisions=[_decision("structured_only", upload=False)],
        capabilities=[],
    )
    browser = packet["runtime"]["browserContext"]
    prompt = build_agent_prompt(packet, artifact_path=tmp_path / "packet.json")

    assert browser["selector"] == 'button[data-testid="retry"]'
    assert browser["node"]["accessibleName"] == "Retry payment"
    assert browser["networkFailures"][0]["errorText"] == "net::ERR_FAILED"
    assert "## Browser DevTools evidence" in prompt
    assert 'button[data-testid="retry"]' in prompt
    assert "net::ERR_FAILED" in prompt
    encoded = json.dumps(packet)
    assert "private" not in encoded
    assert "token=secret" not in encoded


def test_component_source_candidates_enter_packet_and_prompt_with_edit_gate(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    component = repo / "src" / "RetryButton.tsx"
    component.parent.mkdir()
    component.write_text("export function RetryButton() { return <button>Retry</button>; }\n", encoding="utf-8")
    pointed = _screen(tmp_path / "unused.png")
    pointed["source"]["app"] = "browser"
    pointed["source"]["browserContext"] = {
        "schemaVersion": 1,
        "state": "resolved",
        "method": "cdp:dom-point",
        "page": {"title": "Checkout", "url": "http://127.0.0.1:5173/checkout"},
        "node": {"tag": "button", "accessibleName": "Retry payment", "text": "Retry", "attributes": {"data-testid": "retry"}},
        "selector": 'button[data-testid="retry"]',
        "componentHints": {
            "framework": "react",
            "owners": [{"name": "RetryButton", "source": {"file": component.as_uri(), "line": 1, "column": 1}}],
        },
    }

    packet = ContextPacketBuilder().build(
        command="fix this component",
        recipe_id="agent.handoff",
        objects=[pointed],
        cwd=repo,
        target_lease=_lease(),
        capture_decisions=[_decision("structured_only", upload=False)],
        capabilities=[],
    )
    link = packet["runtime"]["componentLink"]
    prompt = build_agent_prompt(packet, artifact_path=tmp_path / "packet.json")

    assert link["state"] == "resolved"
    assert link["candidates"][0]["path"] == str(component.resolve())
    assert link["autoModificationAllowed"] is True
    assert "## Component source candidates" in prompt
    assert "RetryButton.tsx:1" in prompt
    assert "Low-confidence candidates are hints only" in prompt
