# Frame-Level Pointer Trajectory Study

Date: 2026-07-06

Scope: demo7.webm, demo8.webm, demo9.webm, demo10.webm. Each video was decoded frame by frame at 24 FPS. For every frame, the script recorded motion score and a heuristic cursor/object-attention candidate. Outputs are in `data/runtime/frame_trajectory_analysis/`.

Important caveat: exact cursor coordinates are heuristic because the demos contain lots of white UI text and animated cards. The reliable part is the frame-by-frame timing, motion bursts, and interaction rhythm. For pixel-perfect reproduction, the next step would be manual annotation or template tracking with a known cursor mask.

## 1. Generated files

- `演示10.webm` -> `data\runtime\frame_trajectory_analysis\demo10_frame_trajectory.csv`, `data\runtime\frame_trajectory_analysis\demo10_trajectory_overlay.jpg`
- `演示7.webm` -> `data\runtime\frame_trajectory_analysis\demo7_frame_trajectory.csv`, `data\runtime\frame_trajectory_analysis\demo7_trajectory_overlay.jpg`
- `演示8.webm` -> `data\runtime\frame_trajectory_analysis\demo8_frame_trajectory.csv`, `data\runtime\frame_trajectory_analysis\demo8_trajectory_overlay.jpg`
- `演示9.webm` -> `data\runtime\frame_trajectory_analysis\demo9_frame_trajectory.csv`, `data\runtime\frame_trajectory_analysis\demo9_trajectory_overlay.jpg`

## 2. Video metrics

| Video | Duration | Frames | FPS | Cursor/attention visible ratio | Reliable observation |
|---|---:|---:|---:|---:|---|
| 演示10.webm | 18.21s | 437 | 24 | 1.00 | continuous object-attention layer |
| 演示7.webm | 17.88s | 429 | 24 | 1.00 | continuous object-attention layer |
| 演示8.webm | 18.88s | 453 | 24 | 0.97 | continuous object-attention layer |
| 演示9.webm | 15.33s | 368 | 24 | 0.51 | cursor appears only during local edit phases |

## 3. Motion rhythm learned from frame data

The demos do not keep large UI moving all the time. Most frames are quiet. Motion happens in short bursts: hover, chip fade-in, processing state, local card expansion, then quiet again. This is important: the interface feels smooth because it is calm most of the time.

### 演示10.webm

- Duration: 18.21s, 437 frames at 24 FPS.
- High-motion bursts, first 8:
  - frames 5-20, 0.21s-0.83s
  - frames 28-32, 1.17s-1.33s
  - frames 36-40, 1.50s-1.67s
  - frames 70-70, 2.92s-2.92s
  - frames 96-96, 4.00s-4.00s
  - frames 113-113, 4.71s-4.71s
  - frames 120-122, 5.00s-5.08s
  - frames 128-128, 5.33s-5.33s
- Implementation lesson: use short 120-600 ms transitions, then settle. Do not animate constantly.

### 演示7.webm

- Duration: 17.88s, 429 frames at 24 FPS.
- High-motion bursts, first 8:
  - frames 7-10, 0.29s-0.42s
  - frames 20-20, 0.83s-0.83s
  - frames 29-31, 1.21s-1.29s
  - frames 40-40, 1.67s-1.67s
  - frames 44-46, 1.83s-1.92s
  - frames 60-60, 2.50s-2.50s
  - frames 68-68, 2.83s-2.83s
  - frames 90-97, 3.75s-4.04s
- Implementation lesson: use short 120-600 ms transitions, then settle. Do not animate constantly.

### 演示8.webm

- Duration: 18.88s, 453 frames at 24 FPS.
- High-motion bursts, first 8:
  - frames 10-10, 0.42s-0.42s
  - frames 24-25, 1.00s-1.04s
  - frames 32-32, 1.33s-1.33s
  - frames 41-41, 1.71s-1.71s
  - frames 60-60, 2.50s-2.50s
  - frames 69-70, 2.88s-2.92s
  - frames 95-100, 3.96s-4.17s
  - frames 104-104, 4.33s-4.33s
- Implementation lesson: use short 120-600 ms transitions, then settle. Do not animate constantly.

### 演示9.webm

- Duration: 15.33s, 368 frames at 24 FPS.
- High-motion bursts, first 8:
  - frames 5-5, 0.21s-0.21s
  - frames 9-10, 0.38s-0.42s
  - frames 33-40, 1.38s-1.67s
  - frames 50-52, 2.08s-2.17s
  - frames 63-66, 2.62s-2.75s
  - frames 92-94, 3.83s-3.92s
  - frames 100-100, 4.17s-4.17s
  - frames 107-109, 4.46s-4.54s
- Implementation lesson: use short 120-600 ms transitions, then settle. Do not animate constantly.

## 4. Detailed implementation language

### 4.1 Pointer state machine

```text
IDLE
  no visible UI except optional tray/background state

WAKE / LISTENING
  180 ms fade-in; pointer halo appears near cursor or selected bbox
  halo breathing period: about 900-1200 ms
  alpha range: 0.18 -> 0.42 -> 0.18

HOVER_TARGET
  current object outline glows
  update THIS continuously

SELECTING
  translucent rounded rectangle, cyan/blue edge
  avoid a full black modal overlay when possible

ACTION_READY
  2-4 chips appear from object edge
  chip fade/slide duration: 140-220 ms

THINKING
  small shimmer/spinner attached to chip or object edge
  do not open a central waiting window

EXECUTING
  if action has source and destination, draw a short Bezier path
  moving dot/trail duration: 350-650 ms

DONE
  small local result/action card
  auto-collapse or provide Details
```

### 4.2 Visual parameters to implement first

- Full-screen transparent overlay window.
- Selection glow: 2-4 px cyan stroke, 8-14 px rounded radius, soft outer stroke.
- Listening halo: ellipse around selected bbox center or cursor, animated alpha.
- Chips: compact rounded pills, max 4 primary actions, anchored to nearest safe edge of the selected bbox.
- Text input: not a chat box. Keep only a one-line speech capture pill because Windows dictation needs a focused text field.
- Result card: small, local, action-oriented. Larger answer goes behind a Details button.
- Path animation: quadratic Bezier from THIS bbox center to DESTINATION/THAT bbox center when available.

### 4.3 Timing constants

```text
overlay_fade_in_ms      = 160
chip_enter_ms           = 180
halo_breath_period_ms   = 1000
thinking_tick_ms        = 33
path_trail_ms           = 500
result_card_fade_ms     = 180
idle_task_rollover_min  = 30
```

## 5. Product decisions from frame analysis

1. The main UI must be an overlay, not the control panel.
2. Voice/listening is the default wake state; typed input is only fallback.
3. UI must stay local to the object. No central chat window.
4. History thumbnails should not be visible by default.
5. Groups should be inferred from current task continuity, not manual group management.
6. The first implementable version should make the selection glow, show local chips, and open dictation automatically.

## 6. Immediate implementation target

Replace the current prompt window path with a transparent overlay command surface:

```text
after selection
  -> save screenshot/object
  -> show transparent overlay
  -> draw glow around selected bbox
  -> show listening pill + chips
  -> auto-trigger Windows dictation
  -> Enter/chip runs current AI call
  -> answer shown as small local result card
```


## 7. Implementation started in this branch/worktree

Implemented first overlay-oriented step in `app/main.py`:

- The post-selection surface is now a full-screen transparent overlay instead of a normal fixed-size prompt window.
- The selected object gets local glow strokes and a breathing halo.
- The command surface is a compact local pill near the object, not a central chat panel.
- Windows dictation is triggered automatically after the overlay appears; the one-line entry exists only as a speech capture/fallback field.
- Existing chips/actions remain available: explain, compare, put there, set destination, clear destination, execute, details, continue selection, close.
- If a destination object exists, the overlay draws a source-to-destination Bezier path with a moving dot.
- Control-panel corrupted status text was fixed, and panel-signal state initialization was repaired.

Validation run:

```text
python -m py_compile app/main.py app/object_store.py app/task_context.py app/system_context.py app/screen_context.py app/ai_client.py
python tests/smoke_test.py
python tests/gesture_test.py
python tests/object_store_test.py
python tests/task_context_test.py
```

All tests passed.


## 8. Correction after comparing with demo6/demo7

The previous implementation was visually wrong in three ways:

1. It still used screenshot-rectangle selection as the main visual language.
2. It drew a fake blue target circle in the middle of the selected bbox. The Google/Gemini demos do not show that.
3. It made the whole bbox flash, while the reference mainly lights up the pointer outline, pointer trail, and the swept/hovered line or semantic object.

Measured from `??6.png` / `??7.webm` at 2950x1908 source resolution:

- The selected text-line blue attention component is about `771 x 104 px`.
- That means the glow height is around `100 px` at source scale, roughly 1.7-2.2 times a visible ingredient text line including soft blur.
- The main blue body is much narrower than the full glow: approximately 14-18 px hard core plus a broad translucent 30-35 px painted stroke in our Tk approximation.
- The highlight is not a rectangular box. It behaves like a sweep/brush trail over one line, ending near the cursor arrow.
- For table/document cases, the object/table may glow after selection, but the active interaction is still pointer trail + chip, not a screenshot frame.

Implementation update:

- Selection input changed from rectangle drag to freehand sweep/circle stroke.
- The app still computes a screenshot bbox internally from the stroke's outer bounds, but the user-facing visual is the stroke.
- The post-selection overlay now replays the stroke with broad soft blue, medium blue body, and white core.
- Removed the fake center blue circle.
- Removed the default big rectangle blink as the main visual.

Remaining gap:

- Tk can approximate the trail, but it cannot do true gaussian blur, cursor replacement, or native compositor-level glow. For a closer 1:1 version, the overlay renderer should later move to a real GPU/compositor layer, e.g. PySide6/QML, Direct2D, WebView2 canvas, or a lightweight native Windows overlay.
