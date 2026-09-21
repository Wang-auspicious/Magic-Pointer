# Current production detail OCR and fresh Agent replay

The new production OCR fixes the missing selected-panel text, and the fresh real Agent run now correctly interprets `+17,726 / -1,227` as added/deleted lines. Overall interface-identification acceptance still fails: the answer incorrectly calls the area the left-hand VS Code Source Control panel; the original frozen frame shows the upper-right Codex Environment panel.

## Production OCR evidence

A new Python process imported the current `scripts/ocr_resident_worker.py` and directly called its `process` function once. It did not contact, restart, or replace an existing resident worker. The same actual result flowed through `FrozenFrameOcrProvider` and `PerceptionBroker` to create the new `AdapterReadContext`, including production row joining and rectangle metadata. No old six-fragment OCR context was reused.

The original 3120 × 2080 PNG and original historical JSONL remained unchanged by size and modification time. Detection cached both the full-frame pass and the detail region `[2394,142,3120,752]`; recognition still used original full-frame pixels. Actual production OCR processing took **4014.2 ms**, excluding engine initialization and detector-shape warming.

Actual production text:

```text
Environment
Changes +17,726 -1,227
Local
main
Commit or push
Pull request status unavailable
Compare branch
```

## Fresh real Agent result

The actual `_loop_router` ran once with unchanged default Provider configuration, `plan` permission, in-loop reversible execution disabled, and new session `3d719bc7-b02c-457f-b995-1045ded6fed8`. The loop took **27,304.96 ms**, with `usedBackend=magic_pointer.messages_multiturn_streaming`.

The result correctly says `新增 17,726 行，删除 1,227 行`. It called `Look` once (3272.26 ms), which explicitly returned `vision_unavailable` with the HTTP 429 rate-limit cause. It did not call `Observe`; no live numbers entered this response.

The result nonetheless says the panel is VS Code's left-hand source control area. That app/position identification is false and remains unsupported by the available evidence. The preserved InputArtifact's source title is `ChatGPT`; the actual screenshot shows Codex. This acceptance therefore establishes the OCR/text/count correction, not successful complete UI identification. No second model attempt was made.

Files: `selection-sovereign-replay-20260918-detail.json`, `selection-sovereign-replay-20260918-detail.progress.log`, and the exact reproducible harness `selection-sovereign-replay-20260918-detail.py`. No production or configuration edits were made by this validation.
