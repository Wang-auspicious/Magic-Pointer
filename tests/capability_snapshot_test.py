from app.fabric.capability_snapshot import build_capability_snapshot


def test_capability_snapshot_reports_executable_truth() -> None:
    providers = {
        "native_ocr": True,
        "vision_ocr": False,
        "openai_whisper": False,
        "whisper_cpp": False,
        "codex": False,
        "pi": False,
        "claude": False,
        "gemini": False,
        "cursor": False,
        "opencode": False,
        "aider": False,
        "generic": False,
        "vision_model": False,
        "omniparser": True,
    }
    verifiers = {
        "clipboard_hash": True,
        "transcript_and_episode_id": True,
        "agent_task_receipt_and_session_id": True,
        "object_map_and_image_hash": True,
    }
    snapshot = build_capability_snapshot(
        provider_availability=providers,
        verifier_availability=verifiers,
        platform="windows",
    )

    assert snapshot.by_id("text.ocr_copy").state == "ready"
    assert snapshot.by_id("voice.short_command").state == "needs_setup"
    assert snapshot.by_id("agent.handoff").state == "needs_agent"
    assert snapshot.by_id("vision.prompt_bridge").state == "experimental"


def test_capability_snapshot_fails_closed_on_platform_or_verifier() -> None:
    unavailable = build_capability_snapshot(
        provider_availability={"native_ocr": True},
        verifier_availability={"clipboard_hash": True},
        platform="linux",
    )
    assert unavailable.by_id("text.ocr_copy").state == "unavailable"

    blocked = build_capability_snapshot(
        provider_availability={"native_ocr": True},
        verifier_availability={"clipboard_hash": False},
        platform="windows",
    )
    status = blocked.by_id("text.ocr_copy")
    assert status.state == "blocked"
    assert status.repair_action == {
        "type": "open_settings",
        "target": "diagnostics",
        "reason": "verifier_unavailable",
    }
    assert status.evidence["verifierReady"] is False


def test_capability_snapshot_serializes_evidence_and_repairs() -> None:
    snapshot = build_capability_snapshot(
        provider_availability={},
        verifier_availability={},
        platform="windows",
    )
    payload = snapshot.to_dict()
    assert payload["schemaVersion"] == 1
    assert payload["platform"] == "windows"
    assert len(payload["capabilities"]) >= 20
    assert all("evidence" in item for item in payload["capabilities"])
