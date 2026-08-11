"""Vision model benchmark against the real desktop and the real product path.

Captures the whole screen (GDI, same source as the product's gdi-fallback),
runs the real perception pipeline (capture_snapshot) to inventory every piece
of evidence that would be handed to an agent, then asks a configured vision
model three questions (easy -> hard) about the authored benchmark scene.

Usage:
  python scripts/benchmark_vision_models.py --model qwen3.7-plus --report data/runtime/vision-bench/report-qwen.json
  python scripts/benchmark_vision_models.py --model mimo-v2.5   --report data/runtime/vision-bench/report-mimo.json

The benchmark scene is authored (data/runtime/vision-bench/), so the ground
truth of every question is known before any model is called.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.ai_client import ask_vision_model  # noqa: E402
from app.system_context import enable_dpi_awareness  # noqa: E402
from scripts.selection_snapshot_bridge import capture_snapshot  # noqa: E402

enable_dpi_awareness()

BENCH_DIR = ROOT / "data" / "runtime" / "vision-bench"

QUESTIONS: list[dict[str, str]] = [
    {
        "id": "q1_easy",
        "question": "看整块屏幕：现在桌面上能看到哪些应用窗口？最上方的浏览器窗口，它的主标题（页面标题）文字是什么？",
        "ground_truth": "窗口：浏览器（Edge/Chrome 类）+ 记事本；标题：MAGIC POINTER VISION BENCH 2026-08-11",
    },
    {
        "id": "q2_small_text",
        "question": "浏览器页面里有一段字号非常小的英文段落。请把它一字不差地完整读出来（包括中间的编码 A1B2-C3D4-E5F6）。",
        "ground_truth": "The quick brown fox jumps over the lazy dog. A1B2-C3D4-E5F6. 中文小字测试：魔法指针视觉基准，第七行。",
    },
    {
        "id": "q3_image",
        "question": "浏览器页面里嵌入了一张图片。请回答四个子问题：(1) 图片背景是什么颜色？(2) 图中画了什么形状？(3) 图里最大的数字是多少？(4) 数字下方的小字写的是什么？",
        "ground_truth": "白底；红色圆环；数字 42；小字 PASS",
    },
]


def _inventory(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Reduce the real perception snapshot into a compact pre-agent inventory."""
    trace = snapshot.get("perception_trace") or {}
    context = snapshot.get("context") or {}
    structured_text = ""
    if isinstance(context, dict):
        for key in ("text", "content", "payload"):
            value = context.get(key)
            if isinstance(value, str) and value.strip():
                structured_text = value
                break
        if not structured_text:
            artifacts = context.get("artifacts") or {}
            for value in artifacts.values():
                if isinstance(value, str) and value.strip():
                    structured_text = value
                    break
    ocr_text = ""
    if isinstance(context, dict):
        for key in ("ocr_text", "ocrText", "recognized_text"):
            value = context.get(key)
            if isinstance(value, str) and value.strip():
                ocr_text = value
                break
    return {
        "source_kind": snapshot.get("source_kind"),
        "source_window": snapshot.get("source_window") or {},
        "capture_bbox": snapshot.get("capture_bbox"),
        "capture_path": snapshot.get("capture_path"),
        "selection_bbox": snapshot.get("selection_bbox"),
        "structured_covers_mark": snapshot.get("structured_covers_mark"),
        "structured_gap_reason": snapshot.get("structured_gap_reason"),
        "perception": {
            "selectedLayer": trace.get("selectedLayer"),
            "selectedAdapter": trace.get("selectedAdapter"),
            "selectedMethod": trace.get("selectedMethod"),
            "pixelFallbackUsed": trace.get("pixelFallbackUsed") is True,
            "fallbackReason": trace.get("fallbackReason"),
            "attempts": [
                {
                    "layer": attempt.get("layer"),
                    "adapter": attempt.get("adapter"),
                    "status": attempt.get("status"),
                    "reason": attempt.get("reason"),
                }
                for attempt in (trace.get("attempts") or [])
            ],
        },
        "structured_context_char_len": len(structured_text),
        "structured_context_sample": structured_text[:1200],
        "ocr_text_char_len": len(ocr_text),
        "ocr_text_sample": ocr_text[:1200],
    }


def _verdict(question: dict[str, str], answer: str) -> dict[str, Any]:
    """Honest partial-match verdict against authored ground truth."""
    lowered = answer.casefold()
    refused = ("未找到" in answer or "无法" in answer or "未识别" in answer or "not found" in lowered)
    checks: list[tuple[str, str]] = []
    if question["id"] == "q1_easy":
        checks = [
            ("窗口列表含浏览器", "edge" in lowered or "chrome" in lowered or "浏览器" in answer),
            ("窗口列表含记事本", "notepad" in lowered or "记事本" in answer),
            ("标题读出", "vision bench" in lowered or "2026-08-11" in answer),
        ]
    elif question["id"] == "q2_small_text":
        checks = [
            ("首句完整", "quick brown fox jumps over the lazy dog" in lowered),
            ("编码读出", "a1b2-c3d4-e5f6" in lowered and not refused),
            ("中文小字读出", "魔法指针视觉基准" in answer),
        ]
    elif question["id"] == "q3_image":
        checks = [
            ("背景白色", "白" in answer or "white" in lowered),
            ("红色形状", "红" in answer or "red" in lowered),
            ("数字 42", "42" in answer and not refused),
            ("小字 PASS", "pass" in lowered and not refused),
        ]
    matched = sum(1 for _, ok in checks if ok)
    return {
        "matched": matched,
        "total": len(checks),
        "checks": [{"label": label, "ok": ok} for label, ok in checks],
        "verdict": "pass" if matched == len(checks) else ("partial" if matched else "fail"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="vision model id to ask")
    parser.add_argument("--report", required=True, help="output report path")
    args = parser.parse_args()

    import os

    os.environ["MAGIC_POINTER_VISION_MODEL"] = args.model

    fullscreen = BENCH_DIR / "fullscreen.png"
    fullscreen.parent.mkdir(parents=True, exist_ok=True)

    from PIL import Image, ImageGrab

    image = ImageGrab.grab(all_screens=True)
    image.save(fullscreen)
    width, height = image.size

    snapshot_result = capture_snapshot(
        target_point={"x": width // 2, "y": height // 2},
        target_point_space="physical_screen_pixels",
        gesture={
            "coordinateSpace": "physical_screen_pixels",
            "strokes": [
                {
                    "points": [
                        {"x": 0, "y": 0, "t": 0},
                        {"x": width, "y": height, "t": 600},
                    ]
                }
            ],
        },
        target_hwnd=0,
        capture_dir=BENCH_DIR / "captures",
        default_capture_mode="local_screenshot",
        upload_screenshots=False,
        retain_captures_days=3,
        foreground_app="benchmark",
    )
    snapshot = (snapshot_result or {}).get("selectionSnapshot") or {}
    inventory = _inventory(snapshot)

    answers: list[dict[str, Any]] = []
    for question in QUESTIONS:
        started = time.time()
        answer = ask_vision_model(fullscreen, question["question"])
        elapsed_s = round(time.time() - started, 2)
        answers.append(
            {
                "id": question["id"],
                "question": question["question"],
                "ground_truth": question["ground_truth"],
                "elapsed_s": elapsed_s,
                "answer": answer,
                "verdict": _verdict(question, answer),
            }
        )

    report = {
        "model": args.model,
        "api_mode": os.environ.get("MAGIC_POINTER_VISION_API_MODE") or "default",
        "base_url": os.environ.get("MAGIC_POINTER_VISION_BASE_URL") or "default(go-gateway)",
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "image": {"path": str(fullscreen), "size_px": [width, height], "source": "gdi-ImageGrab"},
        "pre_agent_info": inventory,
        "questions": answers,
    }
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
