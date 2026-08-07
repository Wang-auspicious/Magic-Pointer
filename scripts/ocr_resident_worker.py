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
from collections import OrderedDict
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.grounding.ocr_mark_selection import select_open_stroke_rect_indexes

RUNTIME_DIR = ROOT / "data" / "runtime"
PORT_FILE = RUNTIME_DIR / "ocr_worker.port"
STARTUP_LOCK_FILE = RUNTIME_DIR / "ocr_worker.start.lock"
# Loading the RapidOCR models costs seconds; serving a request costs
# milliseconds. A five-minute idle timeout meant a user who came back after
# lunch paid the cold load again, which is most of the p50 latency we measured.
# Half an hour keeps a working session warm; MAGIC_POINTER_OCR_IDLE_TIMEOUT_S
# lets a memory-constrained machine shorten it.
try:
    IDLE_TIMEOUT_S = max(60.0, float(os.environ.get("MAGIC_POINTER_OCR_IDLE_TIMEOUT_S") or 1800.0))
except ValueError:
    IDLE_TIMEOUT_S = 1800.0
DETECTION_WIDE_SIZE = (640, 192)
DETECTION_STANDARD_SIZE = (640, 512)
# A single request line larger than this is a broken or hostile caller; never
# buffer it (the bridge caps its own payload at 64 KB).
MAX_REQUEST_LINE_BYTES = 512 * 1024


def _published_worker_port(port_file: Path = PORT_FILE) -> int | None:
    """Return a published OCR port only when a worker is actually accepting."""
    try:
        meta = json.loads(port_file.read_text(encoding="utf-8"))
        port = int(meta.get("port") or 0)
        if port <= 0:
            return None
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return port
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return None


def _remove_owned_port_file(port_file: Path, *, pid: int, port: int) -> bool:
    """Remove discovery metadata only if this exact worker still owns it."""
    try:
        meta = json.loads(port_file.read_text(encoding="utf-8"))
        if int(meta.get("pid") or 0) != int(pid) or int(meta.get("port") or 0) != int(port):
            return False
        port_file.unlink(missing_ok=True)
        return True
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return False


@contextmanager
def _worker_startup_lock(lock_file: Path = STARTUP_LOCK_FILE) -> Iterator[bool]:
    """Serialize model loading across bridge processes; OS locks vanish on crash."""
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_file.open("a+b")
    acquired = False
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:  # pragma: no cover - exercised on Windows in desktop acceptance
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except (OSError, BlockingIOError):
            acquired = False
        yield acquired
    finally:
        if acquired:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:  # pragma: no cover
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
        handle.close()


def _detection_canvas(source) -> tuple[object, float]:
    """Letterbox every capture into one of two reusable detector shapes."""
    from PIL import Image

    import numpy as np

    width, height = source.size
    canvas_width, canvas_height = (
        DETECTION_WIDE_SIZE
        if width / max(1, height) >= 3.0
        else DETECTION_STANDARD_SIZE
    )
    scale = min(canvas_width / max(1, width), canvas_height / max(1, height))
    resized_width = max(1, min(canvas_width, int(round(width * scale))))
    resized_height = max(1, min(canvas_height, int(round(height * scale))))
    resampling = getattr(Image, "Resampling", Image).BILINEAR
    resized = source.resize((resized_width, resized_height), resampling)
    fill = source.getpixel((0, 0)) if width and height else (0, 0, 0)
    canvas = Image.new("RGB", (canvas_width, canvas_height), fill)
    canvas.paste(resized, (0, 0))
    return np.asarray(canvas), scale


def _warm_detection_shapes(engine) -> None:
    """Pay ONNX shape initialization while the resident starts in background."""
    import numpy as np

    for width, height in (DETECTION_WIDE_SIZE, DETECTION_STANDARD_SIZE):
        engine(np.zeros((height, width, 3), dtype=np.uint8), use_cls=False, use_rec=False)


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
        kept_indexes: set[int] = set()
        rectangles = [boxes_to_xywh(box) for box in boxes]
        for stroke in strokes_local:
            if _stroke_is_closed(stroke):
                region = _stroke_xywh(stroke)
                for index, rect in enumerate(rectangles):
                    if _block_center_in_region(rect, region) or _block_overlap_ratio(rect, region) > 0.30:
                        kept_indexes.add(index)
            else:
                kept_indexes.update(select_open_stroke_rect_indexes(rectangles, stroke))
        return [box for index, box in enumerate(boxes) if index in kept_indexes]
    if selection_local:
        return [box for box in boxes if _rect_overlaps(boxes_to_xywh(box), selection_local)]
    return list(boxes)


def _split_wide_box(box: list[list[float]], max_width: float = 900.0, overlap: float = 80.0) -> list[list[list[float]]]:
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


def _merge_recognized_pieces(parts: list[str]) -> str:
    """Join overlapping OCR crops without repeating their shared characters."""
    clean = [str(part or "").strip() for part in parts if str(part or "").strip()]
    if not clean:
        return ""
    merged = clean[0]
    for part in clean[1:]:
        folded_merged = merged.casefold()
        folded_part = part.casefold()
        overlap = 0
        for size in range(min(len(merged), len(part), 24), 1, -1):
            if folded_merged[-size:] == folded_part[:size]:
                overlap = size
                break
        merged = merged + part[overlap:] if overlap else f"{merged} {part}"
    return merged


# Detection runs over the whole frozen capture and is the expensive half of a
# read; recognition only touches the boxes the user's mark selects. A capture
# never changes once written, so a second command about the same object (the
# common case in a multi-turn conversation) can reuse the boxes outright.
_DETECTION_CACHE: "OrderedDict[tuple[str, int, int], list]" = OrderedDict()
_DETECTION_CACHE_MAX = 8


def _detect_boxes(engine, image_path: Path) -> list:
    from PIL import Image

    try:
        stat = image_path.stat()
        key = (str(image_path.resolve()), stat.st_size, stat.st_mtime_ns)
    except OSError:
        key = None
    if key is not None and key in _DETECTION_CACHE:
        _DETECTION_CACHE.move_to_end(key)
        return _DETECTION_CACHE[key]

    with Image.open(image_path).convert("RGB") as source:
        detection_array, detection_scale = _detection_canvas(source)
    det = engine(detection_array, use_cls=False, use_rec=False)
    raw_boxes = det.boxes
    full_boxes = (
        []
        if raw_boxes is None or len(raw_boxes) == 0
        else [
            [[float(point[0]) / detection_scale, float(point[1]) / detection_scale] for point in box]
            for box in raw_boxes.tolist()
        ]
    )
    if key is not None:
        _DETECTION_CACHE[key] = full_boxes
        while len(_DETECTION_CACHE) > _DETECTION_CACHE_MAX:
            _DETECTION_CACHE.popitem(last=False)
    return full_boxes


def process(engine, payload: dict) -> dict:
    image_path = Path(str(payload.get("path") or ""))
    if not image_path.is_file():
        return {"ok": False, "error": "capture_missing"}
    strokes_local = payload.get("strokes_local") or []
    selection_local = payload.get("selection_bbox_local")
    try:
        from PIL import Image

        import numpy as np

        full_boxes = _detect_boxes(engine, image_path)
        if not full_boxes:
            return {"ok": True, "blocks": [], "engine": "rapidocr-onnx"}
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
            # 低置信度识别（OCR 噪声）不参与合并：宁可少一条，不可把
            # 误识别的字符当成「屏幕上的真相」进上下文。
            if piece_index < len(scores):
                try:
                    score = float(scores[piece_index])
                except (TypeError, ValueError):
                    score = 1.0
                if score < 0.5:
                    continue
            owner = piece_owner[piece_index] if piece_index < len(piece_owner) else 0
            merged.setdefault(owner, []).append(label)
        blocks = []
        for index, candidate in enumerate(candidates):
            parts = merged.get(index)
            if not parts:
                continue
            blocks.append({
                "text": _merge_recognized_pieces(parts),
                "rect": boxes_to_xywh(candidate),
                "conf": None,
            })
        return {"ok": True, "blocks": blocks, "engine": "rapidocr-onnx"}
    except Exception as exc:  # pragma: no cover - worker robustness
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def _process_if_idle(engine, payload: dict, process_lock: threading.Lock) -> dict:
    """Run one inference at a time; RapidOCR's shared session is not thread-safe."""
    if not process_lock.acquire(blocking=False):
        return {"ok": False, "error": "worker_busy"}
    try:
        return process(engine, payload)
    finally:
        process_lock.release()


def main() -> int:
    import time as _time

    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    with _worker_startup_lock() as owns_startup:
        if not owns_startup:
            # Another bridge won the cold-start race. Wait for its discovery
            # record instead of loading a second multi-hundred-MB OCR engine.
            deadline = _time.monotonic() + 30.0
            while _time.monotonic() < deadline:
                if _published_worker_port() is not None:
                    return 0
                _time.sleep(0.2)
            return 3

        # A request may have spawned us after a resident had already published.
        if _published_worker_port() is not None:
            return 0

        from rapidocr import RapidOCR

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
        _warm_detection_shapes(engine)

        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(("127.0.0.1", 0))
        port = server.getsockname()[1]
        server.listen(4)
        server.settimeout(1.0)
        PORT_FILE.write_text(json.dumps({"pid": os.getpid(), "port": port}), encoding="utf-8")

    process_lock = threading.Lock()
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
                if len(buffer) > MAX_REQUEST_LINE_BYTES:
                    try:
                        connection.sendall((
                            json.dumps({"ok": False, "error": "request_too_large"}, ensure_ascii=False) + "\n"
                        ).encode("utf-8"))
                    except Exception:
                        pass
                    break
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    touch()
                    request = None
                    try:
                        request = json.loads(line.decode("utf-8"))
                        response = _process_if_idle(engine, request, process_lock)
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
        _remove_owned_port_file(PORT_FILE, pid=os.getpid(), port=port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
