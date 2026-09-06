from __future__ import annotations

from pathlib import Path

from app.fabric.artifacts import ArtifactRegistry


def test_file_artifact_keeps_draft_source_preview_and_receipt(tmp_path: Path) -> None:
    output = tmp_path / "artifacts" / "deck.pptx"
    output.parent.mkdir(parents=True)
    output.write_bytes(b"pptx fixture")

    indexed = ArtifactRegistry(tmp_path).register(
        output,
        plan_id="plan-1",
        receipt_id="receipt-1",
        task_id="task-1",
        source_id="source-template",
        draft_artifact_id="draft-1",
        artifact_revision=3,
        references=({"referenceId": "ref-template", "role": "reference"},),
        preview={"path": "preview/slide-1.png", "kind": "slide"},
        verification_receipt={"verified": True, "method": "reopen"},
    )

    assert indexed["sourceId"] == "source-template"
    assert indexed["draftArtifactId"] == "draft-1"
    assert indexed["artifactRevision"] == 3
    assert indexed["references"] == [{"referenceId": "ref-template", "role": "reference"}]
    assert indexed["preview"] == {"path": "preview/slide-1.png", "kind": "slide"}
    assert indexed["verificationReceipt"] == {"verified": True, "method": "reopen"}
