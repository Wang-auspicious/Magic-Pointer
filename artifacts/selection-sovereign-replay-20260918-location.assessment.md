# Final independent selectionLocation production replay

**Strict end-to-end acceptance is still not satisfied.** This single new run correctly identifies ChatGPT Desktop, names Environment, and explains `+17,726 / -1,227` as added/deleted lines. It no longer invents a bottom/left position or VS Code host. It does not explicitly state the correct top-right position, and still incorrectly treats `Pull request status unavailable` as proof that no remote PR is associated. No further replay was made.

The current production InputArtifact supplied a deterministic WINDOW `selectionLocation` of `top-right`, calculated by the production implementation. The fresh actual OCR was formed by direct current `worker.process` in a new process and then `FrozenFrameOcrProvider`/`PerceptionBroker`; no old OCR context or compiled InputArtifact was reused. It recovered the complete Environment menu in **3048.30 ms**.

The plan-only production `_loop_router` used new session `0409f624-676b-4228-b804-aeaf5e77a933` and unchanged default Provider/configuration. It took **33,623.53 ms**, three model turns, with `usedBackend=magic_pointer.messages_multiturn_streaming`. In-loop reversible execution was disabled. The original full-frame PNG and original historical JSONL retained their size and modification time.

The actual Look request retained a **679 × 610** selected-detail primary plus the same original **3120 × 2080** historical full frame labeled context-only. It returned explicit **HTTP 429** after **3725.86 ms**. There was no Observe call and no live-number substitution.

The transparent response-parser recorder was prepared to retain only provider `stop_reason`, `choices[].finish_reason`, and `usage`, then invoke the unmodified parser. Because this vision request failed with HTTP 429 before successful completion parsing, none of those successful-response metadata fields were available. This run does not determine why the earlier 194-character successful description stopped mid-sentence. Model budget, configuration, attempt count, and response parsing behavior were not changed.

The actual final response says `Pull request status unavailable — 还没关联远程 PR`. The visible unavailable status does not establish that cause. This remaining unsupported assertion is sufficient to fail the requested no-invented-service-reason condition, independent of the omitted top-right wording.

Complete evidence: `selection-sovereign-replay-20260918-location.json`, `.progress.log`, and the `.py` harness. The current WINDOW fact, two-image request metadata, actual tool receipts, and final answer are preserved in the JSON. No production code or configuration was edited for this last validation.
