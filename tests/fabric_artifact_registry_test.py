from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.fabric.artifacts import ArtifactRegistry, ArtifactRegistryError


def test_registry_links_local_artifact_to_plan_receipt_task_and_source_objects(tmp_path: Path) -> None:
    artifact = tmp_path / "artifacts" / "result.csv"
    artifact.parent.mkdir(parents=True)
    artifact.write_text("name,value\nA,1\n", encoding="utf-8")
    now = datetime(2026, 7, 27, 8, 0, tzinfo=timezone.utc)
    registry = ArtifactRegistry(tmp_path)

    registered = registry.register(
        artifact,
        plan_id="plan-1",
        receipt_id="receipt-1",
        task_id="task-1",
        recipe_id="table.to_spreadsheet",
        provider="artifact.table",
        source_object_ids=("object-a", "object-b"),
        retention_days=30,
        now=now,
    )

    assert registered["artifactId"].startswith("artifact-")
    assert registered["state"] == "active"
    assert registered["sha256"]
    assert registered["sizeBytes"] == artifact.stat().st_size
    assert registered["sourceObjectIds"] == ["object-a", "object-b"]
    assert registered["expiresAt"].startswith("2026-08-26")
    assert registry.list()[0]["receiptId"] == "receipt-1"


def test_registry_refuses_to_manage_files_outside_its_root(tmp_path: Path) -> None:
    managed = tmp_path / "managed"
    managed.mkdir()
    external = tmp_path / "external.txt"
    external.write_text("keep me", encoding="utf-8")
    with pytest.raises(ArtifactRegistryError, match="outside_managed_root"):
        ArtifactRegistry(managed).register(
            external,
            plan_id="plan-1",
            receipt_id="receipt-1",
            retention_days=30,
        )
    assert external.read_text(encoding="utf-8") == "keep me"


def test_external_workspace_artifact_is_indexed_as_reference_but_never_cleaned(tmp_path: Path) -> None:
    runtime = tmp_path / "runtime"
    workspace = tmp_path / "workspace"
    runtime.mkdir()
    workspace.mkdir()
    output = workspace / "report.md"
    output.write_text("agent result\n", encoding="utf-8")
    registry = ArtifactRegistry(runtime)
    item = registry.register_reference(
        output,
        allowed_roots=(workspace,),
        plan_id="plan-1",
        receipt_id="receipt-1",
        task_id="task-1",
        recipe_id="agent.handoff",
        provider="pi",
        source_object_ids=("object-a",),
    )
    assert item["state"] == "external"
    assert item["managed"] is False
    assert registry.cleanup_expired(
        confirmed=False,
        now=datetime(2030, 1, 1, tzinfo=timezone.utc),
    )["candidateCount"] == 0
    assert output.exists()


def test_expired_cleanup_requires_confirmation_moves_to_trash_and_can_restore(tmp_path: Path) -> None:
    artifact = tmp_path / "artifacts" / "result.md"
    artifact.parent.mkdir(parents=True)
    artifact.write_text("verified result\n", encoding="utf-8")
    created = datetime(2026, 7, 1, tzinfo=timezone.utc)
    registry = ArtifactRegistry(tmp_path)
    item = registry.register(
        artifact,
        plan_id="plan-1",
        receipt_id="receipt-1",
        retention_days=3,
        now=created,
    )
    after_expiry = created + timedelta(days=4)

    preview = registry.cleanup_expired(confirmed=False, now=after_expiry)
    assert preview["status"] == "confirmation_required"
    assert preview["candidateArtifactIds"] == [item["artifactId"]]
    assert artifact.exists()

    cleaned = registry.cleanup_expired(confirmed=True, now=after_expiry)
    assert cleaned["status"] == "trashed"
    assert cleaned["trashedArtifactIds"] == [item["artifactId"]]
    assert not artifact.exists()
    trashed = registry.get(item["artifactId"])
    assert trashed["state"] == "trashed"
    assert Path(trashed["trashPath"]).exists()

    restored = registry.restore(item["artifactId"])
    assert restored["state"] == "active"
    assert artifact.read_text(encoding="utf-8") == "verified result\n"
