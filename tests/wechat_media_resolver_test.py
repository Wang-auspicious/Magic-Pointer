from pathlib import Path

from PIL import Image

from app.grounding.wechat_media import resolve_wechat_media_evidence


def _window() -> dict:
    return {"process_name": "Weixin", "title": "项目群", "hwnd": 42}


def test_file_card_is_copied_to_stable_capture_media_path(tmp_path: Path) -> None:
    wechat_root = tmp_path / "WeChat Files"
    source = wechat_root / "wxid_demo" / "FileStorage" / "File" / "2026-08" / "项目说明.docx"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"docx-bytes")

    evidence = resolve_wechat_media_evidence(
        window=_window(),
        context={"content": "项目说明.docx"},
        snapshot={"snapshot_id": "selection-1"},
        output_root=tmp_path / "captures",
        data_roots=[wechat_root],
    )

    assert len(evidence) == 1
    item = evidence[0]
    assert item["status"] == "resolved"
    assert item["acquisition"] == "verified_filename_search"
    assert item["quality"] == "original_file_copy"
    local_path = Path(item["localPath"])
    assert local_path.is_absolute()
    assert local_path.read_bytes() == b"docx-bytes"
    assert local_path != source


def test_ambiguous_file_name_does_not_claim_a_verified_path(tmp_path: Path) -> None:
    root = tmp_path / "WeChat Files"
    for account in ("wxid_a", "wxid_b"):
        path = root / account / "FileStorage" / "File" / "项目说明.docx"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(account.encode())

    evidence = resolve_wechat_media_evidence(
        window=_window(),
        context={"content": "项目说明.docx"},
        snapshot={"snapshot_id": "selection-2"},
        output_root=tmp_path / "captures",
        data_roots=[root],
    )

    assert evidence[0]["status"] == "unresolved"
    assert evidence[0]["reason"] == "filename_ambiguous"
    assert evidence[0]["localPath"] is None


def test_visible_image_falls_back_to_the_frozen_stroke_crop(tmp_path: Path) -> None:
    capture = tmp_path / "screen.png"
    Image.new("RGB", (800, 600), "white").save(capture)

    evidence = resolve_wechat_media_evidence(
        window=_window(),
        context={"content": "[图片]"},
        snapshot={
            "snapshot_id": "selection-3",
            "capture_path": str(capture),
            "capture_bbox": [0, 0, 800, 600],
            "selection_bbox": [120, 140, 320, 240],
        },
        output_root=tmp_path / "captures",
        data_roots=[],
    )

    assert evidence[0]["status"] == "crop_only"
    assert evidence[0]["acquisition"] == "screenshot_crop"
    assert evidence[0]["quality"] == "rendered_crop"
    crop = Path(evidence[0]["localPath"])
    assert crop.is_file()
    assert Image.open(crop).size == (320, 240)


def test_tiny_thumbnail_is_explicitly_unresolved(tmp_path: Path) -> None:
    capture = tmp_path / "screen.png"
    Image.new("RGB", (300, 200), "white").save(capture)

    evidence = resolve_wechat_media_evidence(
        window=_window(),
        context={"content": "[图片]"},
        snapshot={
            "snapshot_id": "selection-4",
            "capture_path": str(capture),
            "capture_bbox": [0, 0, 300, 200],
            "selection_bbox": [20, 20, 42, 31],
        },
        output_root=tmp_path / "captures",
        data_roots=[],
    )

    assert evidence[0]["status"] == "unresolved"
    assert evidence[0]["reason"] == "thumbnail_too_small"
    assert evidence[0]["observedCropPx"] == [42, 31]
    assert evidence[0]["localPath"] is None


def test_non_wechat_window_is_ignored(tmp_path: Path) -> None:
    assert resolve_wechat_media_evidence(
        window={"process_name": "chrome", "title": "Browser"},
        context={"content": "[图片]"},
        snapshot={"snapshot_id": "selection-5"},
        output_root=tmp_path,
        data_roots=[],
    ) == []
