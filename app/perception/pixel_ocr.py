
from __future__ import annotations

import json
import socket
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

from app.adapters.base import AdapterReadContext
from app.evidence.contract import EvidenceStatus
from app.perception.providers import (
    TIER_PIXEL,
    PerceptionRequest,
    ProviderDescriptor,
    ProviderResult,
)
ROOT = Path(__file__).resolve().parents[2]
OCR_WORKER_PORT_FILE = ROOT / "data" / "runtime" / "ocr_worker.port"
OCR_WORKER_SCRIPT = ROOT / "scripts" / "ocr_resident_worker.py"

OCR_WORKER_BUSY_ENGINE = "worker-busy"
_OCR_BUSY = "__ocr_busy__"
_OCR_UNAVAILABLE = "__ocr_unavailable__"

MAX_CAPTURED_RECTS = 24


def gesture_strokes(gesture: Any) -> list[list[tuple[int, int]]]:
    if not isinstance(gesture, dict):
        return []
    strokes: list[list[tuple[int, int]]] = []
    for stroke in list(gesture.get("strokes") or [])[:8]:
        raw_points = list(stroke.get("points") or []) if isinstance(stroke, dict) else []
        geometry = stroke.get("geometry") if isinstance(stroke, dict) else None
        if (isinstance(geometry, dict) and geometry.get("type") == "polygon_region"
                and geometry.get("coordinateSpace") == "physical_screen_pixels"):
            raw_points = list(geometry.get("ring") or raw_points)
        points: list[tuple[int, int]] = []
        for raw in raw_points[:256]:
            if not isinstance(raw, dict):
                continue
            try:
                points.append((int(round(float(raw.get("x")))), int(round(float(raw.get("y"))))))
            except (TypeError, ValueError):
                continue
        if len(points) >= 2:
            strokes.append(points)
    return strokes


def stroke_is_closed(points: list[tuple[int, int]], tolerance: float = 26.0) -> bool:
    if len(points) < 5:
        return False
    ax, ay = points[0]
    bx, by = points[-1]
    return ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5 <= tolerance


def stroke_xywh(points: list[tuple[int, int]]) -> list[int]:
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    if not xs or not ys:
        return [0, 0, 0, 0]
    left, top = min(xs), min(ys)
    return [left, top, max(xs) - left, max(ys) - top]


def block_center_in_region(
    rect: list[int],
    region_xywh: list[int],
    padding: float = 22.0,
) -> bool:
    try:
        rx, ry, rw, rh = (float(value) for value in rect)
        gx, gy, gw, gh = (float(value) for value in region_xywh)
    except (TypeError, ValueError):
        return True
    if rw <= 0 or rh <= 0 or gw <= 0 or gh <= 0:
        return False
    cx, cy = rx + rw / 2.0, ry + rh / 2.0
    return (
        gx - padding <= cx <= gx + gw + padding
        and gy - padding <= cy <= gy + gh + padding
    )


def block_overlap_ratio(rect: list[int], region_xywh: list[int]) -> float:
    try:
        rx, ry, rw, rh = (float(value) for value in rect)
        gx, gy, gw, gh = (float(value) for value in region_xywh)
    except (TypeError, ValueError):
        return 0.0
    if rw <= 0 or rh <= 0 or gw <= 0 or gh <= 0:
        return 0.0
    inter_w = max(0.0, min(rx + rw, gx + gw) - max(rx, gx))
    inter_h = max(0.0, min(ry + rh, gy + gh) - max(ry, gy))
    return (inter_w * inter_h) / (rw * rh)


def _rect_of(block: dict[str, Any]) -> list[int] | None:
    rect = block.get("rect")
    if isinstance(rect, (list, tuple)) and len(rect) == 4:
        return list(rect)
    return None


def sort_blocks_reading_order(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def key(block: dict[str, Any]) -> tuple[float, float]:
        rect = _rect_of(block)
        if rect is None:
            return (0.0, 0.0)
        return (round(int(rect[1]) / 22.0), float(rect[0]))

    return sorted(blocks, key=key)


def ocr_blocks_to_text(blocks: list[dict[str, Any]]) -> str:
    rows: list[dict[str, Any]] = []
    for block in sort_blocks_reading_order(blocks):
        text = str(block.get("text") or "").strip()
        if not text:
            continue
        rect = _rect_of(block)
        if rect is None:
            rows.append({"center": None, "height": 0.0, "parts": [text]})
            continue
        try:
            center = float(rect[1]) + float(rect[3]) / 2.0
            height = float(rect[3])
        except (TypeError, ValueError):
            rows.append({"center": None, "height": 0.0, "parts": [text]})
            continue
        row = next((
            candidate for candidate in reversed(rows)
            if candidate["center"] is not None
            and abs(float(candidate["center"]) - center)
            <= max(8.0, min(float(candidate["height"]), height) * 0.5)
        ), None)
        if row is None:
            rows.append({"center": center, "height": height, "parts": [text]})
        else:
            row["parts"].append(text)
            count = len(row["parts"])
            row["center"] = (float(row["center"]) * (count - 1) + center) / count
            row["height"] = max(float(row["height"]), height)
    return "\n".join(" ".join(row["parts"]) for row in rows if row["parts"])


def filter_blocks_by_strokes(
    blocks: list[dict[str, Any]],
    strokes: list[list[tuple[int, int]]],
) -> tuple[list[dict[str, Any]], list[list[dict[str, Any]]]]:
    from app.grounding.ocr_mark_selection import select_open_stroke_rect_indexes

    if not blocks or not strokes:
        return list(blocks), [list(blocks)]
    selected: list[dict[str, Any]] = []
    segments: list[list[dict[str, Any]]] = []
    seen_keys: set[str] = set()
    for stroke in strokes:
        closed = stroke_is_closed(stroke)
        region = stroke_xywh(stroke)
        open_indexes: set[int] = set()
        if not closed:
            open_indexes = set(select_open_stroke_rect_indexes(
                [block.get("rect") for block in blocks],
                stroke,
            ))
        segment_blocks: list[dict[str, Any]] = []
        for block_index, block in enumerate(blocks):
            rect = _rect_of(block)
            if rect is None:
                continue
            if closed:
                if (
                    not block_center_in_region(rect, region)
                    and block_overlap_ratio(rect, region) <= 0.30
                ):
                    continue
            elif block_index not in open_indexes:
                continue
            key = json.dumps(block, ensure_ascii=False, sort_keys=True)
            if key not in seen_keys:
                seen_keys.add(key)
                selected.append(block)
            segment_blocks.append(block)
        if segment_blocks:
            segments.append(sort_blocks_reading_order(segment_blocks))
    if not selected:
        return [], []
    return sort_blocks_reading_order(selected), segments


def filter_blocks_by_bbox(
    blocks: list[dict[str, Any]],
    selection_bbox: Any,
    *,
    padding: int = 8,
) -> list[dict[str, Any]]:
    if not blocks or not selection_bbox:
        return list(blocks)
    try:
        sx, sy, sw, sh = (float(value) for value in selection_bbox)
    except (TypeError, ValueError):
        return list(blocks)
    left, top = sx - padding, sy - padding
    right, bottom = sx + sw + padding, sy + sh + padding
    kept: list[dict[str, Any]] = []
    for block in blocks:
        rect = _rect_of(block)
        if rect is None:
            kept.append(block)
            continue
        try:
            bx, by, bw, bh = (float(value) for value in rect)
        except (TypeError, ValueError):
            kept.append(block)
            continue
        if bw <= 0 or bh <= 0:
            continue
        if bx < right and bx + bw > left and by < bottom and by + bh > top:
            kept.append(block)
    return kept


def capture_edge_state(
    capture_path: str | Path,
    blocks: list[dict[str, Any]],
    *,
    offset_x: int = 0,
    offset_y: int = 0,
    margin: int = 14,
) -> tuple[bool, list[int] | None]:
    try:
        from PIL import Image

        with Image.open(capture_path) as image:
            width, height = image.size
    except Exception:
        return False, None
    for block in blocks:
        rect = _rect_of(block)
        if rect is None:
            continue
        try:
            x = float(rect[0]) - offset_x
            y = float(rect[1]) - offset_y
            block_width = float(rect[2])
            block_height = float(rect[3])
        except (TypeError, ValueError):
            continue
        if (
            x <= margin or y <= margin
            or x + block_width >= width - margin
            or y + block_height >= height - margin
        ):
            return True, [int(width), int(height)]
    return False, [int(width), int(height)]


def _worker_connect(timeout: float = 3.0) -> Any:
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        if not OCR_WORKER_PORT_FILE.is_file():
            time.sleep(0.2)
            continue
        try:
            meta = json.loads(OCR_WORKER_PORT_FILE.read_text(encoding="utf-8"))
            port = int(meta.get("port") or 0)
            if port > 0:
                return socket.create_connection(("127.0.0.1", port), timeout=2.0)
        except Exception:
            time.sleep(0.2)
    return None


def _spawn_worker() -> None:
    try:
        subprocess.Popen(
            [sys.executable, str(OCR_WORKER_SCRIPT)],
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        pass


def _worker_reachable(timeout: float = 0.2) -> bool:
    try:
        meta = json.loads(OCR_WORKER_PORT_FILE.read_text(encoding="utf-8"))
        port = int(meta.get("port") or 0)
    except Exception:
        return False
    if port <= 0:
        return False
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=max(0.05, timeout)):
            return True
    except OSError:
        return False


def prewarm_ocr_worker(*, wait_s: float = 0.0) -> bool:
    if _worker_reachable():
        return True
    _spawn_worker()
    if wait_s <= 0:
        return False
    import time

    deadline = time.time() + max(0.0, float(wait_s))
    while time.time() < deadline:
        if _worker_reachable():
            return True
        time.sleep(0.1)
    return False


def _worker_request(
    capture_path: str | Path,
    *,
    strokes_local: list[list[tuple[int, int]]] | None = None,
    selection_local: list[int] | None = None,
    timeout: float = 10.0,
) -> tuple[list[dict[str, Any]], str] | None | str:
    sock = _worker_connect(timeout=2.0)
    if sock is None:
        _spawn_worker()
        sock = _worker_connect(timeout=30.0)
    if sock is None:
        return None
    try:
        request = {
            "id": 1,
            "path": str(capture_path),
            "strokes_local": [list(stroke) for stroke in (strokes_local or [])],
            "selection_bbox_local": selection_local,
        }
        sock.sendall((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
        sock.settimeout(timeout)
        buffer = b""
        while b"\n" not in buffer:
            chunk = sock.recv(65536)
            if not chunk:
                break
            buffer += chunk
            if len(buffer) > 4 * 1024 * 1024:
                raise RuntimeError("ocr worker response too large")
        line = buffer.split(b"\n", 1)[0].strip()
        response = json.loads(line.decode("utf-8"))
        if response.get("ok") is True and response.get("blocks") is not None:
            return list(response["blocks"]), str(response.get("engine") or "rapidocr-onnx")
        if response.get("error") == "worker_busy":
            return _OCR_BUSY
        return None
    except Exception:
        return _OCR_UNAVAILABLE
    finally:
        try:
            sock.close()
        except Exception:
            pass


_RAPID_OCR_INSTANCE: Any = None


def _rapid_ocr() -> Any:
    global _RAPID_OCR_INSTANCE
    if _RAPID_OCR_INSTANCE is None:
        from app.perception.ocr_engine import create_ocr_engine

        _RAPID_OCR_INSTANCE = create_ocr_engine()
    return _RAPID_OCR_INSTANCE


def read_ocr_blocks(
    capture_path: str | Path,
    *,
    strokes_local: list[list[tuple[int, int]]] | None = None,
    selection_local: list[int] | None = None,
) -> tuple[list[dict[str, Any]], str] | None:
    worker_result = _worker_request(
        capture_path,
        strokes_local=strokes_local,
        selection_local=selection_local,
    )
    if worker_result == _OCR_BUSY:
        return [], OCR_WORKER_BUSY_ENGINE
    if worker_result == _OCR_UNAVAILABLE:
        return None
    if worker_result is not None:
        return worker_result  # type: ignore[return-value]
    return read_ocr_blocks_cold(capture_path)


def read_ocr_blocks_cold(
    capture_path: str | Path,
) -> tuple[list[dict[str, Any]], str] | None:
    path = Path(capture_path)
    if not path.is_file():
        return None
    blocks: list[dict[str, Any]] = []
    try:
        import numpy as np

        result = _rapid_ocr()(str(path))
        txts = list(result.txts or ())
        boxes_arr = np.asarray(result.boxes) if getattr(result, "boxes", None) is not None else None
        scores = getattr(result, "scores", None)
        score_values: list[float] = []
        if scores is not None:
            try:
                score_values = [float(item) for item in list(scores)]
            except (TypeError, ValueError):
                score_values = []
        for index, raw_text in enumerate(txts):
            text = str(raw_text or "").strip()
            if not text:
                continue
            block: dict[str, Any] = {"text": text, "rect": None, "conf": None}
            if index < len(score_values):
                block["conf"] = score_values[index]
            if boxes_arr is not None and boxes_arr.ndim == 3 and index < boxes_arr.shape[0]:
                box = boxes_arr[index].tolist()
                try:
                    xs = [float(point[0]) for point in box]
                    ys = [float(point[1]) for point in box]
                    if xs and ys:
                        block["rect"] = [
                            int(round(min(xs))),
                            int(round(min(ys))),
                            int(round(max(xs) - min(xs))),
                            int(round(max(ys) - min(ys))),
                        ]
                except (TypeError, ValueError, IndexError):
                    pass
            blocks.append(block)
        if blocks:
            return blocks, "rapidocr-onnx"
    except Exception:
        pass
    try:
        from app.fabric.executors import FabricExecutors

        executor = FabricExecutors(root=ROOT)
        text = str(executor._default_ocr(path) or "").strip()
        if text:
            return [{"text": text, "rect": None, "conf": None}], str(
                executor.last_ocr_engine or "tesseract"
            )
    except Exception:
        pass
    return None


class FrozenFrameOcrProvider:

    def __init__(
        self,
        *,
        provider_id: str = "frozen-frame-ocr",
        annotated_path: str | None = None,
        label: str = "THIS",
        reader: Any = None,
    ) -> None:
        self.descriptor = ProviderDescriptor(
            id=provider_id,
            layer="ocr",
            tier=TIER_PIXEL,
            priority=40,
            requires_frozen_pixels=True,
        )
        self._annotated_path = annotated_path
        self._label = label
        self._reader = reader or read_ocr_blocks

    def read(self, request: PerceptionRequest) -> ProviderResult:
        capture_path = str(request.frozen_artifact_path or "").strip()
        if not capture_path or not Path(capture_path).is_file():
            return ProviderResult(
                context=None,
                status=EvidenceStatus.UNSUPPORTED,
                reason="frozen_artifact_missing",
            )
        offset_x, offset_y = _artifact_offset(request.frozen_artifact_bbox)
        has_mapping = request.frozen_artifact_bbox is not None
        strokes_screen = gesture_strokes(request.gesture)
        strokes_local = (
            [
                [(x - offset_x, y - offset_y) for (x, y) in stroke]
                for stroke in strokes_screen
            ]
            if has_mapping and strokes_screen
            else None
        )
        selection_local = None
        if has_mapping and request.mark_bbox is not None:
            selection_local = [
                int(request.mark_bbox[0]) - offset_x,
                int(request.mark_bbox[1]) - offset_y,
                int(request.mark_bbox[2]),
                int(request.mark_bbox[3]),
            ]
        read = self._reader(
            capture_path,
            strokes_local=strokes_local,
            selection_local=selection_local,
        )
        if not read:
            return ProviderResult(
                context=None,
                status=EvidenceStatus.ERROR,
                reason="ocr_unavailable",
            )
        blocks, engine = read
        if engine == OCR_WORKER_BUSY_ENGINE:
            return ProviderResult(
                context=None,
                status=EvidenceStatus.BUSY,
                reason="ocr_worker_busy",
            )
        blocks = _blocks_to_screen(list(blocks), offset_x, offset_y)
        unlocated = any(
            str(block.get("text") or "").strip() and _rect_of(block) is None
            for block in blocks
        )
        if unlocated:
            selected_blocks, segments = [], []
            text = "\n".join(
                str(block.get("text") or "").strip()
                for block in blocks if str(block.get("text") or "").strip()
            )
        elif strokes_screen:
            selected_blocks, segments = filter_blocks_by_strokes(blocks, strokes_screen)
            segment_texts = [
                text for text in (ocr_blocks_to_text(segment) for segment in segments if segment)
                if text
            ]
            if len(segment_texts) > 1:
                text = "\n".join(
                    f"[segment {index}] {item}"
                    for index, item in enumerate(segment_texts, 1)
                )
            else:
                text = "\n".join(segment_texts)
        else:
            selected_blocks = filter_blocks_by_bbox(
                blocks,
                list(request.mark_bbox) if has_mapping and request.mark_bbox else None,
            )
            segments = []
            text = "\n".join(
                str(block.get("text") or "").strip()
                for block in selected_blocks
                if str(block.get("text") or "").strip()
            ).strip()
        if not text:
            return ProviderResult(context=None, reason="ocr_no_text_at_mark")
        edge_clipped, capture_size = capture_edge_state(
            capture_path,
            selected_blocks,
            offset_x=offset_x,
            offset_y=offset_y,
        )
        rects = [
            list(rect)
            for rect in (_rect_of(block) for block in selected_blocks)
            if rect is not None
        ][:MAX_CAPTURED_RECTS]
        artifacts: dict[str, Any] = {
            "capture_path": capture_path,
            "annotated_path": self._annotated_path or "",
            "ocr_engine": engine,
            "ocr_full_screen": True,
            "ocr_block_count_total": len(blocks),
            "ocr_block_count_selected": len(selected_blocks),
            "ocr_stroke_filter": bool(strokes_screen) and not unlocated,
            "ocr_text_scope": "unlocated" if unlocated else "mark",
            "ocr_segment_count": len(segments),
            "ocr_selection_bbox": (
                list(request.mark_bbox) if request.mark_bbox is not None else None
            ),
            "ocr_edge_clipped": edge_clipped,
            "ocr_capture_size": capture_size,
            "captured_rects": rects,
            "captured_rects_source": "pixel",
            "selection_rectangles": rects,
            "selection_rectangles_format": "xywh",
            "selection_rectangles_coordinate_space": "physical_screen_pixels",
        }
        return ProviderResult(
            status=EvidenceStatus.DEGRADED if unlocated else None,
            reason="ocr_geometry_unavailable" if unlocated else "",
            context=AdapterReadContext(
                adapter="local_ocr",
                app="screen",
                window=dict(request.window),
                content=text,
                label=self._label,
                method=f"local:{engine}",
                artifacts=artifacts,
            ),
            payload={
                "engine": engine,
                "blockCountTotal": len(blocks),
                "blockCountSelected": len(selected_blocks),
                "segmentCount": len(segments),
                "edgeClipped": edge_clipped,
            },
            limitations=(
                (("ocr_geometry_unavailable",) if unlocated else ())
                + (("edge_clipped",) if edge_clipped else ())
            ),
        )


def _artifact_offset(bounds: Any) -> tuple[int, int]:
    if not isinstance(bounds, (list, tuple)) or len(bounds) != 4:
        return 0, 0
    try:
        return int(bounds[0]), int(bounds[1])
    except (TypeError, ValueError):
        return 0, 0


def _blocks_to_screen(
    blocks: list[dict[str, Any]],
    offset_x: int,
    offset_y: int,
) -> list[dict[str, Any]]:
    if not offset_x and not offset_y:
        return blocks
    mapped: list[dict[str, Any]] = []
    for block in blocks:
        rect = _rect_of(block)
        if rect is not None:
            try:
                block = {
                    **block,
                    "rect": [
                        int(rect[0]) + offset_x,
                        int(rect[1]) + offset_y,
                        int(rect[2]),
                        int(rect[3]),
                    ],
                }
            except (TypeError, ValueError):
                pass
        mapped.append(block)
    return mapped
