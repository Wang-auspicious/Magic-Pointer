#!/usr/bin/env python3
"""Resident OCR worker.

Loads the RapidOCR engine once and serves JSON requests over a local TCP
socket. Each request runs full-screen text detection (on a downscaled copy for
speed), then only recognizes the blocks near the user's mark (stroke polylines
or a selection rectangle in capture-local coordinates). Coordinates in the
response are capture-local pixels, matching the screenshot the caller saved.

Protocol (newline-delimited JSON on a single connection):
  -> {"id": 1, "path": "...", "strokes_local": [[[x, y], ...], ...],
      "selection_bbox_local": [x, y, w, h] | null}
  <- {"id": 1, "blocks": [{"text": "...", "rect": [x, y, w, h], "conf": 0.9}],
      "engine": "rapidocr-onnx", "ok": true}
"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

RUNTIME_DIR = ROOT / "data" / "runtime"
PORT_FILE = RUNTIME_DIR / "ocr_worker.port"
IDLE_TIMEOUT_S = 300.0
DET_SCALE = 0.5


def boxes_to_xywh(box: list[list[float]]) -> list[int]:
    xs = [float(point[0]) for point in box]
    ys = [float(point[1]) for point in box]
    if not xs or not ys:
        return [0, 0, 0, 0]
    left, top = min(xs), min(ys)
    return [int(round(left)), int(round(top)), int(round(max(xs) - left)), int(round(max(ys) - top))]


def _segment_hits_rect(ax: float, ay: float, bx: float, by: float, left: float, top: float, right: float, bottom: float) -> bool:
    def inside(x: float, y: float) -> bool:
        return left <= x <= right and top <= y <= bottom

    if inside(ax, ay) or inside(bx, by):
        return True
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return False
    p = [-dx, dx, -dy, dy]
    q = [ax - left, right - ax, ay - top, bottom - ay]
    u1, u2 = 0.0, 1.0
    for pi, qi in zip(p, q):
        if pi == 0:
            if qi < 0:
                return False
        else:
            ratio = qi / pi
            if pi < 0:
                if ratio > u2:
                    return False
                if ratio > u1:
                    u1 = ratio
            else:
                if ratio < u1:
                    return False
                if ratio < u2:
                    u2 = ratio
    return True


def _polyline_hits_rect(points: list[list[float]], rect: list[int], tolerance: float = 10.0) -> bool:
    if not points or len(rect) != 4:
        return False
    rx, ry, rw, rh = (float(value) for value in rect)
    if rw <= 0 or rh <= 0:
        return False
    left, top = rx - tolerance, ry - tolerance
    right, bottom = rx + rw + tolerance, ry + rh + tolerance
    for index in range(len(points) - 1):
        ax, ay = points[index]
        bx, by = points[index + 1]
        if _segment_hits_rect(ax, ay, bx, by, left, top, right, bottom):
            return True
    return False


def _rect_overlaps(rect: list[int], selection: list[int], padding: int = 10) -> bool:
    try:
        rx, ry, rw, rh = (float(value) for value in rect)
        sx, sy, sw, sh = (float(value) for value in selection)
    except (TypeError, ValueError):
        return True
    if rw <= 0 or rh <= 0:
        return False
    return rx < sx + sw + padding and rx + rw > sx - padding and ry < sy + sh + padding and ry + rh > sy - padding


def _stroke_is_closed(points: list[list[float]], tolerance: float = 26.0) -> bool:
    if len(points) < 5:
        return False
    ax, ay = points[0]
    bx, by = points[-1]
    return ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5 <= tolerance


def _stroke_xywh(points: list[list[float]]) -> list[int]:
    xs = [float(p[0]) for p in points]
    ys = [float(p[1]) for p in points]
    if not xs or not ys:
        return [0, 0, 0, 0]
    left, top = min(xs), min(ys)
    return [int(round(left)), int(round(top)), int(round(max(xs) - left)), int(round(max(ys) - top))]


def _block_overlap_ratio(rect: list[int], region: list[int]) -> float:
    rx, ry, rw, rh = (float(v) for v in rect)
    gx, gy, gw, gh = (float(v) for v in region)
    if rw <= 0 or rh <= 0 or gw <= 0 or gh <= 0:
        return 0.0
    inter_w = max(0.0, min(rx + rw, gx + gw) - max(rx, gx))
    inter_h = max(0.0, min(ry + rh, gy + gh) - max(ry, gy))
    return (inter_w * inter_h) / (rw * rh)


def _block_center_in_region(rect: list[int], region: list[int], padding: float = 22.0) -> bool:
    rx, ry, rw, rh = (float(v) for v in rect)
    gx, gy, gw, gh = (float(v) for v in region)
    if rw <= 0 or rh <= 0 or gw <= 0 or gh <= 0:
        return False
    cx, cy = rx + rw / 2.0, ry + rh / 2.0
    return gx - padding <= cx <= gx + gw + padding and gy - padding <= cy <= gy + gh + padding


def _select_boxes(boxes: list[list[list[float]]], strokes_local: list[list[list[float]]], selection_local: list[int] | None) -> list[list[list[float]]]:
    if strokes_local:
        kept = []
        for box in boxes:
            rect = boxes_to_xywh(box)
            for stroke in strokes_local:
                region = _stroke_xywh(stroke)
                if _stroke_is_closed(stroke):
                    if _block_center_in_region(rect, region) or _block_overlap_ratio(rect, region) > 0.30:
                        kept.append(box)
                        break
                else:
                    if _polyline_hits_rect(stroke, rect) or _block_overlap_ratio(rect, region) > 0.30:
                        kept.append(box)
                        break
        return kept
    if selection_local:
        return [box for box in boxes if _rect_overlaps(boxes_to_xywh(box), selection_local)]
    return list(boxes)


def _split_wide_box(box: list[list[float]], max_width: float = 520.0, overlap: float = 40.0) -> list[list[list[float]]]:
    """Split a very wide text box into overlapping vertical slices.

    RapidOCR's recognition model resizes long lines into a fixed-width input,
    which silently drops characters at the end; slicing keeps each chunk under
    the model's comfortable width and the parts are joined back in order.
    """
    xs = [float(p[0]) for p in box]
    ys = [float(p[1]) for p in box]
    left, top = min(xs), min(ys)
    right, bottom = max(xs), max(ys)
    width = right - left
    if width <= max_width or width <= 0:
        return [box]
    parts: list[list[list[float]]] = []
    start = left
    while start < right:
        end = min(right, start + max_width)
        parts.append([[start, top], [end, top], [end, bottom], [start, bottom]])
        if end >= right:
            break
        start = end - overlap
    return parts


def process(engine, payload: dict) -> dict:
    image_path = Path(str(payload.get("path") or ""))
    if not image_path.is_file():
        return {"ok": False, "error": "capture_missing"}
    strokes_local = payload.get("strokes_local") or []
    selection_local = payload.get("selection_bbox_local")
    try:
        from PIL import Image

        import numpy as np

        with Image.open(image_path).convert("RGB") as source:
            width, height = source.size
            small = source.resize((max(1, int(width * DET_SCALE)), max(1, int(height * DET_SCALE))), Image.BILINEAR)
            small_array = np.asarray(small)
        det = engine(small_array, use_cls=False, use_rec=False)
        raw_boxes = det.boxes
        if raw_boxes is None or len(raw_boxes) == 0:
            return {"ok": True, "blocks": [], "engine": "rapidocr-onnx"}
        full_boxes = [
            [[float(point[0]) / DET_SCALE, float(point[1]) / DET_SCALE] for point in box]
            for box in raw_boxes.tolist()
        ]
        candidates = _select_boxes(full_boxes, strokes_local, selection_local)
        if not candidates:
            return {"ok": True, "blocks": [], "engine": "rapidocr-onnx"}
        with Image.open(image_path).convert("RGB") as source:
            source_array = np.asarray(source)
        pieces: list[list[list[float]]] = []
        piece_owner: list[int] = []
        for index, candidate in enumerate(candidates):
            split = _split_wide_box(candidate)
            pieces.extend(split)
            piece_owner.extend([index] * len(split))
        crops = engine.crop_text_regions(source_array, np.asarray(pieces, dtype=np.float32))
        rec = engine.recognize_txt(crops)
        txts = list(rec.txts or [])
        scores = list(rec.scores or []) if rec.scores is not None else []
        merged: dict[int, list[str]] = {}
        for piece_index, text in enumerate(txts):
            label = str(text or "").strip()
            if not label:
                continue
            owner = piece_owner[piece_index] if piece_index < len(piece_owner) else 0
            merged.setdefault(owner, []).append(label)
        blocks = []
        for index, candidate in enumerate(candidates):
            parts = merged.get(index)
            if not parts:
                continue
            blocks.append({
                "text": " ".join(parts),
                "rect": boxes_to_xywh(candidate),
                "conf": None,
            })
        return {"ok": True, "blocks": blocks, "engine": "rapidocr-onnx"}
    except Exception as exc:  # pragma: no cover - worker robustness
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def main() -> int:
    from rapidocr import RapidOCR

    import time as _time

    # Model files may still be held by a previous worker process being torn
    # down; retry the engine load so a kill/restart race does not kill us.
    engine = None
    for attempt in range(6):
        try:
            engine = RapidOCR()
            break
        except Exception as exc:
            if attempt >= 5:
                print(json.dumps({"ok": False, "error": f"engine_load_failed:{type(exc).__name__}"}))
                return 2
            _time.sleep(2.0)
    assert engine is not None

    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    port = server.getsockname()[1]
    server.listen(4)
    server.settimeout(1.0)
    PORT_FILE.write_text(json.dumps({"pid": os.getpid(), "port": port}), encoding="utf-8")
    import time as _time
    last_active = [_time.time()]

    def touch() -> None:
        import time as _time

        last_active[0] = _time.time()

    def serve(connection: socket.socket) -> None:
        buffer = b""
        connection.settimeout(30.0)
        try:
            while True:
                chunk = connection.recv(65536)
                if not chunk:
                    break
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    touch()
                    request = None
                    try:
                        request = json.loads(line.decode("utf-8"))
                        response = process(engine, request)
                        response["id"] = request.get("id")
                    except Exception as exc:  # pragma: no cover
                        response = {"id": request.get("id") if request else None, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
                    connection.sendall((json.dumps(response, ensure_ascii=False) + "\n").encode("utf-8"))
        except Exception:
            pass
        finally:
            try:
                connection.close()
            except Exception:
                pass

    try:
        while True:
            try:
                connection, _ = server.accept()
            except socket.timeout:
                if _time.time() - last_active[0] > IDLE_TIMEOUT_S:
                    break
                continue
            threading.Thread(target=serve, args=(connection,), daemon=True).start()
    finally:
        try:
            server.close()
        except Exception:
            pass
        try:
            PORT_FILE.unlink(missing_ok=True)
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
