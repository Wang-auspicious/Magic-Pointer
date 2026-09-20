"""Small synthetic target-choice comparison; sends no desktop or user files."""
from __future__ import annotations
import json
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.desktop_actions.jev import JevTargetSelector
from app.ai_client import ask_text_model, get_ai_config, is_ai_failure

CASES = [
    ("exact-save", "Save", ["Save", "Send", "Cancel"], 0),
    ("archive", "Keep the message, but remove it from the inbox", ["Delete forever", "Archive", "Mark unread"], 1),
    ("negative", "Close the dialog without applying my edits", ["Apply changes", "Discard changes", "Save as"], 1),
    ("sheet-scope", "Only print this worksheet, not the entire workbook", ["Print active sheets", "Print entire workbook", "Export PDF"], 0),
    ("chinese", "把邮件留着，以后再看，不要删除", ["删除", "稍后提醒", "立即回复"], 1),
    ("abstain", "Turn on dark mode", ["Save", "Delete", "Reply"], None),
]


def main():
    selector = JevTargetSelector(budget_s=5)
    rows = []
    for case_id, target, labels, expected in CASES:
        candidates = [{"ref": f"@e{i}", "name": label, "role": "button"} for i, label in enumerate(labels)]
        exact = [i for i, label in enumerate(labels) if label.casefold() == target.casefold()]
        baseline = exact[0] if len(exact) == 1 else None
        chosen = selector.select(target, candidates, state_id=case_id)
        expected_ref = None if expected is None else f"@e{expected}"
        rows.append({"case": case_id, "target": target, "labels": labels, "expected": expected_ref,
            "localExact": None if baseline is None else f"@e{baseline}", "jev": chosen,
            "correct": chosen["ref"] == expected_ref})
        print(json.dumps(rows[-1], ensure_ascii=False), flush=True)
    # One compact comparison to the project's already configured subscription model.
    _, endpoint, model = get_ai_config()
    main_model = {"model": model, "endpoint": endpoint}
    if endpoint.startswith("https://opencode.ai/zen/go/"):
        prompt = "For each case choose an integer label index or null when none matches. Return one JSON object mapping case to index/null. No prose.\n" + json.dumps([{"case": c, "target": t, "labels": labels} for c, t, labels, _ in CASES], ensure_ascii=False)
        started = time.monotonic()
        answer = ask_text_model(prompt, max_tokens=220, timeout_s=20, attempts=1)
        main_model.update(elapsedMs=round((time.monotonic()-started)*1000, 2), answer=answer, failed=is_ai_failure(answer))
    output = {"cases": rows, "mainModelBatch": main_model, "scope": "Synthetic text candidates; not end-to-end visual accuracy. Jev limited to free model; no paid fallback."}
    path = Path(__file__).resolve().parents[1] / "docs/research/2026-09-20-jev-comparison.json"
    path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(main_model, ensure_ascii=False), flush=True)


if __name__ == "__main__": main()
