# Vida circle-and-point vs Magic Pointer — recon D

> 2026-09-16. Recon worker D. Sources read locally only (no web).
> Every claim carries `path:line`. Nothing asserted that was not read.
> Deliverable of RECON WORKER D; **no code was modified**.

## Scope and the one correction that changes everything

The brief assumes Vida turns a **freehand stroke** into a region. **It does not.**

Vida's own settings copy is explicit and is the strongest evidence in the set:

> `区域截图快捷键` — `按下此快捷键后拖动选择区域，然后打开浮动聊天。` — binding `Alt 4`
> `全屏截图快捷键` — `按下此快捷键可立即截取当前屏幕，然后打开浮动聊天。` — binding `Alt 3`
> — `参考/Vida实机体验/15.png` (Settings › 快捷键)

Step order per that copy: **hotkey → drag a region → the floating chat opens.** There is no
ink stroke, no lasso, and no intermediate toolbar. This is confirmed independently by the
repo's own prior research:

- `Vida.md:184` — the capability table lists, for Vida, `指代（"这个"）: ❌ 只有截图剪刀`, against
  our `划线 + semanticPoint + THIS/THAT/THESE/HERE ✅`.
- `Vida.md:298` — `底部大胶囊输入条**取代**划线 —— 那是他们没有指代能力的代偿——只能取整个前台窗口，
  所以必须靠模型猜你说的是哪个。剪刀那种"取一块屏幕"可作补充入口，但不能覆盖划线`.
- `Vida.md:41` — demo 003 简历救星: `输入条**左下角是剪刀**（截屏区域）`.

So: **Magic Pointer's circle-and-point is a capability Vida does not have.** The user's
complaint — *"那个写 prompt 跟我们圈点是一致的啊但我们圈点老是出问题"* — is a complaint about
the *outcome* (region → prompt → answer), not about parity of mechanism. Vida's implementation is
the simpler rectangular scissor. That reframes the task: we are not catching up to Vida on
pointing, we are **fixing our own pointing so it degrades to Vida's scissor reliably**.

Corollary for the roadmap: the "Vida parity" bar is *rect-drag → floating chat → auto-answer*.
Our circle/point must work **at least as reliably as a rectangle**. Today it does not, and the
defects below say why.

---

## Vida pipeline, step by step

### 1. Entry — three independent affordances, no pointing

- Global hotkeys: `Double Alt` = Spotlight / 浮动聊天; `Alt 4` = region capture; `Alt 3` =
  fullscreen capture; `Alt V` = voice input; `Alt T` = voice recognition; `Ctrl Enter` = send
  edited message — `参考/Vida实机体验/15.png`.
- Persistent desktop pet (桌宠) pinned at the **top-right of the screen**, whose vertical menu is
  `打开首页 / 截图 / 专注 / 提醒 / 隐藏桌宠` — `参考/Vida实机体验/12.png`. Note the menu itself carries
  `截图`: the pet is a second entry to capture. Hidable via the account menu (`隐藏桌宠`,
  `参考/Vida实机体验/14.png`).
- The pet is the only always-on screen artefact. It does not read the screen.

### 2. Region capture — rectangular drag, not a stroke

- Mechanism: hotkey → **drag** → the floating chat opens (`参考/Vida实机体验/15.png`, quoted above).
- Marketing illustration for the same step, `参考/Vida实机体验/10.png`: `把你看到的展示给 Vida` /
  `按 Alt+4 截取屏幕任意区域。Vida 可以根据你看到的内容进行解释、总结或任务执行。`
  **No rubber-band, no ink stroke, and no halo is drawn** — the region exists only as an
  attachment on the user's chat bubble.
- Onboarding for the same feature, `参考/Vida实机体验/08.png`, shows a translucent **amber/yellow
  highlight band with a yellow border** over a paragraph plus an emoji stamp. This is an
  illustration of the *selected* state, and is the closest thing in the whole set to a selection
  affordance. It is a **highlight over the region**, not ink.
- **The one genuine annotation-like artefact** in the set: `参考/Vida实机体验/19.png` shows, inline in
  the message stream above the assistant turn, a **dashed 1px rectangle with four circular corner
  handles** containing large red brush-style Chinese text `如果只是这样感觉很垃圾啊...`. Dashed border
  + corner handles = a transformable object, i.e. an editable annotation the user drew or pasted.
  It is not system selection chrome.

### 3. Region → prompt — the region attaches to the user turn, then something auto-runs

- `参考/Vida实机体验/10.png` illustration: the region appears as a **clip-icon attachment at the
  bottom-left corner of the user bubble**, with the typed question as the bubble text. It is an
  attachment *inside* the message, not a thumbnail strip beside the composer.
- `参考/Vida实机体验/18.png` is the only real in-flow capture. It shows the floating chat over
  WeChat with:
  - a header title **`询问并说明微信聊天页面内容`** — an auto-generated task title,
  - user turn `你看到了这个页面的什么内容?` at `15:19`,
  - `思考了 6 秒`,
  - an answer that describes the WeChat window contents in bullet points.
- **Critically: no region thumbnail, no highlight, and no stroke is visible anywhere in 18.png**
  — not on the desktop, not in the floating window. The capture happened (the model describes
  window contents) but **leaves no visible artefact**. If our product is expected to render the
  circled region, Vida is not the reference for that; the reference is 08.png/19.png.
- Lifecycle seen in the demos (from `参考/Vida` MP4s, frames extracted at 1 fps):
  - input pill appears mid-screen with a model chip on the left and a submit control on the right
    (`ReplyRescue`),
  - submitting swaps the placeholder to `Generating ...` and the submit control to a **stop**
    button, with a **rainbow gradient sweeping left→right** as the progress indicator — no
    percentage, no spinner (`ReplyRescue`, `PromptRescue`),
  - a **`TASK FINISHED`** card with `Reject` / `Approve` radio plus bottom action buttons
    (`PromptRescue`, `ReplyRescue`, `WorkspaceCleanup`),
  - per `Vida.md:39`, the evidence list streams as `✓ Reviewed latest Figma onboarding flows` →
    `12/16 screens finalized` → `Mobile handoff still pending`, ending with green
    `✓ Vida has completed your task`, and the placeholder becomes a follow-up entry.
- `Vida.md:45-51` states the six transferable design rules from those demos. The two that bear on
  this task: **rule 3 — write the artefact into the target app's input box, not "copied to
  clipboard"**; **rule 5 — bind the follow-up box to the current foreground page so the
  placeholder changes when the window changes.**

### 4. Region → prompt text, concretely

Vida shows no prompt template. The composition is: **auto-title + region attachment + the user's
typed text**, sent as one turn (`参考/Vida实机体验/18.png`). The action menu
(`解释 / 总结 / 任务执行`) exists **only as prose** in the 10.png subtitle — there is no chip row
in any real screenshot. Nothing in the reference set shows Vida combining typed text with the
region into a synthesized prompt string; the region is an attachment and the model sees it.

Contrast with the one comparable open-source implementation: Mint joins them by
**string concatenation of image data URIs** — `external/mint/src/renderer/shared/components/MintDashboard.tsx:817-822`
(`outgoingImage = outgoingImages.map(i => i.dataUri).join(' ')`), with literal `[Image #1]`
markers injected into the user's text at `external/mint/src/renderer/src/tauri.ts:538-551`.
Default prompt only when the composer is empty: `'Describe this image.'` —
`external/mint/src/renderer/shared/components/MintDashboard.tsx:984-988`.

### 5. Coordinate handling across monitors — Vida ships a known-broken version

The relevant reference implementations, and what each actually does:

- **selection-hook** (the primitive we already vendor): coordinates are **raw physical pixels** in
  the per-monitor-DPI-aware virtual screen. The addon calls `SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE)`
  (`external/selection-hook/src/windows/selection_hook.cc:2551-2584`, called from the ctor at
  `:361`) and then does **no conversion at all** — a repo-wide grep for `GetDpiForWindow`,
  `LogicalToPhysicalPoint`, `MonitorFromPoint`, `GetDpiForMonitor` returns zero hits in
  `src/`. Conversion is explicitly pushed to the consumer:
  `docs/API.md:361-364` — *"To convert to logical coordinates (DIP) … Windows: Use
  `screen.screenToDipPoint(point)` in Electron."* Same at `docs/GUIDE.md:471-481`, `index.d.ts:12`.
  macOS is the exception (`docs/API.md:363`) and `screenToDipPoint` is unavailable there.
- **normcap**: the robust pattern. It grabs **one image per screen** and derives the crop scale
  from **measured pixels**, not from an API:
  `external/normcap/normcap/gui/window.py:192-196` returns `self.screen_.screenshot.width() / self.width()`,
  applied at `window.py:341`. The multi-monitor split uses a single global scalar from image width
  vs virtual-geometry width — `external/normcap/normcap/screenshot/post_processing.py:15`
  (`ratio = full_image.rect().width() / virtual_geometry.width()`), applied at `:22-31`. That
  scalar is a known approximation: the ADRs call mixed-DPI out twice —
  `external/normcap/adr/001-choose-transparent-windows-as-main-gui.md:66-68` and
  `external/normcap/adr/002-choose-windows-with-screenshots-as-main-gui.md:52-54`
  (*"really hard to a) get the right dpi settings for each monitor b) display the screenshots
  using the right resolution for each monitor, especially in mixed dpi setups"*).
  The unresolved TODOs are left in the source: `window.py:240-242`
  (`TODO: Test in Multi Display setups with different scaling`).
- **mint**: the same class of bug we have. Its crop uses a measured ratio
  (`external/mint/src/renderer/src/components/ScreenPicker.tsx:194-199`,
  `scaleX = baseImage.width / bg.width`), but its translate path sends a **CSS/DIP rect** straight
  into a **physical-pixel** crop with no conversion on either side —
  `ScreenPicker.tsx:213` → `tauri.ts:1564-1568` → `lib.rs:1528-1532` → `desktop.rs:232-243`
  (`image.crop_imm(rect.x, rect.y, width, height)`).
- **Vida itself**: no coordinate handling is observable in any artefact we have. It is a
  rectangle drag on one monitor; the reference set contains no mixed-DPI evidence. `参考/Vida` is
  five 1920×1080/60fps MP4s; all frames are single-monitor.

**Authoritative space, per the reference implementations:** physical screen pixels are the wire
format; conversion to DIP happens once, at the UI boundary, via `screen.screenToDipPoint` /
`screenToDipRect`. That is exactly the contract Magic Pointer's `coordinate_space.ts` was written
to enforce — and it is violated in eight places below.

### 6. Privacy — Vida's actual posture, and what our parity must exclude

From the product's own onboarding, `参考/Vida实机体验/07.png` (权限设置, step 3/4):

- Three permissions, each justified by a benefit sentence rather than a scope statement:
  `辅助功能` (hotkey activation), `屏幕录制` — `让 Vida 分析你当前的窗口，与你对齐上下文。`,
  `系统事件` — `让 Vida 识别你正在使用的应用…`.
- A standing `安全声明` panel, repeated verbatim at `参考/Vida实机体验/09.png`:
  `云端零留存` — `你的语音和屏幕数据均为实时处理，我们绝不在服务器上保存原始输入。`;
  `历史本地优先`; `不用于模型训练`.
- Background monitoring is disclosed **once, softly**: `参考/Vida实机体验/11.png` —
  `在你完成设置的过程中，Vida 一直在悄悄对齐你的上下文。` / `让 Vida 在后台运行，你只需要像往常一样执行
  你的工作，让 Vida 慢慢与你的上下文对齐……`, shown with a spinner and **no preview of what it saw**.
- Our own research contradicts the "local-first" claim:
  `Vida.md:31` — the privacy policy's field list is an accessibility-tree field list
  (`应用名称、窗口标题、可见文本、所选内容、按钮、菜单、文本字段及工作流信号`), and
  `Vida.md:304` — *"'本地优先'说的是记忆文件，不是上下文"*, with policy 2.2 stating desktop
  context goes to third-party model vendors.
- Vida's memory layer is `OpenChronicle`, **macOS-only**, Swift + Python, with a rolling capture
  buffer — `Vida.md:61-92`, and `Vida.md:304` confirms `mac-ax-watcher` is a Swift binary.
  `Vida.md:11` — the pipeline *"是 macOS-only，Windows 端他们自己也没解决"*.

So the thing we must **not** copy is the continuous background capture pipeline. The thing we
must match is the **on-demand region capture with a visible consent moment**.

---

## Magic Pointer defects found

Severity: **S1** = user-visible failure of the circle-and-point flow; **S2** = wrong region or
wrong text read; **S3** = degradation/latency/dead code.

### Coordinate space and DPI

**1. [S1] Coordinate-space discriminant is spelled three different ways; nothing matches.**
`electron/interaction_episode.ts:327` and `:556` write `coordinateSpace: 'physical-screen-pixels'`
(**hyphens**). The consumer `electron/coordinate_space.ts:103` tests
`gesture.coordinateSpace === 'physical_screen_pixels'` (**underscores**), and
`app/grounding/evidence_binding.py:142` tests `!= "physical_screen_pixels"`.
*Failure:* a visual-region locator emitted by the episode path is never recognised as physical —
it is either rejected by the binding guard or converted a second time.
A third spelling, `'electron_dip'`, is written at `electron/main.ts:3003`, and a fourth,
`"electron_dip_screen"`, is defaulted at `scripts/selection_snapshot_bridge.py:595`. No consumer
switches on either.

**2. [S1] The stage's screen→window origin mixes physical and DIP.** `electron/renderer/stage.ts:594-595`:
`stageOriginX = Number(payload.screenX) - x;` — `payload.screenX` is the raw screen coordinate
(`electron/main.ts:3899-3900`, sent as `screenX: pos.x`) while `x` is the stage window's local
coordinate (`electron/main.ts:3895-3896`, `x: pos.x - stageBounds.x`). Subtracting DIP from
physical.
*Failure:* the origin is only accidentally correct when the window scale is 100% or the screen
origin is 0. On a scaled or offset monitor every derived position is wrong — this is the same
origin used for the pick highlight (`stage.ts:264`), the capture-proof bands (`stage.ts:263-265`)
and the `[POINT]` arrows (`stage.ts:297-298`), so all three drift together.
Already known and unfiled as a fix: `docs/STATUS.md:233` — *"舞台的屏幕→窗口坐标换算在高 DPI 下存疑"*,
repeated at `docs/archive/planning/HANDOFF_20260805.md:233` and
`docs/archive/planning/PROGRESS_20260805.md:68`. The comment at `stage.ts:259-262` chose to
duplicate the transform deliberately so there is one place to fix it — that place is still unfixed.

**3. [S1] Physical-as-DIP fallback reintroduces the exact bug its own comment says was fixed.**
`electron/main.ts:4255-4266`. The comment states: *"Using a physical point as DIP on scaled
displays pushed the capsule past the viewport edge and clamped it into the bottom-right corner."*
Then `:4264-4265` does `screenToDipPoint(...)` only *if* the function exists, and otherwise falls
back to `{ x: Number(releasePoint.x) || 0, y: Number(releasePoint.y) || 0 }` — i.e. **uses the
physical point as DIP**.
*Failure:* on any Electron build without `screenToDipPoint` (the API is absent on macOS per
`external/selection-hook/docs/API.md:363`), the capsule returns to the bottom-right corner.
The fix is guarded by the very capability that is not guaranteed.

**4. [S2] `screenToDipRect` is called with `window = null`, so mixed-DPI conversion uses the wrong
display's scale.** `electron/coordinate_space.ts:223` — `screenApi.screenToDipRect(null, rect)`;
and the point path falls back to the same at `:235-236` with a 1×1 rect.
*Failure:* on a laptop at 150% plus an external monitor at 100%, converting a rect that lives on
the external monitor with a null window gives a rect scaled by the primary display's factor. Every
`targetDipRects` entry (`:323`) and `captureDipRect` (`:317`) inherits the error, so the region
lands off-target by the scale ratio.

**5. [S2] One gesture object carries two coordinate spaces at once.**
`electron/gesture_capture.ts:160`, `:213`, `:219` label the emitted geometry
`coordinateSpace: 'logical_dips'`. `electron/main.ts:3740-3758` converts `points`, `strokes`,
`bbox`, `semanticPoint`, `releasePoint` and `anchorPoint` to physical via `toPhysical`, but passes
`geometry` straight through unconverted at `:3769` (`geometry: summary.geometry || undefined`).
*Failure:* the containing object declares `coordinateSpace: 'physical_screen_pixels'` at `:3752`
while its own `geometry[].ring` / `geometry[].corridor` are still DIPs. Any consumer that ranks
targets by region coverage compares a DIP ring against physical rects — off by the scale factor,
silently.

**6. [S2] The minimum region thickness differs by scale factor between the two entry paths.**
`electron/main.ts:3755` calls `physicalGestureBoundingBox(allPhysical, 8 * scaleFactor)`, but
`electron/coordinate_space.ts:163` calls `physicalGestureBoundingBox(points)` with no second
argument, taking the default `minimumThickness = 8` (`:67`) — 8 **physical** pixels.
*Failure:* a near-zero-length drag yields a 16px-minimum box via one path and 8px via the other at
200%. Two callers, two answers, for the same physical gesture.

**7. [S1] The overlay and stage windows cover the primary display only.**
`electron/main.ts:851` and `:934` both do `const display = screen.getPrimaryDisplay();` then
`const bounds = display.bounds;` and size the `BrowserWindow` to it.
*Failure:* on a multi-monitor desk the overlay does not extend over the secondary monitor, so a
stroke drawn there is not captured by the overlay at all. Display-change events do exist
(`:4488`, `['display-added','display-removed','display-metrics-changed']`) but the window is
created from the primary bounds.

**8. [S2] Guide-point conversion uses one display's scale and drops the window origin.**
`electron/main.ts:1143-1148`: `const scale = (display && display.scaleFactor) || 1;` then
`win.webContents.send('overlay:guide-point', { x: x / scale, y: y / scale, ... })`. The comment
above it (`:1141-1142`) says the coordinate is physical screen pixels and the overlay canvas is
DIP, so it divides by the scale.
*Failure:* dividing by a scalar converts magnitude but not **origin**. The overlay window is
positioned at the primary display's bounds (`:851-854`), so a point on a monitor left of primary
(negative virtual-desktop x) needs `screenToDipPoint` followed by subtracting the window origin;
the code does neither. The correct primitive is used 25 lines away at `:4262-4263`.

**9. [S1] The circle-vs-underline test is in physical pixels, so it flips with monitor DPI.**
`app/perception/pixel_ocr.py:71-77`: `stroke_is_closed(points, tolerance=26.0)` — `len(points) >= 5`
and end-to-start distance `<= 26.0`. The module's own docstring at `:52` states strokes are
`Independent stroke polylines in physical screen pixels.`
*Failure:* 26 physical px is 13 DIP at 200% and 26 DIP at 100%. A circle whose ends miss by 20px is
"closed" on one monitor and "open" on a scaled one. Closed strokes get loop semantics; open strokes
get underline semantics (`pixel_ocr.py:196-221`), which reads **one OCR row only**. The same
physical circle therefore reads a different amount of text depending on the display it was drawn on.

**10. [S2] Unlabelled pixel constants are consumed in different spaces.**
`app/perception/pixel_ocr.py:238` `padding: int = 8` (physical px, applied to artifact-local
blocks). `electron/stage_pick_policy.ts:43` `MIN_PICK_EDGE_PX = 10` and `:47`
`HIT_TOLERANCE_PX = 2`, applied to UIA element rectangles. `electron/stage_stretch_policy.ts:29`
`LINE_HEIGHT_PX = 20` and `:33` `MIN_DRAG_PX = 12`, applied to a drag delta.
*Failure:* none of these names carry a space, and the codebase has three spaces in play. At 200% a
`MIN_DRAG_PX = 12` threshold becomes a 6 DIP twitch if the delta arrives physical — the policy file's
own comment at `:31-32` says *"Without a threshold, clicking the edge would fire a rewrite"*, so a
halved threshold is a rewrite-firing bug, not a cosmetic one.

### Which region — the core defect family

**11. [S1] Two independent circle classifiers with incompatible thresholds.**
TypeScript: `electron/gesture_capture.ts:186-188` — `isCircle` requires `points.length >= 6`,
`bbox.width >= 16`, `bbox.height >= 16`, `closure <= 0.36`, `circuit >= 1.65` (a shape-quality
test). Python: `app/perception/pixel_ocr.py:71-77` — `len(points) >= 5` and end-to-start distance
`<= 26.0` (a proximity-only test).
*Failure:* the two halves disagree on the same stroke. A real hand-drawn circle of radius >26px
whose ends do not meet is `circle` to TypeScript but `open` to Python, which then applies
`select_open_stroke_rect_indexes` (`pixel_ocr.py:197-200`) and keeps **one row**. Conversely a
small scribble that happens to return near its start is `freeform` to TypeScript but `closed` to
Python, which then applies the loose loop rule and pulls in everything in the bbox.

**12. [S1] The polygon ring and band corridor are built, emitted, and never consumed.**
`electron/gesture_capture.ts:89` (`buildCorridor`) and `:107` (`buildCircleRing`) produce
`polygon_region` / `band_corridor` at `:213` and `:215-217`. A grep for
`polygon_region|band_corridor|buildCircleRing|buildCorridor` across `app/` and `electron/` returns
**only those five definition/emission lines** — no consumer.
The consumer actually used is the bounding box: `app/perception/pixel_ocr.py:194`
(`region = stroke_xywh(stroke)`) and `:80-86` (`stroke_xywh` = min/max of the polyline).
*Failure:* the user's circle is reduced to its bbox, so every OCR block whose centre falls inside
that rectangle is treated as circled — including the lines above and below. The code makes this
explicit and accepts it: `pixel_ocr.py:207-211` — *"any block whose center (or the bulk of its
area) falls inside the marked region counts, so nested cards / middle lines are never dropped. A
30%+ area overlap snaps the block in whole (hand-drawn loops rarely cover a card perfectly)."*
That comment is about loops on cards; for a loose circle around one phrase the same rule imports
the neighbouring lines. **This is the single most likely explanation of "圈点老是出问题".**

**13. [S1] A point gesture has no region at all.**
`electron/gesture_capture.ts:149-167`: the quick-point branch returns
`bbox: { x: releasePoint.x, y: releasePoint.y, width: 0, height: 0 }` — a zero-area box.
`electron/coordinate_space.ts:338-340` rejects a zero-area stage target
(`invalid_stage_target`), and `electron/stage_hit_policy.ts:36` rejects zero-area regions
(`width <= 0 || height <= 0`).
*Failure:* a point/tap gesture is structurally incapable of producing a region. It can only
survive by falling into the hardcoded pointer-only box (defect 14).

**14. [S1] The pointer-only fallback is a hardcoded 16×16 DIP box.**
`electron/coordinate_space.ts:329-331`:
`pointerOnly ? { x: pointerDip.x - 8, y: pointerDip.y - 8, width: 16, height: 16 }`.
*Failure:* when nothing resolves, the region is 16×16 DIP regardless of what the user pointed at —
too small to contain a word, and its physical size (32px at 200%, 16px at 100%) means the same
gesture selects different content on different monitors.

**15. [S1] Target selection picks the nearest rect and breaks ties by array order, so containers
win.** `electron/coordinate_space.ts:332-336` reduces over `targetDipRects` keeping the rect with
the strictly smallest `distancePointToRect`. `distancePointToRect` (`:254-260`) returns `0` for any
rect containing the point, and `0 < 0` is false, so the **first** zero-distance rect is retained.
*Failure:* nested UIA rects (card → paragraph → word) all contain the point; the first in the
array — the outermost container — wins. This matches the known symptom recorded in
`docs/STATUS.md` / memory: *"UIA 返回容器名"*. Nothing here ranks by area or depth.

**16. [S2] The pick path and the grounding path pick different elements for the same pointer.**
`electron/stage_pick_policy.ts:109`: `if (best === null || area(rectangle) < area(best)) best = rectangle;`
— the **smallest** containing rect, with `reason: 'smallest_containing_element'` (`:115`).
`electron/coordinate_space.ts:332-336` picks the **nearest**, which on ties is the outermost.
*Failure:* hover (pick) lights up the word; the capture (grounding) sends the card. The user sees
one thing highlighted and another thing read. Two policies for one pointer, no reconciliation.

**17. [S2] "Coverage unknown" and "coverage confirmed" rank identically, so an unchecked provider
can win.** `app/perception/fusion.py:103-114`: the first rank key is
`1 if item.covers_mark is False else 0` — only `False` is penalised; `True` and `None` both score
`0`. The next key is `1 if item.container_hint else 0` (`:108`).
*Failure:* an observation from a provider that never evaluated coverage can therefore outrank one
that positively covered the mark, decided by container-ness. The module docstring at `:5-6` claims
fusion *"is the only place allowed to decide which evidence represents the user's mark"* — the
ranking does not actually reward coverage.

**18. [S2] Whether to spend the pixel tier is decided by a different evidence set than which
observation is selected.** `app/perception/fusion.py:141-145`: `pixel_tier_warranted` returns `False`
if **any** observation has `marked_content and not container_hint`; selection uses
`min(candidates, key=_rank_key)` (`:129`).
*Failure:* provider X claims to have read the marked content and provider Y is the selected one;
the pixel tier is skipped because X said so. The cheap confirmation is suppressed by a provider
whose answer was not used.

### Gesture capture, thresholds, and dropped input

**19. [S1] A slow deliberate point is silently dropped.** `electron/gesture_capture.ts:147-171`:
the quick-point branch requires `durationMs <= 420 && pathLength <= 14` (`:32-33`, `:147-148`).
Anything that fails that falls to `:169` — `if (pathLength < minDistance || durationMs < minDurationMs)
return null;` with defaults `minDistance = 12`, `minDurationMs = 40` (`:132-133`).
*Failure:* press, hold still for >420ms, release — a deliberate "point at this". `pathLength` is
~0, so it is not a quick point; it fails `pathLength < 12`, so it returns `null`. The gesture is
dropped with no error surfaced. This is the common deliberate-point case.

**20. [S2] Points without timestamps are treated as milliseconds and short gestures are dropped.**
`electron/gesture_capture.ts:47`: `t: Number.isFinite(t) ? t : index` — a missing `t` becomes the
array index. `:145`: `durationMs = finalPoint.t - points[0].t` — so a 3-point stroke without
timestamps has `durationMs = 2`.
*Failure:* `:169` rejects it (`2 < 40`), so any caller that sends `{x,y}` pairs without `t` has
every stroke shorter than 40 points silently discarded. Note `coordinate_space.ts:117` and `:148`
both supply `t: 0` when `t` is absent — arriving at the same place by a different route.

**21. [S1] A screen-API failure erases the whole gesture, indistinguishably from "no gesture".**
`electron/coordinate_space.ts:146` calls `physicalScreenPoint(screenApi, point)`, which returns
`null` when `screenApi` is missing or `dipToScreenPoint` is not a function (`:50`), or when the
call throws (`:62-63`). Points that fail become `null` (`:148`), strokes with fewer than 2 survivors
are dropped (`:151`), and if every stroke dies then `points.length < 2` and the function
`return null` (`:153`).
*Failure:* no reason code, no error, no log — the user's circle vanishes. Same at `:123` for the
pre-physical path. Downstream cannot distinguish this from "the user did not gesture".

**22. [S2] A NaN release point is silently relocated to the primary monitor's origin.**
`electron/coordinate_space.ts:130-131`:
`x: Math.round(Number(releasePoint?.x) || 0), y: Math.round(Number(releasePoint?.y) || 0)`.
*Failure:* `NaN || 0` is `0`, so a corrupt release point places the capsule at (0,0) — the top-left
of the primary monitor — instead of failing. (A legitimate coordinate of `0` survives, so this is a
pure NaN-masking bug.)

**23. [S2] Stroke budget truncation is applied per stroke and changes the shape classification.**
`electron/coordinate_space.ts:109` and `:142` both do `rawStrokes.slice(0, 8)`; `:112` and `:145`
do `.slice(0, 512)` per stroke. `electron/gesture_capture.ts:255` does
`stroke.points.slice(0, remaining)` against a `maxPoints = 4096` budget (`:241`).
*Failure:* a truncated stroke has a different `bbox`, a different `pathLength` and a different
`closure` — so a circle cut short can be reclassified as a line or freeform (`gesture_capture.ts:186-189`),
and the bbox is computed from a partial stroke. The comment at `gesture_capture.ts:229-234` promises
*"every stroke keeps its own region"*; the budgets quietly break that.

**24. [S2] The visible ink and the evaluated ink are different 8-stroke subsets.**
`electron/coordinate_space.ts:109`/`:142` keep the **first** 8 strokes; `electron/renderer/sweep_visual.ts:403`
does `.slice(-8)` — the **last** 8 — before drawing.
*Failure:* with 9+ strokes the user sees the last 8 drawn while the system evaluates the first 8.
Multi-stroke is an advertised feature (`gesture_capture.ts:229-234`, "circle this, and this, then
run the command"), and `maxStrokes` allows 32 (`:242`).

**25. [S1] A lost pointerup captures the mouse permanently.** `electron/stage_hit_policy.ts:54`:
`if (dragging === true) return true;` — no release path, no timeout, no verification that the drag
began inside the stage. The file's own comment (`:43-47`) explains the intent (pointer capture
across the drag).
*Failure:* `dragging` is a flag the caller must clear. The team already documents that pointerup is
unreliable on Windows — `electron/gesture_capture.ts:1-2`: *"pointer-up delivery on Windows can be
delayed by overlay activation even when the user performs a normal tap."* If the up event is lost,
the overlay holds the mouse forever and the user cannot click anything underneath.

**26. [S3] Three different widths for "the band I painted".**
`electron/gesture_runtime_settings.ts:35` allows `lineWidthDip` up to 40 (default 40, min 3).
`electron/renderer/sweep_visual.ts:224-225` clamps the drawn width to `[8, 40]` and then halves it
through `bodyHalfWidth = clamp(width * 0.34, 4.5, 8.5)` — a body of 9 to 17 CSS px. The region
corridor is a third number: `electron/gesture_capture.ts:85-86`, `corridorWidthFor` =
`clamp(pathLength * 0.05, 10, 36)`.
*Failure:* the band the user sees, the width they configured, and the region that gets selected are
three different quantities. Comment at `sweep_visual.ts:225` and `gesture_runtime_settings.ts:35`
share no cross-reference.

**27. [S2] Freshly captured anchors can never resolve `exact`, so every circle resolves `changed`.**
`app/anchor/resolver.py:139` (`if expected is not None and candidate.content_hash == expected`)
and `:108` (`if expected is not None`) — with `anchor.content_hash is None`, the structure tier
falls through to `ResolutionChanged` at `:144-149`, and the hash tier returns `ResolutionChanged`
at `:116-121`. The docstring at `:24-29` states this is deliberate ("never claims exact on that
basis").
*Failure:* a just-circled target is by definition captured without an expected hash, so the
first resolve of anything returns `changed`. Any downstream gate that requires `exact` — the whole
point of the five-way union, `app/anchor/anchor.py:7` — never passes for the region the user just
marked. Only the spatial tier (`resolver.py:151-163`) produces `moved`.

### Session lifecycle, races, and multi-stroke

**28. [S1] A second stroke orphans the first request; the first result is dropped.**
`electron/selection_session.ts:255-263` — `startRequest` checks only `!entry || !entry.snapshot`,
never `entry.state`, then overwrites `entry.activeRequestId = requestId` at `:259` and sets
`state = 'running'`. `finishRequest` at `:265-272` returns `null` unless
`entry.activeRequestId === requestId`.
*Failure:* the user circles A, the request is in flight, they circle B. B's `startRequest`
replaces `activeRequestId`. When A's model call returns, `finishRequest` for A returns `null` and A's
answer is discarded with no error. This is the multi-stroke case the gesture layer explicitly
supports (`gesture_capture.ts:229-234`) and it is broken at the session layer.

**29. [S2] Attaching a snapshot resets a running session's state.**
`electron/selection_session.ts:191`: `entry.state = entry.snapshot ? 'ready' : 'unavailable';`
*Failure:* a late capture arriving while `state === 'running'` rewrites the state and discards the
in-flight marker (which is exactly how `cancel`/`isCurrentRequest` reason about liveness,
`:274-277`).

**30. [S2] Panel placement has no layout nonce, so a stale placement can apply to a new layout.**
`electron/selection_session.ts:198-209` — `setPanelLayout` stores a `nonce`, sets
`panelPlacement = null` (`:207`). `setPanelPlacement` at `:211-216` takes no nonce and applies
unconditionally.
*Failure:* the out-of-order arrival the nonce exists to catch — old placement landing after a new
layout — is not caught. This governs where the chip/menu appears, i.e. the one thing the user
sees between finishing the circle and getting an answer.

**31. [S3] A running session can be evicted mid-request.** `electron/selection_session.ts:115-117`
counts `'running'` as frozen, and `:134-143` `evictOverflow` drops the oldest frozen sessions
beyond `maxFrozen = 24` (`:104`). An evicted running session makes its `finishRequest` return
`null` (`:267`) and the answer is lost.

**32. [S3] Draft rejection is silent.** `electron/selection_session.ts:224-234` returns `null` for
an empty prompt, `prompt.length > 60000`, a missing `contextPacket`, or
`contextPacket.schemaVersion !== 2`. The caller cannot distinguish "rejected" from "no such
session", so a schema bump from 2 to 3 would silently stop all drafts.

**33. [S2] Only the first visual anchor is ever looked at.** `app/perception/visual_once.py:48-54`:
the loop `return`s on the first `visual_anchor` fact. If its `value` yields an empty token it
returns `None` at `:53` and abandons the search for later anchors.
*Failure:* for a multi-stroke selection (`strokeRefs` is one chip per stroke,
`electron/renderer/stage.ts:490`, `:2290-2301`), the vision fallback resolves **stroke 1 only**.
Strokes 2..n get no look-once.

### UIA read — the silent first-circle failure

Context: our own research established this as the highest-value bug.
`Vida.md:12` — *"任何我们从没碰过的 Chromium 窗口（Electron / Tauri / WebView2 / 浏览器），第一次
UIA 读一定是错的，而且静默。"* `Vida.md:134-140` (experiment E4) measures the cold tree: 48 nodes,
21 named, **0 hits** on the marker; at +50ms, 72 nodes and **5 hits**. `Vida.md:166` — *"用户打开
应用→晃动→划线，那就是第一次触碰。这也是它一直没被抓到的原因：自己开发时反复测同一个窗口，第二次起就是好的。"*
The fix landed as `is_cold_tree`, and the implementation has its own defects.

**34. [S1] The two retries use different host lists, so Tauri/WebView2 windows get no retry when
the probe returns nothing.** `app/adapters/uia_text_adapter.py:610` gates the first retry on
`_is_chromium_window(window)`, defined at `:444-449` as class in
`{Chrome_WidgetWin_1, Chrome_WidgetWin_0, Chrome_RenderWidgetHostHWND}` **or** title containing
`edge`/`chrome`/`brave`. The cold-tree retry at `:626` uses `is_cold_tree`, whose host table at
`:454-462` includes `WRY_WEBVIEW` (Tauri), `Tauri Window`, `WebView2` and
`Microsoft.UI.Content.DesktopChildSiteBridge`.
*Failure:* a Tauri or WebView2 app whose probe produced no data at all — the exact case the 450ms
retry exists for — fails `_is_chromium_window` (its class is `WRY_WEBVIEW`, its title has no
browser name) and skips the retry entirely. Only the 60ms cold-tree retry remains, and that one is
gated on `probe.data`, which is empty. The window is read once, cold, and reported as unreadable.

**35. [S3] The documented `named_count` parameter is inert.**
`app/adapters/uia_text_adapter.py:513`: `return named_count is None or named_count >= 0` — `>= 0`
is true for every integer, so the parameter can never change the verdict. The docstring at
`:492-497` presents it as a sanity check, and `:494-495` records that `Vida.md` §7.3's
`max_depth <= 8 && named_count < 30` thresholds were falsified by real dumps.
*Failure:* none at runtime; the risk is that the docstring advertises a guard that does not exist.

**36. [S2] The cold-tree class chain was reduced from a chain to two names.**
`app/adapters/uia_text_adapter.py:626-631` passes
`[str(window.get("class_name") or ""), str(probe.data.get("class_name") or "")]` — the outer window
class and the probe root's class. `Vida.md:249-251` specifies a **类名链** (class-name chain)
including `Intermediate D3D Window`, `RootView`/`ClientView`.
*Failure:* a host whose cold signal lives in a descendant class rather than the root never matches
`COLD_TREE_WEB_HOST_CLASSES` and never retries.

**37. [S3] The 450ms retry has no measured basis and is on the interactive path.**
`app/adapters/uia_text_adapter.py:608-609` — *"450ms 这个值没有实测支撑，先原样留着"*. `E4`
(`Vida.md:134-140`) measured 50ms as sufficient.
*Failure:* a cold Chromium window that returns nothing costs 450ms, then the cold-tree branch may
add 60ms (`:632-638`) — up to 510ms before the read even starts, against a warm-path budget of
50ms (`Vida.md:253`).

**38. [S2] Block/region comparison pads by 8 physical pixels with no space label.**
`app/perception/pixel_ocr.py:238` (`padding: int = 8`) and the centre/overlap tests at `:89-116`.
Combined with defect 12 (region = bbox) this is what decides which text is "inside" the circle.

**39. [S3] The visual-anchor token is split on a hardcoded full-width parenthesis.**
`app/perception/visual_once.py:52`: `token = fact.value.split("（", 1)[0].strip()`.
*Failure:* any producer that formats the fact with an ASCII `(` or another separator makes the
"token" the entire value, which is then passed as the look-once anchor.

**40. [S3] The look-once fact is truncated at 8000 characters.**
`app/perception/visual_once.py:68` — `"; ".join(parts)[:8_000]`.

---

## Coordinate-space contract

### The contract Magic Pointer should have

Five spaces exist in this system. Name them, and allow exactly one crossing point between each
adjacent pair.

| Space | Unit | Where it is authoritative | Never crosses into |
|---|---|---|---|
| `physical_screen_pixels` | physical px, virtual-desktop origin | native hooks, `desktopCapturer`, UIA element rects, OCR block rects, all IPC on the wire | DOM, CSS, layout |
| `dip_screen` | DIP, virtual-desktop origin | `screen.*` Electron APIs | the renderer's local math |
| `dip_window` | DIP, window-local origin | renderer hit testing, `getBoundingClientRect`, `setShape`, CSS `px` | anything screen-global |
| `artifact_local` | px, frozen-frame origin | OCR results, crop math | screen-global tests |
| `image_pixels` | physical px of the model's input image | `[POINT]` from a vision model only | never used for hit testing |

Rules, in order:

1. **Physical pixels are the wire format.** Every cross-process payload that carries geometry
   declares `coordinateSpace: 'physical_screen_pixels'` — one spelling, one enum, validated at the
   boundary and rejected otherwise. (This is what `app/grounding/evidence_binding.py:142` already
   tries to enforce; it needs a shared constant, not four string literals.)
2. **Exactly two conversion functions exist**, both thin wrappers over Electron's own APIs:
   `physicalPointToDip(screenApi, window, point)` and `physicalRectToDip(screenApi, window, rect)`.
   Both take a **window or an explicit display**, never `null`, so mixed-DPI resolves to the right
   display's scale factor. (Today: `electron/coordinate_space.ts:223` and `:235-236` pass `null`.)
3. **Converting magnitude and converting origin are separate operations and both are mandatory.**
   `x / scaleFactor` is not a coordinate conversion (defect 8). A point on a secondary monitor needs
   `screenToDipPoint` **and** subtraction of the target window's origin.
4. **`dip_window` crossings happen once, in the renderer, at a single named function.** The origin
   must be stored in one space: either both terms physical, or both DIP. (Today:
   `electron/renderer/stage.ts:594-595` subtracts DIP from physical, and `docs/STATUS.md:233`
   already says so.)
5. **A region is a polygon, not a bbox.** The moment a stroke becomes a selection it gets one
   canonical polygon (or a list of rects), and *every* consumer — cover test, OCR scoping, UI
   highlight, model grounding — uses that same polygon. (Today: `electron/gesture_capture.ts:213-217`
   builds it, nothing reads it, and `app/perception/pixel_ocr.py:194` re-derives a bbox — defect 12.)
6. **Classify the stroke once.** `circle` / `line` / `freeform` / `point` is decided in exactly one
   place, and the decision travels with the region. (Today: `gesture_capture.ts:186-188` and
   `pixel_ocr.py:71-77`, with different thresholds — defect 11.)
7. **Every threshold constant carries its unit in its name.** `MIN_PICK_EDGE_PX` must become
   `MIN_PICK_EDGE_DIP` or `MIN_PICK_EDGE_PHYSICAL`. Where a threshold is compared against
   user-drawn physical geometry, derive it from the scale factor rather than hardcoding
   (defect 9: `tolerance=26.0`).
8. **Any gesture that cannot be converted to a region is reported, not dropped.** Conversion
   failure returns a typed reason (`screen_api_unavailable`, `empty_region`,
   `release_point_unresolved`) that reaches the user as one sentence. (Today: `coordinate_space.ts:153`
   returns `null` — defect 21; `gesture_capture.ts:169` returns `null` — defect 19.)
9. **Failure is fail-closed.** When a space is unknown, do not guess — do not substitute `0` for
   NaN (defect 22), do not fall back to physical-as-DIP (defect 3), do not substitute the primary
   display (defect 4).

### Where the current code violates it

| Rule | Violation |
|---|---|
| 1 | `interaction_episode.ts:327,556` hyphens vs `coordinate_space.ts:103` underscores; `main.ts:3003` `electron_dip`; `selection_snapshot_bridge.py:595` `electron_dip_screen` |
| 2 | `coordinate_space.ts:223`, `:235-236` pass `null` as the window for `screenToDipRect` |
| 3 | `main.ts:1143-1148` divides by scale without subtracting the window origin |
| 4 | `stage.ts:594-595` mixes physical and DIP in one subtraction |
| 5 | `gesture_capture.ts:213-217` emits a polygon; `pixel_ocr.py:194` uses a bbox |
| 6 | `gesture_capture.ts:186-188` vs `pixel_ocr.py:71-77` |
| 7 | `pixel_ocr.py:71` `tolerance=26.0`; `stage_pick_policy.ts:43,47`; `stage_stretch_policy.ts:29,33` |
| 8 | `coordinate_space.ts:151-153` returns `null`; `gesture_capture.ts:169` returns `null` |
| 9 | `coordinate_space.ts:130-131` NaN→0; `main.ts:4264-4265` physical-as-DIP; `main.ts:851,934` primary-display-only |

---

## Privacy-preserving parity constraints

Derived from `参考/Vida实机体验/07.png`, `09.png`, `11.png` and `Vida.md:295-304`. These are
constraints on the design, stated so they can be tested.

**Must have (parity with Vida's on-demand path):**

1. **Capture is a user gesture.** No capture without a hotkey, a click on an affordance, or a
   completed stroke. Nothing polls the screen.
2. **One frame per capture, no buffer.** The frame is fetched at capture time and freed after the
   read. (Reference: `external/mint/src/renderer/src/tauri.ts:1749-1751` stops the display-media
   track immediately after one frame; normcap grabs per screen per invocation —
   `external/normcap/normcap/gui/application.py:239-253`.)
3. **OCR is scoped to the marked region, not the full frame.** Recognise only the circled polygon
   plus a small margin. (Today: `app/perception/pixel_ocr.py:242-244` runs full-frame recognition
   and then filters — the docstring is explicit: *"Full-frame recognition still runs; this scopes
   what the model receives to the marked region without cropping the image."* That is a
   privacy-relevant difference: the whole screen passes through OCR.)
4. **No background indexing, no rolling memory.** The region read is not written to a store unless
   the user acts on it. (This is the explicit `不抄` in `Vida.md:295` — *"常驻心跳捕获 …
   PRODUCT.md：不做常驻录屏/Recall。纯事件驱动 + 内容指纹足够"*.)
5. **A visible consent moment.** The region the user will send is rendered before it is sent.
   (Today this does not happen even at parity: `参考/Vida实机体验/18.png` shows Vida renders nothing,
   so we would be *better* than the reference — but our own defects 12/24 mean the region we read
   may not be the region we drew, which makes the visible region load-bearing, not cosmetic.)
6. **A stated, testable exclusion list.** Password managers, banking, terminals-with-secrets are
   refused before capture. (`Vida.md:271` — *"排除列表是准入条件不是后续功能"*.)
7. **Local by default; screenshots off by default.** `Vida.md:269` and `:296` —
   `include_screenshot` default off, against Vida's default on.
8. **Never send raw pixels when structure suffices.** `Vida.md:94` — our `ARCHITECTURE.md` position
   (*"结构化能读到的就是真相，截图只是证据"*) and Vida's AX-first argument converged independently on
   the same criterion.

**Must not have (Vida's actual posture, which we reject):**

9. **No continuous background context alignment.** `参考/Vida实机体验/11.png` admits
   `让 Vida 在后台运行…让 Vida 慢慢与你的上下文对齐……` with no preview of what it collected. This is the
   privacy-invasive behaviour the user explicitly wants to avoid.
10. **No rolling capture buffer.** `Vida.md:63-73` — OpenChronicle's pipeline is
    `mac-ax-watcher → capture-buffer/{iso8601}.json → Timeline → Session → reducer`, with *"默认配置
    一个工作日几百次捕获"* (`Vida.md:76`). Rejected.
11. **No claim of "local-first" that covers memory but not context.** `Vida.md:304` documents that
    Vida's `本地优先` refers to the memory files, while policy 2.2 sends desktop context to
    third-party model vendors. Our copy must describe the context path, not just the storage path.
12. **No silent background indexing of anything.** Mint is the cautionary example: it persists raw
    screenshots to disk on every send (`external/mint/src/renderer/src/tauri.ts:370-376`, `:464-470`
    → `external/mint/crates/mint-core/src/media/pictures.rs:198-202`) and writes a
    `behavior_memory.json` with the last 20 free-text screen contexts
    (`external/mint/src-tauri/src/proactive.rs:214-237`).

**Testable acceptance items:**

- With the app idle for 10 minutes and no gesture, no screen read is issued (log-asserted).
- A capture on a password-manager window is refused with a reason, and no frame is fetched.
- The OCR pass receives only the region crop; the full frame is never passed to the recogniser.
- The polygon sent to the model is byte-identical to the polygon drawn on screen.

---

## Port list

Ordered by (user-visible reliability gained) ÷ (risk). Items 1-6 are the circle-and-point fix;
7-12 are parity and robustness; 13-16 are correctness infrastructure.

1. **Unify the coordinate-space discriminant into one exported constant** — replace the four
   literals at `interaction_episode.ts:327,556`, `main.ts:3003`, `coordinate_space.ts:103,127,160`
   and `selection_snapshot_bridge.py:595` with a single shared enum, and reject unknown values at
   the boundary with a typed error. *(Fixes defect 1.)*
2. **Make the region a polygon end-to-end.** Carry `geometry` from
   `gesture_capture.ts:213-217` through to `app/perception/pixel_ocr.py`, and replace the
   `stroke_xywh` bbox scoping at `:194` with a polygon cover test. *(Defects 12, 5. This is the
   highest-yield single change for "圈点老是出问题".)*
3. **Collapse the two stroke classifiers into one.** Decide `circle|line|freeform|point` in
   `gesture_capture.ts` and ship the verdict with the region; make `pixel_ocr.py:71` consume it
   instead of re-deriving from a physical-pixel tolerance. *(Defects 11, 9.)*
4. **Fix the stage origin space.** Store `stageOrigin` in one space —
   `electron/renderer/stage.ts:594-595` — and route all three consumers (`:263-265`, `:297-298`,
   `captureProof`) through one function. The duplicate-transform note at `:259-262` already
   anticipates this. *(Defect 2; resolves `docs/STATUS.md:233`.)*
5. **Report dropped gestures instead of returning `null`.** Give `summarizeGesture`
   (`gesture_capture.ts:289-293`) and `physicalGestureTrace` (`coordinate_space.ts:153`) typed
   reason codes, and surface one sentence in the stage. *(Defects 19, 21, 20.)*
6. **Make the quick-point window duration-only and give point gestures a real region.** Drop the
   `pathLength <= 14` conjunction at `gesture_capture.ts:147-148` so a held point is not lost, and
   give `point` a region derived from the resolved element instead of the 16×16 DIP box at
   `coordinate_space.ts:330-331`. *(Defects 19, 13, 14.)*
7. **Fix the session's request lifecycle so a second stroke does not kill the first.**
   `selection_session.ts:255-263` must reject or queue a `startRequest` while
   `state === 'running'`, and `attachSnapshot` (`:191`) must not overwrite `'running'`.
   *(Defects 28, 29.)*
8. **Thread the display through every DIP conversion.** Change
   `coordinate_space.ts:223,235-236` to pass a real window, and delete the physical-as-DIP fallback
   at `main.ts:4264-4265` in favour of an explicit failure. *(Defects 4, 3.)*
9. **Size the overlay and stage to the union of all displays** (or one window per display, which is
   the pattern `CLICKY.md:177` already selects). `electron/main.ts:851,934`. *(Defect 7.)*
10. **Add the missing retry gate for non-Chromium web hosts.** Use `is_cold_tree`'s host table at
    `uia_text_adapter.py:610` instead of `_is_chromium_window`, and pass a real class chain at
    `:627`. *(Defects 34, 36.)*
11. **Make coverage dominate the fusion ranking.** `app/perception/fusion.py:107` must score
    `covers_mark is True` strictly better than `None`, and `pixel_tier_warranted` (`:141-145`) must
    consider the selected observation rather than `any`. *(Defects 17, 18.)*
12. **Rank target rects by area or depth with the pointer inside, not by array order.**
    `coordinate_space.ts:332-336` and `stage_pick_policy.ts:109` must agree on one rule —
    smallest-containing — so hover and capture name the same element. *(Defects 15, 16; this is the
    `UIA 返回容器名` fix.)*
13. **Label every threshold constant with its space and derive the DPI-dependent ones from the
    scale factor.** `pixel_ocr.py:71,238`; `stage_pick_policy.ts:43,47`;
    `stage_stretch_policy.ts:29,33`. *(Defects 9, 10.)*
14. **Make the stroke budget uniform and shape-preserving.** Reconcile
    `coordinate_space.ts:109,142` (`slice(0,8)`) with `sweep_visual.ts:403` (`slice(-8)`) to one
    limit, and resample rather than truncate so `bbox`/`closure` do not change
    (`gesture_capture.ts:255`). *(Defects 23, 24.)*
15. **Add a pointerup watchdog and a drag-origin check** to `stage_hit_policy.ts:54`, so a lost
    pointerup cannot wedge the overlay. *(Defect 25.)*
16. **Let the resolver claim `exact` for hashless anchors** when the structure tier finds exactly
    one candidate, or record the hash at capture time — `app/anchor/resolver.py:139-149`. *(Defect 27.)*

Bonus (cheap, from the reference implementations, not defects): normcap's measured-scale pattern —
`external/normcap/normcap/gui/window.py:192-196`, derive the crop scale from
`screenshot.width() / window.width()` rather than trusting a scale-factor API — is the most
robust idea in any of the three projects and is worth adopting wherever a screenshot and a window
must agree.

---

## Open questions / not established

- **Vida's ink affordance.** 15 of the 19 reference PNGs are installer/auth/onboarding/settings.
  Only `18.png` and `19.png` are real in-flow usage, and both are the *result*, not the gesture.
  No image shows a capture in progress. The MP4s are single-monitor 1920×1080 and are marketing
  demos; I extracted contact sheets and sampled frames from `PromptRescue` and `WorkspaceCleanup`,
  and the capture affordance is not shown at usable resolution in either.
  **If the ink-stroke visual must be replicated, we do not have Vida's reference for it.**
- **Vida multi-monitor / mixed DPI:** no evidence exists in any artefact. The `参考/Vida` videos are
  all 1920×1080 single-monitor; no screenshot shows a second display or a scaling setting.
  Everything in the coordinate contract above is derived from selection-hook and normcap, not Vida.
- **`physicalGestureBoundingBox` minimum-thickness intent.** `main.ts:3755` passes
  `8 * scaleFactor` while `coordinate_space.ts:163` passes nothing. I can prove they disagree; I
  cannot tell which was intended.
- **The frozen-frame pixel space.** `pixel_ocr.py:529-546` converts the mark bbox from
  screen-global to artifact-local by subtracting `_artifact_offset` with no scale factor
  (comment at `:583`: *"OCR rectangles are artifact-local, a mark bbox is screen-global"*). That is
  correct **iff** the frozen artifact's pixels are 1:1 with physical screen pixels. I did not read
  the capture path that produces the artifact, so I cannot confirm that invariant — it is worth
  checking before relying on it.
- **`screen.screenToDipRect` behaviour with a `null` window.** Defect 4 is written from the
  signature at `coordinate_space.ts:18` (`screenToDipRect?(window: null, rect: Rect)`) and the call
  site. I did not read Electron's implementation, so the precise fallback scale factor it uses is
  inferred, not read. The defect (no display context is passed) holds either way.
