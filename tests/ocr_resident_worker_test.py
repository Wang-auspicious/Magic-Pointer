from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.ocr_resident_worker import (
    _detection_canvas,
    _remove_owned_port_file,
    _process_if_idle,
    _merge_recognized_pieces,
    _select_boxes,
    _split_wide_box,
    _stroke_is_closed,
    boxes_to_xywh,
)
from scripts import ocr_resident_worker as worker


class _BusyLock:
    def acquire(self, blocking=True):
        return False

    def release(self):
        raise AssertionError("a lock that was not acquired must not be released")


def test_old_worker_cleanup_does_not_delete_a_new_workers_port_file(tmp_path) -> None:
    port_file = tmp_path / "ocr_worker.port"
    port_file.write_text('{"pid": 22, "port": 2200}', encoding="utf-8")

    assert _remove_owned_port_file(port_file, pid=11, port=1100) is False
    assert port_file.is_file()
    assert _remove_owned_port_file(port_file, pid=22, port=2200) is True
    assert not port_file.exists()


def test_detection_canvas_uses_one_fixed_shape_and_reports_the_inverse_scale() -> None:
    canvas, scale = _detection_canvas(Image.new("RGB", (940, 180), "white"))

    assert canvas.shape == (192, 640, 3)
    assert round(scale, 4) == round(640 / 940, 4)


def test_busy_worker_rejects_concurrent_inference_instead_of_corrupting_engine_state() -> None:
    response = _process_if_idle(object(), {"path": "unused"}, _BusyLock())
    assert response == {"ok": False, "error": "worker_busy"}


def test_overlapping_wide_line_chunks_are_merged_without_duplicate_letters() -> None:
    assert _merge_recognized_pieces([
        "MAGIC POINTER ACCEPTANCE FIXTUR",
        "URE",
    ]) == "MAGIC POINTER ACCEPTANCE FIXTURE"
    assert _merge_recognized_pieces([
        "alpha line: structural",
        "grounding should stay exact",
    ]) == "alpha line: structural grounding should stay exact"


def test_split_wide_box_slices_into_overlapping_chunks() -> None:
    box = [[0.0, 0.0], [1200.0, 0.0], [1200.0, 40.0], [0.0, 40.0]]
    parts = _split_wide_box(box, max_width=520.0, overlap=40.0)
    assert len(parts) >= 3
    widths = [round(max(p[0] for p in part) - min(p[0] for p in part)) for part in parts]
    assert all(width <= 520 for width in widths)
    assert parts[0][1][0] == 520.0
    assert parts[-1][0][0] < 1200.0 and parts[-1][1][0] == 1200.0


def test_split_wide_box_keeps_narrow_box_untouched() -> None:
    box = [[10.0, 0.0], [300.0, 0.0], [300.0, 40.0], [10.0, 40.0]]
    assert _split_wide_box(box) == [box]


def test_split_wide_box_does_not_damage_an_ordinary_550px_text_line() -> None:
    box = [[10.0, 0.0], [560.0, 0.0], [560.0, 40.0], [10.0, 40.0]]
    assert _split_wide_box(box) == [box]


def test_stroke_is_closed_detects_loop_with_short_tail() -> None:
    loop = [[0, 0], [100, 0], [100, 50], [0, 50], [2, 1]]
    assert _stroke_is_closed(loop) is True
    open_line = [[0, 0], [100, 5], [200, 10]]
    assert _stroke_is_closed(open_line) is False


def test_select_boxes_loop_collects_inside_not_outside() -> None:
    boxes = [
        [[100.0, 100.0], [300.0, 100.0], [300.0, 130.0], [100.0, 130.0]],
        [[100.0, 200.0], [300.0, 200.0], [300.0, 230.0], [100.0, 230.0]],
        [[900.0, 900.0], [1100.0, 900.0], [1100.0, 930.0], [900.0, 930.0]],
    ]
    loop = [[90, 90], [350, 92], [352, 240], [88, 238], [90, 90]]
    kept = _select_boxes(boxes, [loop], None)
    assert len(kept) == 2
    assert boxes_to_xywh(kept[0])[0] == 100
    assert boxes_to_xywh(kept[1])[1] == 200


def test_select_boxes_open_stroke_keeps_only_crossed() -> None:
    boxes = [
        [[100.0, 100.0], [300.0, 100.0], [300.0, 130.0], [100.0, 130.0]],
        [[100.0, 400.0], [300.0, 400.0], [300.0, 430.0], [100.0, 430.0]],
    ]
    line = [[0, 110], [200, 108], [500, 110]]
    kept = _select_boxes(boxes, [line], None)
    assert len(kept) == 1
    assert boxes_to_xywh(kept[0])[1] == 100


def test_select_boxes_underline_does_not_recognize_the_next_row() -> None:
    boxes = [
        [[32.0, 58.0], [832.0, 58.0], [832.0, 88.0], [32.0, 88.0]],
        [[32.0, 98.0], [842.0, 98.0], [842.0, 128.0], [32.0, 128.0]],
    ]

    kept = _select_boxes(boxes, [[[32, 90], [832, 90]]], None)

    assert kept == [boxes[0]]


def test_small_mark_on_hidpi_frame_gets_detail_detection_without_losing_full_frame(tmp_path):
    image = tmp_path / 'hidpi.png'
    Image.new('RGB', (3120, 2080), '#252525').save(image)
    original = image.read_bytes()

    class Engine:
        calls = 0

        def __call__(self, pixels, **_options):
            self.calls += 1
            assert pixels.shape == (512, 640, 3), 'detail detection reuses the warmed detector shape'
            if self.calls == 1:
                return SimpleNamespace(boxes=None)
            return SimpleNamespace(boxes=np.array([[[100, 110], [480, 110], [480, 145], [100, 145]]]))

        def crop_text_regions(self, pixels, boxes):
            assert pixels.shape == (2080, 3120, 3), 'recognition always reads the original historical pixels'
            self.recognized_boxes = boxes
            return [pixels]

        def recognize_txt(self, _crops):
            return SimpleNamespace(txts=['Changes +17,726 -1,227'], scores=[0.99])

    engine = Engine()
    payload = {'path': str(image), 'selection_bbox_local': [2505, 206, 598, 482]}
    result = worker.process(engine, payload)
    assert [block['text'] for block in result['blocks']] == ['Changes +17,726 -1,227']
    assert engine.calls == 2, 'one global pass plus a bounded detail pass'
    assert 2505 <= result['blocks'][0]['rect'][0] < 3103
    assert 206 <= result['blocks'][0]['rect'][1] < 688
    assert worker.process(engine, payload) == result
    assert engine.calls == 2, 'repeated questions about the same frozen region reuse both detections'
    assert image.read_bytes() == original
