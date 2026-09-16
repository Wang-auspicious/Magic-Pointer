# Clicky "双生鼠标" (twin cursor) — recon, with citations

Date: 2026-09-16
Recon worker: B
Sources read (line-by-line):

| Repo | Language | Source? | Role |
|---|---|---|---|
| `external/clicky` | Swift / AppKit + SwiftUI | yes (85 files) | Original macOS Clicky. `leanring-buddy/OverlayWindow.swift` is the reference twin cursor. |
| `external/clicky-windows` | Python / PyQt6 | yes (~46 non-venv .py) | Windows port. `ui/overlay.py` is a **full Windows twin-cursor implementation**. This is the most portable artifact in the whole set. |
| `external/openclicky` | Swift / AppKit + SwiftUI | yes (142 .swift) | macOS fork, far more evolved: multi-cursor proxy API, computer-use, avatar styles, window-level discipline. |
| `external/nut.js` | TypeScript over a native addon | TS only | libnut is a prebuilt N-API binary; **no C++ source in this checkout** (`providers/libnut/libnut.d.ts` is the whole surface). |

---

## Cursor architecture

### The headline finding: nobody hides the OS cursor

I grepped all three repos for `NSCursor.hide()`, `NSCursor.unhide()`, `CGDisplayHideCursor`, `ShowCursor`, `SetCursorPos` outside of computer-use. **There is no cursor-hiding anywhere.** The system cursor keeps rendering natively in every Clicky variant. The "twin" is a *companion* drawn at a fixed offset from the real pointer, so the two never fight — they are never in the same place.

- `external/clicky/leanring-buddy/OverlayWindow.swift:307` — the buddy triangle is `frame(width: 16, height: 16)`, positioned at `cursorPosition`, which is set to `mouseLocation + (35, 25)` (`:348`, `:439-440`). The real cursor is untouched and visible at the origin of that offset.
- `external/clicky/leanring-buddy/OverlayWindow.swift:412` — the follow loop **reads** `NSEvent.mouseLocation` every 0.016 s. It never writes a cursor position anywhere in the file.
- `external/clicky-windows/ui/overlay.py:407` — same: `qp = QCursor.pos()` is read-only. Grep across every non-venv `.py` in `clicky-windows` finds `ctypes.windll.user32` in exactly two places, and neither is cursor-related: `tutor.py:18` (`GetForegroundWindow`/`GetWindowTextW` for the window title) and `screen/capture.py:57` (`SetProcessDPIAware`/`GetDpiForSystem` for DPI scale). **`SetCursorPos` is never called.**
- `external/openclicky/cursor-buddy/CompanionManager.swift:2508-2511` states the rule explicitly:

  > `// Do not warp the system pointer here and do not draw a duplicate primary cursor icon.`

  That is inside `showExternalPrimaryCursor(...)`, the handler for the external `/cursor` bridge call. Even when an *external* agent asks Clicky to point somewhere, it moves the **buddy**, not the pointer.

Consequence for Magic Pointer: the user's ask ("an on-screen agent cursor appears alongside/behind the real OS cursor") is exactly Clicky's model, and it is *easier* than the alternative — there is no `ShowCursor` reference-count to get wrong and therefore no "cursor left hidden" leak class.

### Where the second cursor is drawn

**macOS (both `clicky` and `openclicky`): a native borderless `NSWindow` hosting a SwiftUI tree.**

`external/clicky/leanring-buddy/OverlayWindow.swift:14-53`:
```swift
super.init(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
self.isOpaque = false                       // :25
self.backgroundColor = .clear               // :26
self.level = .screenSaver                   // :27  "above submenus and popups"
self.ignoresMouseEvents = true              // :28  click-through
self.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]  // :29
self.hasShadow = false                      // :31
self.hidesOnDeactivate = false              // :34
override var canBecomeKey: Bool { return false }   // :46-48
override var canBecomeMain: Bool { return false }  // :50-52
```
One window **per screen** (`OverlayWindowManager.showOverlay(onScreens:)`, `:783-808`), each driven by `window.orderFrontRegardless()` (`:806`). The view hides itself on screens the pointer is not on (`buddyIsVisibleOnThisScreen`, `:395-407`).

`external/openclicky/cursor-buddy/OverlayWindow.swift` is the same design with a window-level *system* instead of a bare `.screenSaver`:
- `OverlayWindow.swift:151` calls `OpenClickyWindowLevels.applyCursorOverlayLevel(to: self)`.
- `OpenClickyWindowInfrastructure.swift:21` — `private static let interactiveCeiling = CGWindowLevelForKey(.draggingWindow)`.
- `:26` `statusSurface = NSWindow.Level(rawValue: Int(interactiveCeiling) - 1)`
- `:31` `cursorOverlay = statusSurface` — i.e. **just below the drag layer**, so the overlay never covers a file-drag image.
- `:35` `mainPanel = ceiling - 3`; `:39` `panelDialog = ceiling - 2`. The cursor overlay sits *above* the app's own panel.

**Windows (`clicky-windows`): a single transparent, click-through, always-on-top PyQt6 `QWidget`.**

`external/clicky-windows/ui/overlay.py:223-231`:
```python
self.setWindowFlags(
    Qt.WindowType.FramelessWindowHint
    | Qt.WindowType.WindowStaysOnTopHint
    | Qt.WindowType.Tool
    | Qt.WindowType.WindowTransparentForInput
)
self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
```
`_cover_all_monitors()` (`:385-393`) unions `QApplication.screens()` geometries into one widget spanning the virtual desktop. **It deliberately leaves a 2 px gap at the bottom** (`:392`, `geo.setBottom(geo.bottom() - 2)`) with the comment that a topmost full-screen window otherwise suppresses the Windows auto-hide taskbar hover trigger. That is a real Windows-only trap and Magic Pointer will hit it too.

Magic Pointer today uses an **Electron `BrowserWindow` + canvas/SVG** (`electron/main.ts:850`), which is architecturally the same class as the Qt widget — a separate always-on-top transparent surface — so the port is a rendering change, not a platform change.

### The draw loop

All three use a **fixed-interval timer, not rAF, not a physics engine**.

| Repo | Loop | Citation |
|---|---|---|
| clicky (macOS) | `Timer.scheduledTimer(withTimeInterval: 0.016, repeats: true)` → 62.5 Hz | `OverlayWindow.swift:412` |
| clicky-windows | `QTimer` → `self._tick_timer.start(16)` → 60 Hz, `_tick()` repaints via `self.update()` | `ui/overlay.py:239-241`, `:406` |
| openclicky (macOS) | `DispatchSource.makeTimerSource(queue:)`, `.schedule(deadline: .now(), repeating: .milliseconds(16), leeway: .milliseconds(3))`, queue `qos: .userInteractive` | `OverlayWindow.swift:1235-1237` |

openclicky adds two refinements worth copying:
- **Sample-dedup**: `guard mouseLocation != lastSampledPoint else { return }` (`:1243`) — no work when the pointer has not moved.
- **Coalesce delivery to main**: `guard !updateQueuedOnMain else { return }` (`:1246`) with the flag cleared only after the main-thread hop completes (`:1249-1254`). The comment at `:1228-1232` says this exists because a busy SwiftUI/TTS moment otherwise builds a backlog of stale 60 Hz updates that "replay as visible jank." Magic Pointer's `sendCursorToOverlay` has no such guard.

### The follow interpolation (idle mode)

Three different answers, and this is the single most important number to pick:

| Repo | Follow easing | Citation | Character |
|---|---|---|---|
| clicky | SwiftUI implicit `.spring(response: 0.2, dampingFraction: 0.6, blendDuration: 0)` re-triggered every 16 ms | `OverlayWindow.swift:313-318` | Noticeably laggy/detached — the buddy trails the pointer by a visible amount. This is a *feature*: it reads as "a creature following you." |
| clicky-windows | Hand-rolled semi-implicit Euler spring, `stiffness = 0.28, damping = 0.62`, evaluated at 60 Hz | `ui/overlay.py:492-502` | Same feel, explicit and portable. |
| openclicky | **No spring.** `.linear(duration: 1.0 / 120.0)` — a 2-frame linear blend per sample, essentially hard-locked to the pointer | `OverlayWindow.swift:620-621` | Tight tracking. The comment at `:615-618` says samples already arrive at display cadence and restarting a spring every frame "fights the real cursor." |

clicky-windows' spring integrator, verbatim mechanics (`ui/overlay.py:491-502`):
```
target = (real.x + 35, real.y + 25)
ax = (target.x - display.x) * 0.28
ay = (target.y - display.y) * 0.28
vel = (vel.x * 0.62 + ax, vel.y * 0.62 + ay)
display += vel
```
Note it is applied **per 16 ms tick with no dt term** — the constants are tuned for exactly 60 Hz. Changing the tick rate changes the feel.

### The scripted flight (agent moves the buddy to a target)

This is where the "moves smoothly instead of teleporting" lives. All three converge on the same algorithm; only the timing constants differ.

Shared shape (clicky-windows `ui/overlay.py:359-377` and `:411-450`; clicky `OverlayWindow.swift:495-568`; openclicky `OverlayWindow.swift:1415-1497`):

1. **Quadratic Bézier** from `start` to `end` with one control point at the midpoint, raised **upward** by `arcHeight` → a parabolic arc, not a straight line.
2. **Easing applied to `t` before evaluating the Bézier**: smoothstep `t = lp²(3 − 2·lp)` where `lp` is linear progress. (clicky `:540`, clicky-windows `:415`, openclicky `:1467`.) easeInOut — gentle start, gentle landing.
3. **Rotation follows the curve tangent**: `rotation = atan2(B'(t).y, B'(t).x) + 90°` so the triangle leans into its direction of travel. clicky and clicky-windows use `+90` (`:561`, `:429`) because their triangle's tip is up at 0°; openclicky uses `+28` for its paperclip avatar (`:1488`).
4. **Scale pulse** `1.0 + sin(lp·π) × k` — peaks exactly at the arc apex. clicky and openclicky use `k = 0.3` (→ 1.3×, `:565-566`, `:1492-1493`); clicky-windows uses `k = 0.25` (`:431`).
5. **Bubble eases in during flight**, in clicky-windows: `alpha = min(1, lp × 1.4)`, `scale = 0.5 + lp × 0.5` (`:434-435`).

Flight duration:

| Repo | Formula | Citation |
|---|---|---|
| clicky | `min(max(distance / 800.0, 0.6), 1.4)` s | `OverlayWindow.swift:510` |
| openclicky (normal) | `min(max(distance / 1800.0, 0.32), 0.58)` s when `detectedElementReturnsImmediately` (agent handoff), else same as clicky | `OverlayWindow.swift:1432-1437` |
| clicky-windows | `max(1.6, min(2.8, 1.6 + dist / 700.0))` s; ×1.7 in slow mode; return leg is a flat `1.4` s | `ui/overlay.py:161-164`, `:364`, `:367` |

clicky-windows is deliberately **~2–3× slower** than upstream Clicky. The header comment at `ui/overlay.py:159-160` calls this "teacher pace" — the port's author judged upstream's 0.6–1.4 s as too fast to follow. Magic Pointer should decide which of the two audiences it is serving; my recommendation is listed in the port table below.

Arc height: clicky `min(distance * 0.2, 80.0)` (`:521`); clicky-windows `min(dist * 0.22, 90.0)` (`:370`); openclicky `min(distance * 0.2, 80.0)` (`:1448`).

### The landing target

The buddy does **not** land on the element; it lands beside it so the element stays visible:
- clicky `OverlayWindow.swift:465-468` — target offset `(+8, +12)`, then clamped to a 20 px screen inset (`:471-474`).
- clicky-windows `ui/overlay.py:266-267` — lands the triangle *centered* on the exact pixel and marks the pixel with the ring instead. Comment: "The buddy lands with the tip of its triangle on that pixel — the highlight ring marks the exact spot."
- openclicky `OverlayWindow.swift:1385-1394` — same `(+8, +12)` and 20 px clamp as clicky.

### The ring (what marks the actual target)

clicky-windows is the only one with an explicit ring, and it is the cleanest spec:
- created as `self._ring = (x, y, 26.0)` — center + base radius 26 (`ui/overlay.py:272`)
- per tick: `self._ring_phase += 0.08` (`:506`)
- paint: `pulse = (sin(ring_phase) + 1) / 2` (0..1), `r = base_r + pulse * 6` (`:694-695`)
- outer halo: `CURSOR_BLUE` alpha 60, pen width 4, radius `r + 3` (`:697-702`)
- crisp inner ring: `CURSOR_BLUE` alpha 190, pen width 2, radius `r` (`:704-708`)

### What openclicky adds that is directly relevant

**Secondary proxy cursors** — literally multiple simultaneous twin cursors, each with its own accent color and caption. `CompanionManager.swift:37-42`:
```swift
struct OpenClickyExternalProxyCursor: Identifiable {
    let id: UUID
    var screenLocation: CGPoint
    var caption: String?
    var accentHex: String?
}
```
Rendered at `OverlayWindow.swift:1113-1132` — same `(+35, +25)` offset (`:1116`), avatar `23 × 30` (`:1120`), shadow radius 10 (`:1122`), entrance `.transition(.opacity.combined(with: .scale(scale: 0.92)))` (`:1124`), and follow easing `.spring(response: 0.16, dampingFraction: 0.72)` (`:1131`).

They are driven over a local HTTP bridge: `OpenClickyExternalControlBridge.swift:253` (`POST /cursor`), `:255` (`POST /cursors`), exposed to models as `show_cursor` (`:622`) and `show_cursors` (`:639`). Each has a TTL, floored at 0.2 s (`CompanionManager.swift:2531-2534`), and when the caller omits a duration the bridge supplies one rather than leaving it infinite (`:545-551`).

This is the single most valuable pattern in openclicky for Magic Pointer: **the twin cursor is an addressable surface with its own API, not a side effect of an action.** It lets an agent say "put a marker here" without touching the pointer.

---

## Motion spec

### Phase table — follow + flight (the core loop)

| Phase | Duration | Easing | What moves | Source |
|---|---|---|---|---|
| Idle follow — sample | 16 ms tick (62.5 Hz) | — | read `NSEvent.mouseLocation` / `QCursor.pos()` | clicky `:412`; win `:241`; openclicky `:1237` |
| Idle follow — spring | continuous | spring `response 0.2`, `damping 0.6`, retriggered each tick | buddy position → `cursor + (35, 25)` | clicky `:313-318` |
| Idle follow — spring (explicit, portable) | per 60 Hz tick | `stiffness 0.28`, `damping 0.62`, semi-implicit Euler | same | win `:492-502` |
| Idle follow — tight | per sample | `.linear(1/120)` | same | openclicky `:620-621` |
| Approach pre-roll | **none found** | — | — | see Latency feel below |
| Flight (short hop) | `clamp(distance/800, 600, 1400)` ms | smoothstep `t²(3−2t)` on Bézier `t` | buddy along parabolic arc | clicky `:510`, `:540` |
| Flight (handoff, "get out of the way") | `clamp(distance/1800, 320, 580)` ms | same | same | openclicky `:1434` |
| Flight (teacher pace, win port) | `max(1600, min(2800, 1600 + dist/700))` ms | same | same | win `:364` |
| Flight — arc height | — | — | control point raised `min(dist × 0.2, 80)` px (win: `× 0.22`, cap 90) | clicky `:521`; win `:370` |
| Flight — rotate to tangent | per frame | — | rotation = `atan2(B'(t)) + 90°` | clicky `:561`; win `:429` |
| Flight — scale pulse | peaks at mid-flight | `sin(lp·π)` | scale 1.0 → **1.3×** → 1.0 (win: 1.25×) | clicky `:565-566`; win `:431` |
| Flight — bubble in | over the flight | linear-then-clamp | bubble alpha `min(1, lp×1.4)`, scale `0.5 + lp×0.5` | win `:434-435` |
| Dwell @ target | **3000 ms** (win: **4000 ms**, ×1.7 slow mode, or ∞ while TTS speaks) | — | buddy planted on target | clicky `:592`; win `:163`, `:285-287`, `:439-443` |
| Dwell breathing | continuous | `1 + 0.05·sin(phase × 1.4)` | scale only | win `:454` |
| Dwell bubble settle | per tick | lerp `× 0.15` toward 1.0 | bubble scale | win `:457` |
| Bubble fade-out before return | **500 ms** | `easeOut(0.5)` | bubble opacity → 0 | clicky `:291`, `:594-595` |
| Return flight | flat **1400 ms** (win); `clamp(dist/800, 600, 1400)` ms (macOS) | smoothstep | buddy back to `cursor + (35, 25)` | win `:164`, `:462`; clicky `:635-648` |
| Ring pulse | continuous | `sin(phase)` → 0..1 | radius `26 + pulse×6` px, glow α60 / core α190 | win `:272`, `:506`, `:694-708` |

### Phase table — state cross-fades and feedback

| Phase | Duration | Easing | What | Source |
|---|---|---|---|---|
| Overlay appear | 2000 ms | `easeIn(2.0)` | buddy opacity 0 → 1 | clicky `:355-357` |
| Voice-state cross-fade | 250 ms | `easeIn(0.25)` | triangle ↔ waveform ↔ spinner | clicky `:319` |
| Waveform redraw | **1/36 s** min interval | `TimelineView(.animation)` | 5 bars, profile `[0.4, 0.7, 1.0, 0.7, 0.4]`, bar w 2, spacing 2 | clicky `:713-716`; win `:750-776` |
| Audio level smoothing | per tick | `level = level×0.55 + eased×0.45`; `eased = min(rms×2.85, 1)^0.76` | bar heights | win `:253-257` |
| Spinner | **800 ms / rev**, linear, repeat forever | linear | 70% arc, 2.5 px stroke, round cap | clicky `:769`; win `:797-799` |
| Pointing bubble pop-in | spring `response 0.4`, `damping 0.6` | spring | scale 0.5 → 1.0, glow radius `6 + (1−scale)×16` | clicky `:274-277`, `:290` |
| Bubble text stream | **30–60 ms per char**, random | — | `Double.random(in: 0.03...0.06)` | clicky `:624` |
| Overlay hide | **400 ms** | `easeIn` | whole overlay `alphaValue → 0`, then `orderOut` | clicky `:819-825`; openclicky `:3207-3223` |
| **Click feedback** (openclicky `activeControlGlow`) | **2400 ms** default, clamped `[400, 12000]` ms | `easeInOut(0.75).repeatForever(autoreverses: true)` | 5 stacked rounded strokes around the control rect | openclicky `:2921`, `:2939`, `:1686-1689` |
| Click feedback — geometry | — | — | corner radius `clamp(min(w,h)×0.05, 10, 30)`; 5 layers inset 5 px each; lineWidth `5 − index`; opacities `[0.55, 0.32, 0.20, 0.13, 0.08]`; core border 1.4 px @ α0.78 | openclicky `:1665-1678`, `:1693-1696` |
| Click feedback — pulse | — | — | `blur 0.9 ↔ 0.45`, `opacity 0.68 ↔ 0.92` | openclicky `:1680-1681` |

### Colors and geometry

| Token | Value | Citation |
|---|---|---|
| Clicky blue | `#3380FF` | win `ui/overlay.py:43` |
| Magic Pointer guide triangle blue | `#2477e8` (3 stacked paths, opacity 0.10 / 0.16 / 1.0) | `electron/renderer/index.html:14-16` |
| Triangle shape | equilateral; `height = size × √3/2`; vertices `(0, −h/1.5)`, `(−s/2, h/3)`, `(s/2, h/3)` | clicky `:56-71`; win `:719-746` |
| Triangle size | **16 × 16** | clicky `:307`; win `:38` |
| Triangle rest rotation | **−35°** | clicky `:140`; win `:40`; MP `index.html:14` (`rotate(-35 24 24)`) |
| Glow / shadow | `radius: 8 + (flightScale − 1) × 20`, color = accent | clicky `:309`; openclicky `:832` |
| Glow (Qt approximation) | 3 ellipses, radius `size × {2.2, 1.6, 1.15} × 0.5`, alpha {35, 55, 85} | win `:736-740` |
| Button-hold feedback | none drawn — the OS button state is never mirrored on the twin | — |

### Latency feel — deliberate pre-roll

**There is no pre-roll delay before starting the movement.** Every repo begins the flight on the same tick the target arrives (`clicky :485-488` → `animateBezierFlightArc`; win `:275` → `_begin_flight`). The perceived intentionality comes entirely from three things, all of which *are* specified:

1. **The arc.** `min(dist × 0.2, 80)` px of upward bow means the buddy takes a path a straight line would not (`clicky :521`).
2. **The smoothstep.** `t = lp²(3 − 2lp)` makes the first ~15% of the flight cover almost no distance, which reads as a wind-up (`clicky :540`).
3. **The duration floor.** clicky floors at **600 ms** regardless of distance (`:510`) — a 5 px hop still takes 600 ms. clicky-windows floors at **1600 ms** (`:364`). This floor is the actual "pre-roll" mechanism: it guarantees no movement is ever instantaneous.

There *is* an explicit dwell-after and an explicit refusal to interrupt: clicky `:416-419` — during forward flight the buddy ignores pointer movement entirely, and only a **> 100 px** pointer move during the *return* leg cancels it (`:426`).

### Restore / leak discipline

Because nothing is hidden, there is nothing to restore, and there is no leak class. But two real defects exist in the sources and Magic Pointer should not copy them:

- `external/clicky-windows/ui/overlay.py:379-381` — `hide_cursor()` does **not** hide anything. It calls `_release_lock()` and `set_mode(MODE_IDLE)`; the widget keeps rendering and the buddy keeps following. Worse, grepping every non-venv `.py` in the repo shows **`hide_cursor` has zero callers** — it is dead code whose name invites a future maintainer to believe a real hide/restore pair exists.
- `external/clicky/leanring-buddy/OverlayWindow.swift:366-370` — `onDisappear` invalidates `timer` and `navigationAnimationTimer`, and openclicky does the same plus `cursorTrackingTimer?.cancel()` (`OverlayWindow.swift:904-907`). The **frame-by-frame flight timer is created with `Timer(timeInterval:repeats:)` and added to `RunLoop.main`** (openclicky `:1451`, `:1496`; clicky uses `Timer.scheduledTimer` at `:524`). If any early-return path in the flight callback skipped `invalidate()` the timer would fire forever — clicky guards this at `:486` (`guard self.buddyNavigationMode == .navigatingToTarget else { return }` inside the completion, not the tick) and openclicky at `:1454-1461`. It holds today, but it is fragile: the safe pattern is what openclicky's `cancelNavigationAndResumeFollowing()` does at `:1592-1601` — invalidate **and** nil the timer in one place.

---

## Focus & hit-testing flags

### macOS — exact calls

| Goal | Call | Citation |
|---|---|---|
| Borderless, no titlebar | `styleMask: .borderless` | clicky `:20`; openclicky `:142` |
| Transparent | `isOpaque = false`; `backgroundColor = .clear`; `hasShadow = false` | clicky `:25-26, :31` |
| Click-through | `ignoresMouseEvents = true` | clicky `:28`; openclicky `:152` |
| **Above everything, including menu popups** | `level = .screenSaver` | clicky `:27` |
| **Below the drag layer** (recommended over `.screenSaver`) | `level = CGWindowLevelForKey(.draggingWindow) − 1` | openclicky `OpenClickyWindowInfrastructure.swift:21, :26, :31` |
| **Never steals focus** | `override var canBecomeKey: Bool { return false }` and `override var canBecomeMain: Bool { return false }` | clicky `:46-52`; openclicky `:170-176` |
| Survives app deactivation | `hidesOnDeactivate = false` | clicky `:34`; openclicky `:158` |
| Follows across Spaces / full-screen apps | `collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]` | clicky `:29`; openclicky `:153` |
| Show without activating | `window.orderFrontRegardless()` — **not** `makeKeyAndOrderFront` | clicky `:806`; openclicky `:3162` |
| Teardown without ARC release | `isReleasedWhenClosed = false` | clicky `:30`; openclicky `:154` |

openclicky explicitly re-asserts click-through on every show (`OverlayWindow.swift:3184-3204`), with the comment that a content-view `hitTest` returning nil does **not** forward clicks to the app behind — the window itself must ignore events. That comment is at `OverlayWindow.swift:146-148`.

### Windows / Qt (clicky-windows) — exact flags

| Goal | Flag | Citation |
|---|---|---|
| No chrome | `Qt.WindowType.FramelessWindowHint` | `ui/overlay.py:224` |
| Always on top | `Qt.WindowType.WindowStaysOnTopHint` | `:225` |
| Not in taskbar / not an app window | `Qt.WindowType.Tool` | `:226` |
| **Input falls through to the app below** | `Qt.WindowType.WindowTransparentForInput` | `:227` |
| Transparent background | `WA_TranslucentBackground` | `:229` |
| **Belt-and-braces click-through** | `WA_TransparentForMouseEvents` | `:230` |
| **Show without activating / no focus steal** | `WA_ShowWithoutActivating` | `:231` |
| Don't suppress auto-hide taskbar | shrink geometry `geo.setBottom(geo.bottom() - 2)` | `:390-392` |

The equivalent in Electron (which is what Magic Pointer uses) is already present at `electron/main.ts:855-891`:
`frame:false`, `transparent:true`, `backgroundColor:'#00000000'`, `skipTaskbar:true`, `alwaysOnTop:true`, `hasShadow:false`, **`focusable:false`** (the `canBecomeKey` equivalent, `:870`), `setAlwaysOnTop(true, 'screen-saver')` (`:879`), `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true})` (`:880`), `setIgnoreMouseEvents(true, {forward:true})` (`:891`), and `showInactive()` when showing (`:3402`). Note `createStageWindow()` (`:932`) sets everything except `focusable:false` — it has `setIgnoreMouseEvents(false)` toggling at `:2352-2354` and `:4828-4830` because the stage must own pointer input during gestures.

---

## Port list

Each item is phrased as a concrete change. Where I could not identify the Magic Pointer symbol I say so.

1. **`electron/main.ts` → `createOverlayWindow()` (line 850)** — add a **third window**, `cursorWindow`, modelled on the overlay window but with `focusable:false`, `setIgnoreMouseEvents(true, {forward:true})` and `setAlwaysOnTop(true, 'screen-saver')`, dedicated to the twin cursor. Do **not** reuse `overlayWindow`: that surface already changes its `setIgnoreMouseEvents` state for capture gestures (`main.ts:2352-2354`, `:4828-4830`) and is destroyed/recreated per gesture by `ensureFreshGestureOverlay()` (`:902-911`). A cursor that dies mid-gesture is worse than no cursor. Clicky keeps the cursor window and the interaction window distinct for the same reason: `OverlayWindow.swift:3184-3189` says the overlay must never swallow clicks in the app behind it.

2. **`electron/main.ts` → `createOverlayWindow()` (line 851)** — replace `screen.getPrimaryDisplay()` with `screen.getAllDisplays()` and create one cursor window per display, each positioned at `display.bounds`. Clicky creates one overlay per screen and moves the buddy between them: `OverlayWindowManager.showOverlay(onScreens:screens)` at `OverlayWindow.swift:783-808`, iterating `for screen in screens` at `:792`. Magic Pointer's single-primary-display cursor window means the twin cursor vanishes on a second monitor — exactly the failure `buddyIsVisibleOnThisScreen` exists to solve (`OverlayWindow.swift:395-407`).

3. **`electron/main.ts` → `startMouseShakePolling()` (line 3879)** — the `setInterval` here is the only cursor sample source and it is gated on `overlayWindow.isVisible()` (`:3890`). Give the cursor window its **own** timer that runs whenever the cursor window is visible, independent of overlay visibility, and add openclicky's sample-dedup (`guard mouseLocation != lastSampledPoint else { return }`, `OverlayWindow.swift:1243`) plus the coalesce flag (`:1246`). openclicky's comment at `:1228-1232` names the exact symptom Magic Pointer will otherwise get: stale 60 Hz updates replaying as visible jank after a busy moment.

4. **`electron/main.ts` → `sendCursorToOverlay()` (line 3422)** — this already sends `{x, y, globalX, globalY}` in local DIP + global screen space. Extend the payload with the **display id** and a monotonically increasing **sample timestamp**, because the twin cursor needs to interpolate between samples with a real `dt`. Its current `setBounds` guard (`:3430-3437`) exists precisely because "反复 setBounds 会让 Windows 每次重设光标区域——光标在 CSS 光标和原生光标之间闪的根源" (`:3427-3429`); the same flicker will hit any per-frame window move, so the cursor window must be **created full-display and never moved**, with the cursor drawn inside it via `transform`. That is Clicky's model: one full-screen window per display, the buddy moved inside the view (`OverlayWindow.swift:340` `.frame(width: screenFrame.width, height: screenFrame.height)`).

5. **`electron/renderer/overlay.ts` → the comment at line 302 (`不画 canvas 鼠标——光标由操作系统原生 cursor 资源渲染.`)** — this is the decision that must be reversed, *but only for the agent cursor*. Keep the rule for the human cursor (the OS draws it natively and correctly, with shadow and DPI-correct scaling). Add a **separate** agent-cursor element that is drawn at `realCursor + (35, 25)` in DIP. Clicky draws the buddy at exactly that offset while leaving the system cursor completely alone: `OverlayWindow.swift:348` and `:439-440`. There is no `ShowCursor`/`SetCursorPos` anywhere in any of the three repos, so there is no hide/restore contract to honour.

6. **`electron/renderer/overlay.ts` → `GUIDE_FLIGHT_MS` (line 50, currently `620`)** — keep `620` only if Magic Pointer is a *guide*; Clicky's pointing flight is `clamp(distance/800, 600, 1400)` ms (`OverlayWindow.swift:510`) and its Windows port raised the floor to `max(1600, min(2800, 1600 + dist/700))` ms specifically because 0.6–1.4 s was too fast to follow (`ui/overlay.py:159-164`). Recommend a two-tier constant: `GUIDE_FLIGHT_MS = 620` for the existing answer-guidance path, and a new `AGENT_FLIGHT_MS = clamp(distance/800, 600, 1400)` for the takeover cursor, so the "teacher pace" change is opt-in per call site rather than a global regression of the guide.

7. **`electron/renderer/overlay.ts` → `onGuidePoint()` (line 67) and `updateGuideTriangle()` (line 145)** — the bezier is already correct (`guideFlightPoint` at `:137-143`), but the easing is **easeOutCubic** (`eased = 1 - Math.pow(1 - t, 3)`, `:157`) whereas every Clicky variant uses **smoothstep** (`t*t*(3-2*t)` — clicky `:540`, win `:415`, openclicky `:1467`). easeOutCubic front-loads the movement and removes the wind-up that makes the motion read as intentional. Change to `eased = t * t * (3 - 2 * t)`.

8. **`electron/renderer/overlay.ts` → `onGuidePoint()` control point (lines 78-81)** — currently `y - Math.max(90, |Δx| × 0.35)`, which is an *absolute* 90 px floor. Clicky uses `min(distance × 0.2, 80)` — a *fraction* with a cap (`OverlayWindow.swift:521`), so a long flight bows proportionally and a short one barely bows. Mirror the Clicky formula, and add the tangent-following rotation from `:555-561` (currently the triangle keeps a static `-35°` transform from `index.html:14`).

9. **`electron/renderer/overlay.ts` → `updateGuideTriangle()` hold duration (line 173, currently `2500`)** — Clicky holds for **3000 ms** (`OverlayWindow.swift:592`) and its Windows port for **4000 ms**, extensible without limit while TTS is speaking (`ui/overlay.py:163`, `:281-287`, `:439-443`). Add a `setPointHold(true/false)` equivalent that pins the dwell at `Infinity` while the agent is talking, and releases it on TTS end (`ui/overlay.py:289-297`). Without this the cursor leaves the target mid-sentence.

10. **`electron/renderer/overlay.ts` → cursor follow (new)** — implement the follow spring as an explicit 60 Hz integrator, not a CSS transition, using clicky-windows' constants verbatim: `stiffness = 0.28`, `damping = 0.62`, `vel = vel × damping + (target − pos) × stiffness`, `pos += vel` (`ui/overlay.py:492-502`). A CSS `transition` cannot be told to re-target every 16 ms without restarting, and openclicky documents that restarting the animation each sample "fights the real cursor" (`OverlayWindow.swift:615-621`). Choose the spring (trailing, creature-like) rather than openclicky's `.linear(1/120)` (locked) only if the product wants the buddy to read as *alive*; Magic Pointer's existing guide is a one-shot, so the trailing spring is the new information and I recommend it.

11. **`app/computer_operator/windows.py` → `Win32InputDriver.move()` (line 185)** — this method **throws away its own duration**: `del duration_ms` then `self._position(point)` (`:185-187`). So every `HOVER` action teleports the OS cursor (`:380`). Replace the body with a stepped glide reusing the loop already written for `drag()` at `:199-208` (`steps = max(1, min(60, duration_ms // 16))`, linear interpolation, `time.sleep(delay)`). Clicky never begins a movement shorter than 600 ms (`OverlayWindow.swift:510`); a teleport is the exact behaviour the twin cursor exists to eliminate. Note: `drag()` **does** glide, so the capability is already in the file — only `move()` was short-circuited.

12. **`app/computer_operator/windows.py` → `Win32InputDriver.click()` (line 178)** — `self._position(point)` fires at `:179` with zero pre-roll, then `down`/`up` back-to-back with no delay (`:181-183`). Add the **35 ms press-hold** that openclicky uses between down and up — `usleep(35_000)` between `.leftMouseDown` and `.leftMouseUp` at `OpenClickyComputerUseRuntime.swift:1104-1107` — and emit a *start-of-motion* event to the Electron cursor window ~600 ms before `_position`, so the twin cursor is already on the target when the click lands. Without that, the click is invisible on the twin: the user sees a flash with no cursor under it.

13. **`app/computer_operator/windows.py` → `Win32InputDriver.scroll()` (line 212)** — `_position(point)` then a single raw wheel event (`:213-214`). Clicky-windows animates its drawing strokes at a fixed hand speed (`STROKE_SPEED_PX_S = 420.0`, `ui/overlay.py:61`) so that long motions take visibly longer; apply the same principle: emit N wheel ticks with `scroll_delta / N` per tick over the action's `duration_ms` rather than one jump. This makes scroll *legible* on the twin cursor, which is the user's stated requirement ("scroll are visibly animated").

14. **`app/desktop_actions/session.py` → `DesktopActionSession.click()` (line 442) and `_target_point()` (line 710)** — `click()` resolves the point at `:456` and immediately calls `self.driver.click(...)` at `:457`, with no opportunity for an observer to animate the approach. Introduce a **pre-action hook** (or an `on_approach(point, duration_ms)` callback on the session) invoked between `:456` and `:457`, and give the session the same dwell/return discipline Clicky has: flight → dwell → return (clicky `:485-488` → `:572-601` → `:635-648`). The ownership lock at `InputOwnershipLock` (`session.py:40`, `acquire`:51, `release`:59) is the natural place to hold the cursor in "agent owns the pointer" mode for the whole dwell.

15. **`electron/main.ts` → new `overlay:cursor` payload / `electron/renderer/overlay.ts` → `onCursor` (line 676)** — add the secondary-cursor concept. openclicky's `OpenClickyExternalProxyCursor` (`CompanionManager.swift:37-42`) plus its `POST /cursors` bridge (`OpenClickyExternalControlBridge.swift:255`) shows the shape: a list of `{id, screenLocation, caption, accentHex}` with per-cursor TTLs floored at 0.2 s (`CompanionManager.swift:2531-2534`), rendered at the same `(+35, +25)` offset with a per-cursor accent (`OverlayWindow.swift:1116-1122`). Magic Pointer's agent stack already has multiple concurrent tools; a single cursor will thrash between subtasks. This is the single highest-value item in this list.

16. **`electron/element_ghost_policy.ts` (lines 16-20: `MAX_GHOSTS = 1`, `HOLD_MS = 900`, `FADE_MS = 400`)** — `MAX_GHOSTS = 1` caps the element-box replay to one box. openclicky's secondary cursors are unbounded (`showExternalSecondaryCursor` appends without a cap, `CompanionManager.swift:2522-2526`) and its active-control glow carries a **label** alongside the rect (`activeControlGlowLabel`, `CompanionManager.swift:2941-2942`). Raise the cap or add a distinct "target cursor with label" pathway so the twin cursor can annotate several targets at once. The ghost hold/fade (900/400 ms) is close to Clicky's 2.4 s glow (`:2921`) but reads as a flash; consider aligning.

17. **TARGET: TBD — search `InputOwnershipLock` / `process_input_lock`** — there is no equivalent of openclicky's `activeControlGlowClearTask` cancel-before-reschedule discipline (`CompanionManager.swift:2945-2961`: `clearTask?.cancel()` then re-schedule, with a `Task.isCancelled` re-check after the sleep at `:2954`). Magic Pointer's own `ResponseOverlayAutoHidePolicy` generation counter pattern (`external/openclicky/cursor-buddy/ResponseOverlayAutoHidePolicy.swift:15-45`) is the Swift version of the same idea and is directly portable as a pure function — I recommend porting *that* type rather than openclicky's Task-based version, because it is testable without a window.

18. **TARGET: TBD — search `wiggle_detector` / `WiggleDetector`** — the cursor-follow loop and the wiggle detector both poll `screen.getCursorScreenPoint()` on separate timers (`main.ts:3882-3890`). Clicky has exactly one cursor sampling loop (`OverlayWindow.swift:412`) and puts it on a dedicated high-priority queue specifically so it is "independent of main-actor pressure" (`:1228-1235`). Consolidate, or accept two `getCursorScreenPoint()` calls per tick.

19. **`electron/renderer/overlay.ts` → new cursor element, entrance/exit** — use `.transition(.opacity.combined(with: .scale(scale: 0.92)))` semantics from openclicky's secondary cursor (`OverlayWindow.swift:1124`): the cursor should appear with a small scale-up, not pop. Exit is a fade; openclicky fades the whole overlay at 400 ms `easeIn` (`:3207-3223`).

20. **`electron/renderer/overlay.ts` → new cursor element, click ripple** — port openclicky's `OpenClickyActiveControlGlowView` geometry exactly (`OverlayWindow.swift:1663-1696`): 5 stacked rounded-rect strokes, each inset 5 px, `lineWidth = 5 − index`, opacities `[0.55, 0.32, 0.20, 0.13, 0.08]`, plus a core 1.4 px border at α0.78; corner radius `clamp(min(w,h) × 0.05, 10, 30)`; pulse `blur 0.9 ↔ 0.45` and `opacity 0.68 ↔ 0.92` on `.easeInOut(0.75).repeatForever(autoreverses: true)`. Anchor it to the **control rect**, not the cursor point — Clicky glows the thing being clicked, and that is what makes the click legible. Also honour `accessibilityReduceMotion` the way openclicky does (`:1680-1689`) — Magic Pointer has no equivalent guard on its guide flight today.

---

## Copy-paste spec

A precise implementable spec for a Windows twin-cursor controller. No real code — exact API names, flags, constants. Assumes Electron main process + a renderer surface, and a Python side that already owns the real input path (`app/computer_operator/windows.py`).

### A. Surface

Create one Electron `BrowserWindow` per display, at startup, and never move or recreate it.

```
for each display in screen.getAllDisplays():
    win = new BrowserWindow({
        x: display.bounds.x, y: display.bounds.y,
        width: display.bounds.width, height: display.bounds.height,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        fullscreenable: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        skipTaskbar: true,
        hasShadow: false,
        show: false,
        alwaysOnTop: true,
        focusable: false,                     // THE no-focus-steal flag
        acceptFirstMouse: false,
        webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false }
    })
    win.setAlwaysOnTop(true, 'screen-saver')          // level string, not boolean
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setIgnoreMouseEvents(true, { forward: true }) // click-through, keep forwarding mousemove
    win.setContentProtection(false)                   // cursor MUST be capturable; do not exclude it
    win.loadFile(renderer/cursor.html)
    win.showInactive()                                // never .show() — that can activate
```

Do **not** set `setContentProtection(true)` on this window. `main.ts:881-889` and `:961-969` set it on the overlay and stage so the capsule never contaminates screenshots; the twin cursor is the opposite case — the agent's own screenshots should show where the cursor is, and Clicky takes no display-affinity call anywhere.

Windows-specific gotchas to encode:
- Shrink the bottom edge by **2 px** (`geo.setBottom(geo.bottom() - 2)` in Qt terms, `ui/overlay.py:390-392`) or the auto-hide taskbar's hover trigger dies under a full-screen topmost window. In Electron: set `height = bounds.height - 2`.
- Never call `setBounds` on this window after creation. Magic Pointer's own log at `main.ts:3427-3429` records that repeated `setBounds` on a transparent overlay causes the cursor to flicker between the CSS cursor and the native one because Windows re-establishes the cursor clip region on every resize.

### B. Sampling

```
cursorTimer = DispatchSourceTimer equivalent (setInterval / setImmediate loop), interval = 16 ms (62.5 Hz), leeway 3 ms
each tick:
    p = screen.getCursorScreenPoint()          // global, physical-or-DIP per Electron
    if p == lastSampled: return                // sample dedup — openclicky OverlayWindow.swift:1243
    if updateQueued: return                    // coalesce — openclicky :1246
    updateQueued = true
    send to the covering display's renderer:
        { x: p.x - bounds.x, y: p.y - bounds.y, gx: p.x, gy: p.y, t: performance.now(), displayId }
    on renderer ack: updateQueued = false
```

Send to the renderer whose `display.bounds` contains `p` — one window per display, so no window ever moves.

### C. Renderer state machine

Constants (name them; do not inline):

```
OFFSET_X            = 35          // clicky OverlayWindow.swift:348
OFFSET_Y            = 25          // clicky :439-440
TRI_SIZE            = 16          // clicky :307 ; clicky-windows ui/overlay.py:38
TRI_REST_ROTATION   = -35         // degrees; clicky :140
ACCENT              = '#3380FF'   // clicky-windows ui/overlay.py:43
SPRING_STIFFNESS    = 0.28        // clicky-windows :492  (tuned for exactly 60 Hz)
SPRING_DAMPING      = 0.62        // clicky-windows :492
TICK_MS             = 16
FLIGHT_MIN_MS       = 600         // clicky :510  (use 1600 for teacher pace, clicky-windows :364)
FLIGHT_MAX_MS       = 1400        // clicky :510  (use 2800 for teacher pace)
FLIGHT_PX_PER_MS    = 1/800       // clicky :510  (1/700 for teacher pace)
ARC_FRACTION        = 0.20        // clicky :521
ARC_MAX_PX          = 80          // clicky :521
SCALE_PULSE         = 0.30        // clicky :566  -> 1.3x at apex
DWELL_MS            = 3000        // clicky :592  (4000 for teacher pace, clicky-windows :163)
BUBBLE_FADE_MS      = 500         // clicky :595
RETURN_MS           = 1400        // clicky-windows :164
RING_BASE_R         = 26          // clicky-windows :272
RING_PULSE_PX       = 6           // clicky-windows :695
RING_PHASE_STEP     = 0.08        // per tick; clicky-windows :506
CANCEL_DISTANCE_PX  = 100         // clicky :426
CLICK_HOLD_MS       = 35          // openclicky OpenClickyComputerUseRuntime.swift:1106
GLOW_MS             = 2400        // openclicky CompanionManager.swift:2921
GLOW_MIN_MS         = 400         // openclicky :2939
GLOW_MAX_MS         = 12000       // openclicky :2939
```

Modes: `FOLLOW`, `FLY_TO_TARGET`, `DWELL`, `RETURN`, `DRAW` (optional, if annotations are ported).

Per frame (one `requestAnimationFrame` loop driven by the incoming sample stream, or a 16 ms timer):

```
read latest sample (x, y) and dt

if mode == FOLLOW:
    target = (x + OFFSET_X, y + OFFSET_Y)
    ax = (target.x - pos.x) * SPRING_STIFFNESS
    ay = (target.y - pos.y) * SPRING_STIFFNESS
    vel = (vel.x * SPRING_DAMPING + ax, vel.y * SPRING_DAMPING + ay)
    pos += vel
    rotation = TRI_REST_ROTATION
    scale = 1.0

if mode == FLY_TO_TARGET or mode == RETURN:
    lp = clamp((now - flightStart) / flightDuration, 0, 1)
    t  = lp * lp * (3 - 2 * lp)                  // smoothstep, NOT easeOutCubic
    pos = bezierQuadratic(start, ctrl, end, t)   // ctrl = midpoint.y - min(dist * ARC_FRACTION, ARC_MAX_PX)
    rotation = atan2(bezierTangent(start, ctrl, end, t)) * 180/PI + 90
    scale = 1.0 + sin(lp * PI) * SCALE_PULSE
    if mode == FLY_TO_TARGET:
        bubbleAlpha = min(1, lp * 1.4)
        bubbleScale = 0.5 + lp * 0.5
    if lp >= 1:
        if mode == FLY_TO_TARGET: mode = DWELL; dwellUntil = now + (hold ? Infinity : DWELL_MS)
        else: reset()                            // return leg finished

if mode == DWELL:
    pos = lockedPos                               // do not chase the pointer
    bubbleAlpha = min(1, bubbleAlpha + 0.05)
    bubbleScale += (1 - bubbleScale) * 0.15
    scale = 1 + 0.05 * sin(phase * 1.4)           // breathing
    if now >= dwellUntil:
        bubbleAlpha = 0; ring = null
        beginFlight(start = lockedPos, end = (x + OFFSET_X, y + OFFSET_Y), phase = RETURN, duration = RETURN_MS)

phase += 0.10 each tick   // drives breathing + ring
```

Flight duration selection:
```
duration = clamp(distance / (1/FLIGHT_PX_PER_MS), FLIGHT_MIN_MS, FLIGHT_MAX_MS)
if phase == RETURN: duration = RETURN_MS
```

Pointer-cancel rule:
```
if mode == RETURN and hypot(pointerNow - pointerAtFlightStart) > CANCEL_DISTANCE_PX: reset() -> FOLLOW
if mode == FLY_TO_TARGET or mode == DWELL: ignore pointer movement entirely
```

### D. Public controller API

Mirror openclicky so the surface is addressable and testable, not an action side effect:

```
pointAt(globalX, globalY, { caption?, accentHex?, dwellMs?, holdUntilRelease? })
    -> sets ring = {x, y, RING_BASE_R}; begins FLY_TO_TARGET
releasePoint()            // clears holdUntilRelease; if DWELL, expires now -> RETURN
holdPoint(true|false)     // pins dwell at Infinity while TTS/streaming is active
spawnSecondary(globalX, globalY, { caption?, accentHex?, ttlMs })  // extra cursor, default ttl 2000ms
    -> floor ttl at 200ms, cancel any prior clear task for the same id before scheduling
clearAll()                // clearProxyOverlay equivalent
clickFeedback(screenRect, { label?, durationMs = GLOW_MS })
    -> clamp durationMs to [GLOW_MIN_MS, GLOW_MAX_MS]; cancel prior clear task first
```

`clickFeedback` must be driven by the **actual click dispatch**, emitted from the Python side immediately before `SetCursorPos` in `app/computer_operator/windows.py:175` / `session.py:457`, with the target rect — not from the Electron side guessing.

### E. Press / click animation

Clicky has no literal "scale-down on press" anywhere; the closest and best-specified feedback is openclicky's `OpenClickyActiveControlGlowView` (`OverlayWindow.swift:1663-1696`). Spec it exactly:

```
5 concentric rounded rects over the control rect:
    for index in 0..4:
        inset     = index * 5 px
        lineWidth = 5 - index px
        opacity   = [0.55, 0.32, 0.20, 0.13, 0.08][index]
        radius    = max(2, clamp(min(w,h) * 0.05, 10, 30) - index * 0.35)
plus a core border: 1.4 px, opacity 0.78
animated: blur 0.9 <-> 0.45, opacity 0.68 <-> 0.92
timing:   easeInOut, duration 750 ms, repeatForever(autoreverses: true)
lifetime: durationMs (default 2400), then fade out
reduce-motion: blur 0.2, opacity 0.82, no pulse
```

If a press-down cue on the cursor itself is wanted (Clicky does not have one, so this is new design, not a port), the only in-repo precedent for a scale-down is the secondary cursor's entrance at `OverlayWindow.swift:1124` (`scale 0.92`), which is a reasonable magnitude.

### F. Ordering guarantee

The whole point of the feature is that the click must not land before the cursor arrives. Enforce it:

```
1. Python resolves target point (session.py:_target_point)
2. Python emits approach(targetPoint, durationMs = flightDuration(distance)) to Electron
3. Electron flies the twin cursor; on arrival, acks
4. Python proceeds: SetCursorPos(target), mouse down, sleep(CLICK_HOLD_MS), mouse up
5. Python emits clickFeedback(rectOfTarget)
6. Python emits releasePoint() after dwellMs (or on TTS end)
```

Steps 3 and 4 are strictly ordered across processes. If the ack does not arrive within `flightDuration + 250 ms`, proceed anyway — never let a UI animation stall an agent action. Clicky never blocks on its own animation (`OverlayWindow.swift:495-568` is fire-and-forget with a completion closure), and it deliberately **does not** cancel the flight on pointer movement (`:416-419`), so a stalled overlay must not become a stalled click.
