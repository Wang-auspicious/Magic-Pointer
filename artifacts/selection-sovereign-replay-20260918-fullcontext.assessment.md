# Frozen Look detail plus full-frame context

The production wiring is implemented and its regression tests pass. The real end-to-end identity/location acceptance remains **failed**: this one replay's Look request received HTTP 429, and the final answer still guessed an incorrect bottom-side position and unsupported Electron/VS Code architecture. This run cannot establish that the new full-frame visual context improves recognition when the vision service succeeds.

## Implementation and validation

Only `app/agent_runtime/vision_backend.py`, Look wiring in `app/harness/builtin_bundle.py`, and the new `tests/vision_context_test.py` were changed for this implementation. Both one-shot and resident loop rows pass the existing `capture_path` into Look. Look creates its own contextual `FileVisionBackend` instance; the shared live backend is unchanged.

The primary image remains the selected crop. The original full PNG is supplied as a labeled extra image: `FROZEN_FRAME_CONTEXT`, same historical capture timestamp, context only, not another target. Look's system prompt explicitly defines the detail as IMAGE A and the full view as same-frame context, not THAT or a previous target. This prevents the AI client's generic A/B comparison wording from relabeling the context image. No model budget was changed.

Two tests first failed on the missing full-frame extra, then passed after the implementation. They exercise the actual registered Look and Observe tools in both one-shot and resident harnesses, checking the crop bytes, unchanged full-frame bytes/path, context label, live-only Observe image, original shared backend, timeout/attempts, and temporary-file cleanup. Fresh relevant regression command:

```text
python -m pytest tests/vision_context_test.py tests/live_observer_test.py tests/agent_runtime_look_tool_test.py tests/harness_builtin_bundle_test.py -q
67 passed in 4.02s
```

## One real production replay

The fresh process directly ran current production OCR once and formed a new production perception context. OCR took **2917.45 ms**, recovering the full Environment menu including `Changes +17,726 -1,227`. The new plan-only loop took **35,639.36 ms**, three model turns, with `usedBackend=magic_pointer.messages_multiturn_streaming`. Original full-frame PNG and original historical JSONL retained size and modification time.

The acceptance harness transparently records vision request metadata, then delegates to the unchanged real `ask_vision_model`; responses are not mocked. Its `visionRequests` entry records a **679 × 610** detail primary and the exact **3120 × 2080** original frame as the labeled context extra. It records one attempt, 30-second timeout, and the context system contract.

Look returned `vision_unavailable` with the explicit HTTP 429 cause after **3297.22 ms**. There was no Observe call. The final answer correctly identifies ChatGPT Desktop and the added/deleted line counts, but incorrectly says the panel is at the bottom and asserts an Electron/VS Code architecture. No further model attempt was made.

## Output-length evidence

The preceding `-identity` replay's successful Look contained only 194 characters including its historical marker, ending mid-description at `1. 顶部标题区：* 左`. That is evidence of an incomplete answer. The current AI client's default is 1200 output tokens, but its string-only result drops provider finish reason and usage; the retained evidence does not establish that the 1200-token budget caused the truncation. The budget was therefore left unchanged.

Evidence: `selection-sovereign-replay-20260918-fullcontext.json`, `.progress.log`, and `.py` harness. Global verification and installed-app synchronization remain with the parent task.
