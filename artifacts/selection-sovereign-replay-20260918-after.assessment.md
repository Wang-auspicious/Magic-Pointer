# Historical frozen-selection replay after the September 18 fixes

One real configured-default Provider run completed through `scripts/selection_bridge.py::_loop_router`, using a new session `b1094bb5-3f58-4fa0-87c1-1886ae380a21`, plan permissions, and in-loop reversible execution disabled. It took 47,944.97 ms and 3 model turns; `usedBackend` was `magic_pointer.messages_multiturn_streaming`. No second attempt was made.

The replay reused the persisted frozen image `data/runtime/frame-leases/frame-77cd6b736b74471b.png`, its saved OCR context, command, and physical selection `[2505, 206, 598, 482]`. The original raw gesture points were unavailable; the baseline report's closed rectangle was retained. No expected answer was added to the model input. Original session history was not seeded into the new session. The original historical JSONL was not written; its size and modification time remained unchanged.

The complete result is in `selection-sovereign-replay-20260918-after.json`; progress is in `selection-sovereign-replay-20260918-after.progress.log`; the exact one-run harness is in `selection-sovereign-replay-20260918-after.py`.

## Observed result

- **Look error transparency passed this real run.** The vision receipt now includes the actual failure `vision_unavailable: AI 调用失败：模型端点限流中（HTTP 429）…截图和对象已保存在本地。` The previous generic `vision_unavailable` did not identify this cause. Tool latency was 2,959.57 ms.
- **The prior wrong-number substitution did not recur, but this run did not actively challenge the boundary with changed panel numbers.** The final answer used the frozen OCR number `+17,726`, and did not repeat the earlier replay's live values `+19,542 / -1,944`. `Observe` still ran against `live_surface`, at `2026-09-17T16:31:53.955+00:00`; its 100 returned UI elements contained no `Changes`, `Environment`, `Compare branch`, or the old/new panel numbers. Thus this run cannot prove how the model would handle a conflicting live panel number. It establishes only that no numeric time mixing was observed in this response.
- **Overall object explanation still fails factual acceptance.** The answer described `+17,726` as the repository's total commits or contributions. Direct inspection of the saved image shows a `Changes` row with added/deleted line counts `+17,726 / -1,227`. The answer also reconstructed the branch glyph/OCR fragment `℃ main` as `on main`, which is unsupported. The frozen OCR is incomplete, and the vision call was rate limited; the model nevertheless assigned a confident meaning to the ambiguous count.

This replay therefore supports the narrower claims that the real Look failure is now visible and the previous numeric time mixing did not recur. It does not support claiming that the selected interface is now explained correctly end to end. No production files or configuration were changed for this validation.
