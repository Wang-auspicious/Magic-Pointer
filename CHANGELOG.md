# Changelog

## v0.0.1 - MVP0

- Added Windows desktop prototype using Tkinter.
- Added `Ctrl + Alt + M` global hotkey polling.
- Added region selection overlay and screenshot capture.
- Added OpenAI multimodal model integration with no-key fallback.
- Added local object logging in JSONL.
- Added README, AGI distance tracking, smoke test, MIT license.

## Unreleased

- Added local `secrets/*.txt` config fallback for API key/base URL/model.
- Switched AI call path to direct OpenAI-compatible HTTP chat completions for 78code compatibility.
- Verified 78code `gpt-5.4-mini` text and vision calls.

- Added background mode, no-console VBS launcher, and mouse-shake trigger.
- Improved prompt/result dialog: visible primary send button, non-selectable hint label, Ctrl+Enter send, larger resizable window.
- Redesigned prompt window into a cleaner card layout; removed explanatory gray hint text; simplified actions.
- Relaxed mouse-shake trigger thresholds so small left-right wiggles summon selection more reliably.
- Changed prompt dialog to left screenshot / right prompt+reply layout; Enter sends and Shift+Enter inserts newline.
- Added Windows visible-window metadata to reduce VLM-only mistakes when counting partially hidden windows.
- Added best-effort Windows Mica/Acrylic backdrop for a more modern glass-like window.

- Added general Screen Context foundation: z-ordered window metadata, overlap/visibility ratios, annotated object map image, and object-log persistence.
- Right-click now cancels region selection.
- Mouse-shake trigger is more responsive with lower thresholds and shorter cooldown.
- Reworked mouse-shake trigger into a fixed three-reversal left-right gesture to reduce accidental triggers while keeping low latency.
- Added gesture smoke test.

- Started MVP1 object registry: recent objects, this/that/group reference context, history image attachment for comparison/merge prompts, and continue-select flow.
- Added object store test.

- Optimized outbound vision images as bounded JPEG data URLs to reduce gateway failures.
- Added retry and primary-image fallback for transient SSL/connection errors from OpenAI-compatible gateways.
- Limited extra reference images per request to keep multimodal payload stable.

- Fixed this/that reversal risk by labeling every multimodal image: IMAGE A=THIS current object, IMAGE B=THAT previous object.
- Comparison prompts now attach only the immediate previous object by default to avoid historical image confusion.
- Added coreference guard instructing the model never to swap ??/?? with ???/??.

- Added MVP1-beta explicit object panel: recent object thumbnails, THIS/THAT/GROUP badges, pin/unpin, clear group, and pin-current-after-send.
- Added persistent explicit group state in `data/objects/object_state.json`.
- Changed group/merge prompts to use the explicit pinned group instead of implicit recent history; compare-with-previous still uses THAT.
- Expanded object store tests for explicit group management.

- Revised MVP1-beta direction: removed default historical thumbnail panel and persistent manual pin group from active model context.
- Added hidden current-task context with `TaskContextStore`, 30-minute idle rollover, explicit new task, and previous-task restore.
- Changed `THIS/THAT/GROUP` semantics to be session-scoped: global object history is now diagnostic/log-only by default.
- Added `tests/task_context_test.py`.

- Enlarged and made the home/control window resizable to avoid clipped UI on Windows scaling.
- Added `MagicPointerPanel.vbs` for no-terminal visible panel startup; it stops an existing Magic Pointer process first, then launches the panel with `pythonw`.
- Added a `?????` button so users can keep hotkey/mouse listening without using the terminal.

- Fixed VBS launcher again: `pythonw` was not on PATH when launched by Windows Script Host, so the launcher now uses the user's Scoop Python path first.
- Added `data/runtime/launcher.log` for VBS launch attempts.
- Added `data/runtime/app_error.log` for silent `pythonw` startup failures.

- Fixed the home/control panel source text by using Unicode escape literals, preventing PowerShell/VBS editing from corrupting Chinese UI strings into `????`.
- Increased the home/control panel to `760x460` with minimum `700x420` to avoid clipped buttons and text.

- Added MVP1-gamma task-scoped `DESTINATION`: users can set/clear the current selection as the destination inside the current task.
- Added destination state to `TaskContextStore` and model context; commands like "there", "target", "????", "????" now resolve to the explicit current-task destination.
- Destination reference images are attached only when destination-like prompts are detected.
- Expanded task context tests for destination and task object registration.

- Added MVP1-delta interaction redesign: region selection now opens a compact pointer command bar instead of a large chat-style prompt window.
- Added quick actions: explain, compare, set destination, clear destination, execute, details, continue selection.
- Results now appear as a short action-card style result; the old large view is replaced by an on-demand details window.
- The command bar is positioned near the selected region and keeps task context hidden by default.

- Added MVP1-epsilon low-friction command capture: a `??` button focuses the command field and opens Windows dictation with Win+H, without adding microphone dependencies.
- Added context-aware suggested default prompts in the command bar: explain first object, compare when THAT exists, or prepare content for DESTINATION when available.
- Added a `???` quick action that uses current-task DESTINATION semantics.

