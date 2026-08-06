# Google Magic Pointer Alignment

Updated: 2026-07-10

This document records the public evidence, local-demo observations, and
human-use constraints that should steer implementation. It is deliberately
more conservative than copying a demo animation.

## Public Evidence

Google DeepMind published "Reimagining the mouse pointer for the AI era" on
2026-05-12. The useful product principles are:

- maintain the user's flow across applications;
- capture visual and semantic context through pointing;
- let short references such as "this", "that", and "here" carry intent;
- turn pointed-at pixels into structured, actionable entities.

The same page says its demo sequences were shortened. Demo timing therefore
must not be treated as latency evidence.

Google's 2026-05-12 Googlebook announcement adds two concrete interaction
details: wiggle activates Magic Pointer, and the pointer offers quick,
contextual suggestions near what the user points at.

Early public hands-on feedback is an important counterweight. PCWorld reported
that a simple image move took several seconds and that a two-target directions
task required repeated attempts; by the time it worked, typing the full prompt
felt easier. Public discussion also questions mandatory voice in shared spaces.

## Local Demo Reading

The local `演示1` through `演示20` assets and generated contact sheets repeatedly
show the same durable pattern:

- the source application remains the main workspace;
- a pointed object becomes a visible referent;
- actions are short and local, such as move, merge, add, or double;
- glow and trails are transient feedback, not a permanent replacement cursor;
- results are meant to continue the current task instead of opening a separate
  chat destination.

The animations are evidence for interaction hierarchy, not proof that the
underlying grounding or generation is fast and reliable.

## V1 Decision: Frozen Object Session

V1 binds a real native Word/WPS text selection before Magic Pointer takes
focus. The resulting panel shows `THIS`, source identity, a short excerpt, and
compact actions. Every command and proposed write remains attached to the
originating short-lived session.

Human-use requirements:

- normal click, drag, selection, and scrolling remain owned by the host app;
- capture happens before panel focus changes the foreground window;
- the user can see what `THIS` means before issuing a command;
- stale model responses cannot replace a newer session;
- write actions require explicit confirmation and live document/range/hash
  verification;
- wiggle remains a low-impact aura until false-positive behavior is measured;
- the panel starts as a local tool, not a conversation transcript.

Measured on a real unsaved Microsoft Word document:

- direct native selection snapshot: 356-428 ms;
- full Electron hotkey capture and panel reveal: about 560-770 ms;
- selected text, document identity, range, UTF-8 text, and action suggestions
  remained correct;
- native Word highlighting stayed visible after the panel received focus.

## Intentional Differences From Google's Demo

- Voice is optional, not required.
- Wiggle does not yet open a focus-stealing panel.
- Multi-object gestures are deferred until one-object grounding is trustworthy.
- Native application selection outranks screenshot/OCR inference.
- Potential writes are proposals with confirmation, not immediate model actions.
- Failure closes the capability instead of guessing a background object.

These differences respond directly to the public friction: pointing only wins
when it removes context-setting work without adding retries, latency, or target
ambiguity.

## V2 Result: Browser and PDF Native Selection

V2 extends the same frozen-session contract to browser, PDF, and compatible
Chromium application text selections through Windows UI Automation.

Completed behavior:

- reads `TextPattern.GetSelection()` from the exact foreground HWND;
- never sends `Ctrl+C`, types into the host, or changes the clipboard;
- checks the UIA process identity against the selected top-level window;
- exposes source label, excerpt, text hash, selection rectangles, and read-only
  capability before AI execution;
- distinguishes browser, PDF, and generic application selections;
- fails closed on empty selection, identity mismatch, timeout, or an unsupported
  foreground window;
- leaves normal native selection and highlighting visible.

Real reference-machine evidence:

- Edge HTML selection: 49 characters, 602 ms full snapshot, clipboard unchanged;
- Edge PDF selection: 43 characters, 643 ms full snapshot, clipboard unchanged;
- warm Electron PDF hotkey: 805 ms capture and 827 ms panel reveal;
- cold Electron PDF hotkey after process restart: about 1.1 seconds.

The product is now close to the sub-second target in the warm path without
using a clipboard shortcut or browser extension.

## V3 Priority

Use the captured selection rectangles to place the compact panel where it does
not cover `THIS`, while keeping cursor proximity and multi-monitor DPI safety.
This improves the pointer-native feel without adding multi-target ambiguity or
mandatory voice.

Only after placement is reliable should the product test richer wiggle
activation or multi-object `THIS/THAT` gestures.
