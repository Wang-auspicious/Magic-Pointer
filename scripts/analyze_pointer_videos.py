
from __future__ import annotations

import csv
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "runtime" / "frame_trajectory_analysis"
OUT.mkdir(parents=True, exist_ok=True)
VIDEO_FILES = sorted(ROOT.glob("*.webm"))

def video_label(video: Path) -> str:
    m = re.search(r"(\d+)", video.stem)
    return f"demo{m.group(1)}" if m else video.stem.encode("ascii", "ignore").decode("ascii") or "video"

@dataclass
class Candidate:
    x: float
    y: float
    score: float
    area: int
    w: int
    h: int
    motion: float
    contrast: float


def _components(mask: np.ndarray):
    n, labels, stats, cent = cv2.connectedComponentsWithStats(mask, 8)
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area <= 0:
            continue
        yield int(x), int(y), int(w), int(h), int(area), float(cent[i][0]), float(cent[i][1])


def cursor_candidates(frame: np.ndarray, prev: np.ndarray | None, scale: float = 0.25) -> list[Candidate]:
    small = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    # Standard cursor in the captured demos is mostly white with a dark edge.
    # Limit to compact white components, then score by local contrast and motion.
    b, g, r = cv2.split(small)
    white = ((r > 215) & (g > 215) & (b > 215)).astype(np.uint8) * 255
    white = cv2.morphologyEx(white, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    if prev is not None:
        prev_s = cv2.resize(prev, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_AREA)
        diff = cv2.absdiff(gray, cv2.cvtColor(prev_s, cv2.COLOR_BGR2GRAY))
    else:
        diff = np.zeros_like(gray)

    cands: list[Candidate] = []
    H, W = gray.shape
    for x, y, w, h, area, cx, cy in _components(white):
        if not (5 <= w <= 75 and 5 <= h <= 75 and 12 <= area <= 1900):
            continue
        ratio = max(w / max(h, 1), h / max(w, 1))
        if ratio > 4.0:
            continue
        pad = 5
        x0, y0 = max(0, x - pad), max(0, y - pad)
        x1, y1 = min(W, x + w + pad), min(H, y + h + pad)
        patch = gray[y0:y1, x0:x1]
        dpatch = diff[y0:y1, x0:x1]
        if patch.size == 0:
            continue
        contrast = float(patch.std())
        motion = float(dpatch.mean())
        # Cursor-like components are compact, high-contrast, and often moving.
        compact_penalty = abs(w - h) * 0.08 + area * 0.002
        score = contrast * 0.9 + motion * 2.2 - compact_penalty
        cands.append(Candidate(cx / scale, cy / scale, score, area, int(w/scale), int(h/scale), motion, contrast))
    cands.sort(key=lambda c: c.score, reverse=True)
    return cands[:12]


def choose_path(all_cands: list[list[Candidate]], frame_w: int, frame_h: int) -> list[Candidate | None]:
    path: list[Candidate | None] = []
    last: Candidate | None = None
    missing = 999
    for idx, cands in enumerate(all_cands):
        viable = [c for c in cands if c.score > 18]
        chosen = None
        if viable:
            if last is None or missing > 12:
                # Prefer high score but avoid exact corners/status text by weak center prior.
                def start_score(c: Candidate) -> float:
                    dx = (c.x - frame_w * 0.5) / frame_w
                    dy = (c.y - frame_h * 0.5) / frame_h
                    return c.score - 12 * math.sqrt(dx * dx + dy * dy)
                chosen = max(viable, key=start_score)
            else:
                pred_x, pred_y = last.x, last.y
                def track_score(c: Candidate) -> float:
                    d = math.hypot(c.x - pred_x, c.y - pred_y)
                    return c.score - min(d, 420) * 0.16
                best = max(viable, key=track_score)
                if track_score(best) > 8:
                    chosen = best
        if chosen is None:
            path.append(None)
            missing += 1
        else:
            path.append(chosen)
            last = chosen
            missing = 0
    return path


def smooth_path(path: list[Candidate | None]) -> list[tuple[float | None, float | None]]:
    pts: list[tuple[float | None, float | None]] = [(p.x, p.y) if p else (None, None) for p in path]
    # Median smoothing over visible spans.
    out = []
    for i, (x, y) in enumerate(pts):
        if x is None:
            out.append((None, None))
            continue
        xs, ys = [], []
        for j in range(max(0, i-2), min(len(pts), i+3)):
            if pts[j][0] is not None:
                xs.append(float(pts[j][0])); ys.append(float(pts[j][1]))
        out.append((float(np.median(xs)), float(np.median(ys))))
    return out


def make_overlay(video: Path, frames: list[np.ndarray], smooth: list[tuple[float | None, float | None]], motion_scores: list[float]) -> Path:
    # Downscaled temporal median background keeps this fast and readable.
    ds = 0.35
    picks = np.linspace(0, len(frames)-1, min(18, len(frames))).astype(int)
    smalls = [cv2.resize(frames[i], None, fx=ds, fy=ds, interpolation=cv2.INTER_AREA) for i in picks]
    bg = np.median(np.stack(smalls, axis=0), axis=0).astype(np.uint8)
    overlay = bg.copy()
    pts = [(int(x*ds), int(y*ds)) for x, y in smooth if x is not None and y is not None]
    if len(pts) >= 2:
        # Draw full trajectory with time gradient.
        for k in range(1, len(pts)):
            t = k / max(1, len(pts)-1)
            color = (int(255 * (1-t)), int(120 + 100*t), 255)  # BGR purple->cyan-ish
            cv2.line(overlay, pts[k-1], pts[k], color, 4, cv2.LINE_AA)
        for k in range(0, len(pts), max(1, len(pts)//30)):
            cv2.circle(overlay, pts[k], 10, (255, 255, 255), 2, cv2.LINE_AA)
    out = OUT / f"{video_label(video)}_trajectory_overlay.jpg"
    cv2.imwrite(str(out), overlay)
    return out


def analyze_video(video: Path) -> dict:
    cap = cv2.VideoCapture(str(video))
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 24.0)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    frames: list[np.ndarray] = []
    all_cands: list[list[Candidate]] = []
    motion_scores: list[float] = []
    prev = None
    ok, frame = cap.read()
    while ok:
        frames.append(frame.copy())
        if prev is not None:
            g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            pg = cv2.cvtColor(prev, cv2.COLOR_BGR2GRAY)
            motion_scores.append(float(cv2.absdiff(g, pg).mean()))
        else:
            motion_scores.append(0.0)
        all_cands.append(cursor_candidates(frame, prev))
        prev = frame.copy()
        ok, frame = cap.read()
    cap.release()
    if not frames:
        return {"video": video.name, "error": "no frames"}
    h, w = frames[0].shape[:2]
    path = choose_path(all_cands, w, h)
    smooth = smooth_path(path)
    csv_path = OUT / f"{video_label(video)}_frame_trajectory.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["frame", "time_sec", "cursor_x", "cursor_y", "raw_score", "raw_area", "raw_w", "raw_h", "motion_score", "visible"])
        for i, p in enumerate(path):
            sx, sy = smooth[i]
            writer.writerow([
                i, round(i / fps, 4),
                "" if sx is None else round(sx, 2),
                "" if sy is None else round(sy, 2),
                "" if p is None else round(p.score, 3),
                "" if p is None else p.area,
                "" if p is None else p.w,
                "" if p is None else p.h,
                round(motion_scores[i], 4),
                0 if p is None else 1,
            ])
    overlay_path = make_overlay(video, frames, smooth, motion_scores)
    # Event segmentation by motion peaks and cursor visible spans.
    visible = [i for i, p in enumerate(path) if p is not None]
    spans = []
    if visible:
        start = prev_i = visible[0]
        for i in visible[1:]:
            if i - prev_i > 5:
                spans.append((start, prev_i))
                start = i
            prev_i = i
        spans.append((start, prev_i))
    arr = np.array(motion_scores)
    threshold = float(np.percentile(arr, 85)) if len(arr) else 0.0
    event_frames = [int(i) for i, v in enumerate(arr) if v >= threshold and i > 0]
    event_spans = []
    if event_frames:
        s = p = event_frames[0]
        for i in event_frames[1:]:
            if i - p > 3:
                event_spans.append((s, p))
                s = i
            p = i
        event_spans.append((s, p))
    summary = {
        "video": video.name,
        "fps": fps,
        "frames": len(frames),
        "width": w,
        "height": h,
        "duration_sec": len(frames) / fps,
        "cursor_visible_frames_detected": len(visible),
        "cursor_visible_ratio": len(visible) / len(frames),
        "cursor_spans": [{"start_frame": a, "end_frame": b, "start_sec": a/fps, "end_sec": b/fps} for a,b in spans],
        "high_motion_spans": [{"start_frame": a, "end_frame": b, "start_sec": a/fps, "end_sec": b/fps} for a,b in event_spans[:20]],
        "trajectory_csv": str(csv_path.relative_to(ROOT)),
        "trajectory_overlay": str(overlay_path.relative_to(ROOT)),
    }
    return summary


def main():
    summaries = []
    for v in VIDEO_FILES:
        print("analyzing", v.name)
        summaries.append(analyze_video(v))
    (OUT / "summary.json").write_text(json.dumps(summaries, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summaries, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
