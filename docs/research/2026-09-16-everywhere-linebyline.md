# Everywhere, read line by line — what makes it feel fast

Source: `D:\Desktop\Magic Pointer\external\everywhere` @ `f2bb21f` (2026-08-03 checkout).
Stack: **.NET 8 / Avalonia 11 / C#**, not Electron. Single process. Windows interop via `CsWin32` + `Vortice` + `WinRT`.
All citations are relative to `external/everywhere/`.

---

## Architecture map

```
src/
  Everywhere.Abstractions/          contracts only. Rpc/ contains ONLY Watchdog.cs — there is no UI RPC layer.
  Everywhere.Core/                  the whole app: UI, chat model, AI, config, plugins.
    Common/ThreadSafeObservableStringBuilder.cs   ★ streaming text buffer (worker → UI bridge)
    Chat/ChatService.cs                           ★ model streaming loop; appends deltas at :710 / :715
    Chat/Messages/AssistantChatMessageSpan.cs     ★ span owns the string builder; UI binds to the builder
    Views/Chat/ChatWindow.axaml(.cs)              ★ the answer panel = the floating bar. Pre-created, cloaked.
    Views/Chat/ChatPresentation.cs                ★★ incremental row projection + refresh coalescer
    Views/Chat/ChatPresentationRows.cs            stable row objects (identity preserved across updates)
    Views/Chat/ChatPresentationRowPresenter.axaml row templates; MarkdownRenderer bound at :588
    Views/Chat/ChatMessageItemsControl.axaml      VariableHeightVirtualizingStackPanel, CacheLength=1
    Views/Windows/VisualElementOverlayWindow.cs   ★ hit-test-invisible topmost overlay base class
    Views/ScreenSelection/ScreenSelectionWindow.cs ★ mask window: 2 Borders, geometry-excluded hole
    Views/Effects/VisualElementEffect.cs          ★★ particle/scan orchestrator; batched capture loop
    Views/Effects/VisualElementParticleHost.cs    rAF-driven animation host w/ object pool
    Views/Controls/GlowBorder.axaml.cs            rAF + custom Skia draw op (zero per-frame layout)
    Views/Controls/VariableHeightVirtualizingStackPanel.cs  custom virtualizer for unknown heights
    Initialization/ChatWindowInitializer.cs       ★ preloads ChatWindow at startup
  Everywhere.Windows/
    Interop/WindowHelper.cs                       ★★ WS_EX_NOACTIVATE/TOOLWINDOW/LAYERED/TRANSPARENT, DWM cloaking
    Interop/ShortcutListener.cs                   ★ RegisterHotKey primary, LL hook fallback
    Interop/LowLevelHook.cs                       hook thread: STA, Priority=Highest, never does work
    Interop/MessageWindow.cs                      dedicated STA message-only HWND thread
    Interop/ScreenSelectionSession.cs             ★ picker session: layered + UIA_WindowVisibilityOverridden
    Interop/VisualElementContext.Screenshot.cs    ★ freeze-screen capture; cloaks tooltip before capture
    Interop/Direct3D11ScreenCapture.cs            ★ single-frame DWM-thumbnail capture, then stop
    Interop/AutomtionVisualElementImpl.cs         per-element capture entry (:534)
docs/ScreenPicker/01..04-*.md                     ★ the overlay occlusion war story; read 04 in full
docs/References/AvaloniaViewPresentation.md       their own UI perf rules (stable identity, transforms not layout)
```

---

## Six mechanisms that make it feel fast

### 1. Overlay rendering cost model — many tiny native windows, geometry not layout

There is no single fullscreen Electron-style surface. Every visual layer is its **own Win32 window** with a
hand-set extended style, and each is made inert to input at the OS level rather than in app code.

Base overlay class (`src/Everywhere.Core/Views/Windows/VisualElementOverlayWindow.cs:13-28`):

```csharp
CanResize = false;
ShowInTaskbar = false;
ShowActivated = false;
WindowDecorations = WindowDecorations.None;
TransparencyLevelHint = [WindowTransparencyLevel.Transparent];
IsHitTestVisible = false;
Background = null;
Focusable = false;
Topmost = true;
var windowHelper = ServiceLocator.Resolve<IWindowHelper>();
windowHelper.SetFocusable(this, false);
windowHelper.SetHitTestVisible(this, false);
```

`SetFocusable(false)` is not an Avalonia property — it is a Win32 style mutation plus a WndProc hook that
swallows every activation message (`src/Everywhere.Windows/Interop/WindowHelper.cs:44-69`):

```csharp
return (style, exStyle | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW);
...
case WM_MOUSEACTIVATE: handled = true; return 3; // MA_NOACTIVATE
case WM_ACTIVATE: case WM_SETFOCUS: case WM_KILLFOCUS:
case WM_ACTIVATEAPP: case WM_NCACTIVATE: handled = true; return IntPtr.Zero;
```

**What is re-rendered per frame: nothing.** The selection mask only changes *geometry* when the hovered
element changes, and it changes it as a `CombinedGeometry` clip + a Border margin, never by rebuilding the
tree (`src/Everywhere.Core/Views/ScreenSelection/ScreenSelectionWindow.cs:99-112`):

```csharp
_maskBorder.Clip = new CombinedGeometry(GeometryCombineMode.Exclude, new RectangleGeometry(Bounds), new RectangleGeometry(maskRect));
_elementBoundsBorder.Margin = new Thickness(maskRect.X, maskRect.Y, 0, 0);
_elementBoundsBorder.Width = maskRect.Width;
_elementBoundsBorder.Height = maskRect.Height;
```

The frozen screenshot is applied as a `Background` **ImageBrush**, not an `Image` control — explicit
comment at `ScreenSelectionWindow.cs:93-96`: *"We use an ImageBrush here instead of an Image control to
avoid issues with scaling and rearrangement."* Background brushes do not participate in measure/arrange.

The overlay window itself is only mutated and `Show()`n **when the target element identity actually
changes** (`VisualElementOverlayWindow.cs:47`, `:103-109`).

### 2. Streaming UX — one dispatcher hop per delta, coalesced at the projection layer

`ChatService` receives provider deltas and pushes each one into a span-owned string builder
(`src/Everywhere.Core/Chat/ChatService.cs:708-716`):

```csharp
void HandleTextMessage(string text) { EnsureSpan<AssistantChatMessageTextSpan>(false).ContentMarkdownBuilder.Append(text); }
void HandleReasoningMessage(string text) { EnsureSpan<AssistantChatMessageReasoningSpan>(false).ReasoningMarkdownBuilder.Append(text); }
```

The builder is the batching boundary (`src/Everywhere.Core/Common/ThreadSafeObservableStringBuilder.cs:24-35`):

```csharp
using (_lock.EnterScope()) { _source.Append(value); }   // thread-safe truth for readers
Dispatcher.UIThread.PostOnDemand(() => base.Append(value), DispatcherPriority.Normal);
```

Two things matter here. First, `PostOnDemand` **executes inline when already on the UI thread**, so the
common case costs zero queueing. Second, the UI does not bind to a *string*; it binds to the *builder*
(`src/Everywhere.Core/Views/Chat/ChatPresentationRowPresenter.axaml:587-591`):

```xml
<md:MarkdownRenderer MarkdownBuilder="{Binding ContentMarkdownBuilder}"/>
```

so a delta never reassigns a property, never re-creates a control, and never re-templates. The row object
is stable for the life of the span (`Views/Chat/ChatPresentation.cs:788-789`).

Coalescing happens one level up, in `ChatPresentation`. Property notifications from the (worker-thread)
model cross the dispatcher, then get **drained in a loop within a single dispatcher pass**
(`Views/Chat/ChatPresentation.cs:480-505`):

```csharp
private void HandlePropertyChanged(object? s, PropertyChangedEventArgs e) =>
    Dispatcher.UIThread.PostOnDemand(() => RequestRefresh());
private void RequestRefresh(bool rewire = false)
{
    _refreshRequested = true; _rewireRequested |= rewire;
    if (_refreshPosted) return;
    _refreshPosted = true;
    if (!_isApplyingRefresh) { DrainRefresh(); } else Dispatcher.UIThread.Post(DrainRefresh);
}
```

Branch-shape changes get a second, coarser coalescer (`ChatPresentation.cs:64-76`):

```csharp
if (Interlocked.Exchange(ref _isRepartitionScheduled, 1) != 0) return;
Dispatcher.UIThread.PostOnDemand(() => { Interlocked.Exchange(ref _isRepartitionScheduled, 0); Repartition(); });
```

Latency instrumentation is built in, not guessed (`ChatService.cs:640-648`): time-to-first-token is
recorded per model as `gen_ai.request.ttft` and a named histogram. First-token-to-pixels is therefore
*one dispatcher pass* after the first delta arrives.

Finally, the completion animation is not allowed to fight the layout pass
(`ChatPresentation.cs:802-821`): a completed activity group is held in place with
`DispatcherTimer.RunOnce(..., 400ms)` — *"Leaves a just-completed running Group in place long enough for
the 320 ms glow transition"* — before the row set is rebuilt.

> **Note on Magic Pointer's current state** (verified, not assumed): MP already streams deltas end to end
> at the transport level — `scripts/bridge_progress.py:130` throttles at 120ms with a first-flush-immediate
> rule, and `scripts/conversation_bridge.py:234` handles `model_chunk`. What is missing is only the last
> hop: the live chunks reach the conversation store and the dashboard/companion windows, never the stage
> window. See port items 1–3.

### 3. Hot-path IPC discipline — there is no IPC on the hot path

The UI and the model run in **one process**. The only IPC in the entire product is a named pipe used to
hand a second launch off to the first instance (`src/Everywhere.Core/Common/Entrance.cs:61`, `:83`, `:157`).
`Everywhere.Abstractions/Rpc/` contains a single file, `Watchdog.cs`.

So "IPC hops per user action" is **zero**. What replaces it is a strict thread-boundary rule, stated in
`docs/References/AvaloniaViewPresentation.md`: *"Marshal genuine background ingress to the UI thread at the
boundary. Once inside that boundary, keep the object model single-threaded and simple. Do not add locks,
concurrent collections, immutable snapshots, pending-operation queues, or defensive reentrancy state to code
whose callbacks and timers are all guaranteed to execute on the UI thread."*

The two places that must cross use `PostOnDemand` (inline on UI thread) plus a single int flag — never a
lock, never a channel, never `Invoke` (`ChatPresentation.cs:70`, `:96`, `:485`;
`ThreadSafeObservableStringBuilder.cs:33`).

Nothing blocking is awaited from a render path. The overlay deliberately pushes a potentially-hanging UIA
property read **off the UI thread with a timeout** (`VisualElementOverlayWindow.cs:61`):

```csharp
boundingRectangle = await Task.Run(() => element.BoundingRectangle).WaitAsync(TimeSpan.FromSeconds(1));
```

And the picker defers its own start by an explicit dispatcher yield rather than sleeping
(`src/Everywhere.Windows/Interop/VisualElementContext.Screenshot.cs:19-20`):

```csharp
// Give time to hide other windows
await Dispatcher.UIThread.InvokeAsync(() => { }, DispatcherPriority.Background);
```

### 4. Window show/hide — never destroy, never re-create; cloak instead of hide

The chat window is **pre-created during startup and immediately cloaked**
(`src/Everywhere.Core/Initialization/ChatWindowInitializer.cs:37-42`):

```csharp
var chatWindow = serviceProvider.GetRequiredService<ChatWindow>();
var chatWindowHandle = chatWindow.TryGetPlatformHandle()?.Handle ?? 0;
// Preload ChatWindow to avoid delay on first open
chatWindow.Initialize();
```

`Initialize()` warms the whole pipeline — `EnsureInitialized(); ApplyStyling(); ApplyTemplate();` — and then
cloaks (`src/Everywhere.Core/Views/Chat/ChatWindow.axaml.cs:101-113`). Every subsequent "close" is a cloak,
never a destroy (`ChatWindow.axaml.cs:351-361`):

```csharp
// do not allow closing, just hide the window
e.Cancel = true;
SetCloaked(true);
```

Losing focus cloaks too (`ChatWindow.axaml.cs:235-243`), as does Escape (`:127`).

Cloaking is DWM-level, and the uncloak path is written to *suppress OS animations*
(`src/Everywhere.Windows/Interop/WindowHelper.cs:139-173`):

```csharp
if (cloaked) { window.Hide(); Cloak(hWnd); }
else {
    if (PInvoke.IsIconic(hWnd)) { Cloak(hWnd); PInvoke.ShowWindow(hWnd, SHOW_WINDOW_CMD.SW_RESTORE); }
    // Once we're done, uncloak to avoid all animations
    Uncloak(hWnd);
    window.Show();
    window.Activate();
}
```

`Cloak()` also buries the window at `HWND_BOTTOM` so accessibility tools cannot see it
(`WindowHelper.cs:215-220`). `GetEffectiveVisible` checks `DWMWA_CLOAKED`, because *"a cloaked window is
still technically visible"* (`WindowHelper.cs:117-137`).

Show path uses `showInactive` semantics — `ShowActivated = false` + `WS_EX_NOACTIVATE` +
`WM_MOUSEACTIVATE → MA_NOACTIVATE` — so revealing the panel never steals focus from the user's app.

Hotkeys prefer the OS-level registration and only fall back to a hook
(`src/Everywhere.Windows/Interop/ShortcutListener.cs:100-122`):

```csharp
if (!PInvoke.RegisterHotKey(HWnd, id, modifiers, (uint)shortcut.Key.ToVirtualKey())) { ... id = 0; }
...
else { _keyboardHookSubscription ??= LowLevelHook.CreateKeyboardHook(KeyboardHookProc); }
```

`WM_HOTKEY` is delivered to a **dedicated STA message-only window thread** (`MessageWindow.cs:26-36`), and
the handler is dispatched to the thread pool so no work happens in the message loop
(`ShortcutListener.cs:62`): `ThreadPool.QueueUserWorkItem(_ => registration.SafeExecute());`

Same discipline for the fallback hook — its own thread, `Priority = ThreadPriority.Highest`, STA, and the
callback contract explicitly forbids work (`LowLevelHook.cs:49-59`, `:107-109`).

`backgroundThrottling` has no Avalonia equivalent; instead the panel avoids becoming a fullscreen occluder
at all (see §5) and uses a real blurred composition path: `TransparencyLevelHint="AcrylicBlur,Blur,None"`
(`ChatWindow.axaml:15`) with `SizeToContent="WidthAndHeight"` so the window is only as big as its content.

### 5. Screen capture — single-frame, deduped by window, frozen, and self-excluded

Capture is **strictly on demand**, never continuous. The DWM-thumbnail path takes exactly one frame and
stops (`src/Everywhere.Windows/Interop/Direct3D11ScreenCapture.cs:138-146`, `:158-227`):

```csharp
_framePool = Direct3D11FramePool.CreateFreeThreaded(..., 2 /* buffer of 2 to avoid capture lag */, ...);
_session.IsCursorCaptureEnabled = false;
_framePool.FrameArrived += (f, _) => {
    if (_disposed || Interlocked.Exchange(ref _frameReceived, 1) != 0) return;  // take one frame only
```

The capture host is an intentionally invisible, non-activating, cloaked popup
(`Direct3D11ScreenCapture.cs:351-375`) with `WM_NCHITTEST → -1` (`HTTRANSPARENT`, `:384-386`).

The expensive-N-captures problem is solved by **deduping per top-level window and sub-cropping**
(`src/Everywhere.Core/Views/Effects/VisualElementEffect.cs:156-157`, `:195-218`):

```csharp
private readonly HashSet<nint> _emittedWindowHandles = [];
private readonly Channel<IVisualElement> _emissionQueue = Channel.CreateBounded<IVisualElement>(...);
...
var windowHandle = topLevel.NativeWindowHandle;
if (windowHandle == 0) continue;
if (!_emittedWindowHandles.Add(windowHandle)) continue; // Already emitted
using var pointer = await topLevel.CaptureAsync(cancellationToken);
```

Capture runs on a producer/consumer loop off the UI thread (`:169`, `:181-218`) and only the cheap visual
mutation is posted back, at `DispatcherPriority.Render`.

For the screenshot picker, the screen is **frozen first**: each monitor is captured into the mask window's
background before the user starts selecting (`src/Everywhere.Windows/Interop/VisualElementContext.Screenshot.cs:43-76`),
so dragging a selection box never re-reads the screen.

Self-exclusion is done four independent ways, which is why it survives every app class:
1. `UIA_WindowVisibilityOverridden = 2` on each overlay HWND — UIA's own traversal skips it
   (`ScreenSelectionSession.cs:82-85`).
2. `WS_EX_LAYERED` + `SetLayeredWindowAttributes(..., alpha 254, LWA_ALPHA)` so DWM does not classify the
   overlay as a full opaque occluder (`ScreenSelectionSession.cs:78-80`).
3. `FindWindowBehindOwnOverlays` enumerates windows and skips its own HWNDs, cloaked windows,
   `WS_EX_NOACTIVATE` windows, and iconic windows (`ScreenSelectionSession.cs:237-267`).
4. `NoneAutomationPeer` on the chat window — *"Disable automation peer to avoid being detected by self"*
   (`ChatWindow.axaml.cs:245-248`), plus `if (chatWindowHandle == hWnd) element = null`
   (`ChatWindowInitializer.cs:128`).

### 6. Animation — requestAnimationFrame + custom draw, zero per-frame layout

Two animation systems, both rAF-driven by the compositor, both **self-terminating**.

Particle host (`src/Everywhere.Core/Views/Effects/VisualElementParticleHost.cs:74-83`, `:120-129`):

```csharp
private void StartAnimationLoop()
{
    if (_isAnimating) return;
    _isAnimating = true;
    _lastFrameTime = TimeSpan.Zero;
    owner.RequestAnimationFrame(OnAnimationFrame);
}
...
if (_activeParticles.Count > 0) { owner.RequestAnimationFrame(OnAnimationFrame); }
else { _isAnimating = false; owner.HandleHostIdle(); }
```

`HandleHostIdle` then **hides the whole overlay window** when nothing is animating
(`src/Everywhere.Core/Views/Effects/VisualElementEffectWindow.cs:59-62`). Particles are pooled and the
pooled controls stay in the visual tree but `IsVisible = false` (`VisualElementParticleHost.cs:34-38`).

GlowBorder animates by invalidating a **custom Skia draw operation**, not by moving controls
(`src/Everywhere.Core/Views/Controls/GlowBorder.axaml.cs:132-159`):

```csharp
private void StartAnimation()
{
    if (_animationStarted || _topLevel is null || !IsVisible || GlowOpacity <= 0.001 || AnimationRate <= 0.001) return;
    _animationStarted = true; _lastFrameTime = null;
    _topLevel.RequestAnimationFrame(OnAnimationFrame);
}
...
_lastFrameTime = time;
InvalidateVisual();
_topLevel.RequestAnimationFrame(OnAnimationFrame);
```

Note the guard on every rAF tick: invisible or detach → stop. `OnDetachedFromVisualTree` clears
`_topLevel` and `_animationStarted` (`GlowBorder.axaml.cs:112-117`), so an offscreen control cannot keep
the render loop alive. This is the mechanism that keeps the *idle* app at ~0% GPU.

---

## Anti-patterns it avoids

| Anti-pattern | What Everywhere does instead | Citation |
|---|---|---|
| Recreating UI on hide/show | Pre-create at startup, `DWM cloak` on close/lost-focus | `ChatWindowInitializer.cs:37-42`, `ChatWindow.axaml.cs:351-361` |
| `Show()`/`Activate()` stealing focus | `WS_EX_NOACTIVATE` + `ShowActivated=false` + `WM_MOUSEACTIVATE→3` | `WindowHelper.cs:44-69` |
| Global LL keyboard hook for hotkeys | `RegisterHotKey` primary; hook only on failure | `ShortcutListener.cs:100-122` |
| Doing work inside a hook callback | Hook thread only signals; work goes to `ThreadPool` | `LowLevelHook.cs:107-109`, `ShortcutListener.cs:62` |
| Sync marshal to UI thread from worker | `PostOnDemand` (inline on UI thread) + one `int` flag | `ChatPresentation.cs:70`, `:485` |
| Reassigning a bound string per token | Bind to a mutable `ObservableStringBuilder` | `ChatPresentationRowPresenter.axaml:588` |
| Rebuilding rows on every update | Stable row objects + `ReconcileByReference` prefix/suffix diff | `ChatPresentation.cs:213-235`, `:773-800` |
| Re-templating the row list per turn | `DynamicSegmentedList` — per-turn local insert → global index | `ChatPresentation.cs:53-57` |
| Blocking a render path on a cross-process UIA read | `Task.Run(...).WaitAsync(1s)` for `BoundingRectangle` | `VisualElementOverlayWindow.cs:61` |
| N screenshots for N elements | Dedupe by top-level HWND, sub-crop the one image | `VisualElementEffect.cs:197` |
| Continuous screen capture | One frame per request; `Interlocked` guard takes exactly one | `Direct3D11ScreenCapture.cs:166-168` |
| Animating layout properties | rAF + custom Skia draw op / `RenderTransform` | `GlowBorder.axaml.cs:141-159`; `AvaloniaViewPresentation.md` |
| Letting idle windows keep animating | Every rAF tick re-checks `IsVisible`; window hides on idle | `VisualElementParticleHost.cs:126-129`, `VisualElementEffectWindow.cs:59-62` |
| Letting an overlay occlude the app underneath | `UIA_WindowVisibilityOverridden=2` + `WS_EX_LAYERED` alpha 254 | `ScreenSelectionSession.cs:78-85` |
| Repeating pin-mode logic on every reveal | `if (!IsVisible)` guard so it only runs when truly hidden | `ChatWindow.axaml.cs:288-292` |

---

## Port list for Magic Pointer

Ordered by expected latency/feel payoff.

> **Correction to an earlier draft of this list.** Magic Pointer's streaming transport is already live and
> is in places better designed than assumed: `scripts/bridge_progress.py:130` `StreamChunkBuffer` throttles
> at `STREAM_FLUSH_INTERVAL_S = 0.12` (`:127`) and sets `self._last_flush = 0.0` (`:163-165`) so **the first
> delta always flushes immediately** — the same decision Everywhere makes by measuring TTFT at the first
> streamed item (`ChatService.cs:640-648`). `scripts/conversation_bridge.py:234` handles `model_chunk`,
> `scripts/selection_bridge.py:2918` consumes the shared buffer, and
> `electron/bridge_progress_lines.ts:33-50` parses `@@mp` progress rows incrementally with partial-line
> tolerance. Items 1–3 below are narrowed to what is *actually* still missing.

1. **In Magic Pointer, route `answer_chunk` to the stage window.** This is the real gap, and it is narrow.
   `electron/main.ts:5845-5846` receives the phase and calls `appendStageLiveAnswer`
   (`:1339`), but that function only writes the conversation store and calls `notifyConversationChanged`
   (`:1299-1305`), which sends to `dashboardWindow` and `companionWindow` — **never to `stageWindow`**. The
   only `stageWindow.webContents.send` calls in the file are `stage:hide` (`:3076`) and `stage:pointer-input`
   (`:3929`). So the Studio and companion surfaces stream and the on-screen stage does not: it paints the
   whole answer at turn end. Everywhere paints on the surface the user is actually looking at
   (`ChatService.cs:710` → `ThreadSafeObservableStringBuilder` → the bound markdown renderer).
   TARGET: `electron/main.ts` — search for `appendStageLiveAnswer`.

2. **In Magic Pointer, delete the second throttle.** Python coalesces at 120ms
   (`scripts/bridge_progress.py:127`) and `appendStageLiveAnswer` then coalesces *again* behind its own
   `setTimeout(..., 300)` (`electron/main.ts:1348-1358`). The outer 300ms window dominates and is the number
   the user feels. Everywhere has exactly one coalescer, at one layer (`ChatPresentation.cs:488-505`).
   TARGET: `electron/main.ts:1339-1361`.

3. **In Magic Pointer, make the stage renderer append into a mutable answer buffer instead of re-rendering
   from a full string.** Even once item 1 is wired, `stage.ts:2375` (`api.onUpdate`) replaces whole payloads.
   Everywhere binds the markdown renderer to a mutable `ObservableStringBuilder`
   (`ChatPresentationRowPresenter.axaml:588`) so a delta never reassigns a property or re-templates the row.
   TARGET: `electron/renderer/stage.ts` — search for `api.onUpdate`.

4. **In Magic Pointer, make the stage/overlay window pre-created and DWM-cloaked instead of destroyed and
   re-created per gesture.** `electron/main.ts:894-905` (`ensureFreshGestureOverlay`) explicitly destroys
   and recreates the overlay for every gesture. Everywhere pre-creates once
   (`ChatWindowInitializer.cs:37-42`) and cloaks/uncloaks thereafter (`WindowHelper.cs:139-173`).
   TARGET: `electron/main.ts` — search for `ensureFreshGestureOverlay`.

5. **In Magic Pointer, keep the answer panel resident and stop it being recreated.** Mirror the cloak
   lifecycle: `OnClosing → e.Cancel = true; SetCloaked(true)` so the window is never destroyed
   (`ChatWindow.axaml.cs:351-361`). Cloaking also buys "no OS show animation" on reveal
   (`WindowHelper.cs:166-167`).
   TARGET: `electron/main.ts` — search for `stageWindow` / `overlayWindow`.

6. **In Magic Pointer, bind the renderer to a mutable answer buffer instead of re-sending the whole answer
   string.** Everywhere binds `<md:MarkdownRenderer MarkdownBuilder="{Binding ContentMarkdownBuilder}"/>`
   (`ChatPresentationRowPresenter.axaml:588`). Today `electron/main.ts:1066-1095` builds a payload carrying
   the full `result.answer` string on every update. Send `{seq, delta}` and append renderer-side.
   TARGET: `electron/main.ts` — search for `StageUpdatePayload`.

7. **In Magic Pointer, replace the full-payload `stage:update` send with a stable row identity model.**
   `electron/main.ts:1095` calls `safeSurfaceSend('stage','stage:update', payload)` per event with no
   coalescing. Everywhere keeps row objects stable and diffs by reference
   (`ChatPresentation.cs:213-235`, `:773-800`) so unaffected rows are never re-created.
   TARGET: `electron/renderer/stage.ts` — search for `stage:update`.

8. **In Magic Pointer, add an explicit refresh coalescer to the stage renderer.** One boolean + one
   scheduled flag, drained in a single pass — no locks, no queues
   (`ChatPresentation.cs:488-505`).
   TARGET FILE: TBD — search for `card-patch` handling in `electron/renderer/stage.ts`.

9. **In Magic Pointer, dedupe screenshots by top-level window handle and sub-crop.**
   Everywhere captures each top-level HWND once (`_emittedWindowHandles`, `VisualElementEffect.cs:156`,
   `:197`) then crops per element. Magic Pointer's perception pass re-captures per element.
   TARGET FILE: TBD — search for `frame_capture_worker_client` / `selection_worker_client`.

10. **In Magic Pointer, capture exactly one frame per screenshot request and stop the capture session.**
    Everywhere uses `Interlocked.Exchange(ref _frameReceived, 1)` to guarantee one frame
    (`Direct3D11ScreenCapture.cs:166-168`) and disposes the pool on `Dispose()` (`:249-256`).
    TARGET FILE: TBD — search for the capture worker used by `electron/frame_capture_worker_client.ts`.

11. **In Magic Pointer, freeze the screen into the mask background before the user selects.**
    `VisualElementContext.Screenshot.cs:43-76` captures each monitor into the mask window's background so
    nothing moves under the selection. Use an `ImageBrush`-equivalent background, not an `<img>` element,
    to avoid reflow (`ScreenSelectionWindow.cs:92-97`).
    TARGET FILE: TBD — search for the stage/overlay mask in `electron/renderer/stage.ts`.

12. **In Magic Pointer, mark the stage and overlay windows `UIA_WindowVisibilityOverridden = 2`.**
    Everywhere's own docs call this the final fix: it makes UIA's global `ElementFromPoint` ignore the
    overlay entirely, with no rendering side effect (`ScreenSelectionSession.cs:82-85`,
    `docs/ScreenPicker/04-The-Overlay-Occlusion-Problem.md`). This directly addresses the recorded
    "四个普通窗口全部超时失败" UIA probe failure.
    TARGET FILE: TBD — search for `SetWindowLongPtr` / native window setup for `stageWindow`.

13. **In Magic Pointer, add `WS_EX_LAYERED` with alpha 254 to the fullscreen stage window.**
    A fully opaque fullscreen window triggers Chromium/Electron **renderer hibernation**, which
    reparents the UIA provider away from the queried subtree and makes deep element picking silently
    return root-only (`docs/ScreenPicker/04`, `ScreenSelectionSession.cs:78-80`).
    TARGET: `electron/main.ts` — search for `createStageWindow`.

14. **In Magic Pointer, add `backgroundThrottling: false` to the stage window and remove the
    destroy/recreate workaround it is compensating for.** The overlay already sets it
    (`electron/main.ts:872`), but `ensureFreshGestureOverlay` (`:894-905`) exists because the window is
    being reused after hide/show — cloaking removes the need.
    TARGET: `electron/main.ts` — search for `ensureFreshGestureOverlay`.

15. **In Magic Pointer, prefer `RegisterHotKey` over global LL hooks for triggers.**
    Everywhere registers with the OS and only falls back to a hook when registration fails
    (`ShortcutListener.cs:100-122`); hook callbacks never do work and run on a dedicated STA thread at
    `Priority.Highest` (`LowLevelHook.cs:49-59`). This removes the hook from the input latency path
    entirely.
    TARGET FILE: TBD — search for how `overlay:gesture-start` / `wiggle_detector` triggers are armed.

16. **In Magic Pointer, never let a cross-process UIA property read block a render path.**
    Everywhere wraps `BoundingRectangle` in `Task.Run(...).WaitAsync(TimeSpan.FromSeconds(1))`
    (`VisualElementOverlayWindow.cs:61`). Magic Pointer's UIA probe has a 200ms hard timeout that four
    ordinary windows hit (see memory: `uia-probe-cold-start-cost`).
    TARGET FILE: TBD — search for the UIA probe in `app/desktop_actions/` / `native/`.

17. **In Magic Pointer, move every animation to `requestAnimationFrame` with a per-tick visibility guard.**
    Everywhere re-checks `IsVisible`/attachment on every frame and stops (`GlowBorder.axaml.cs:141-149`),
    and hides the host window when idle (`VisualElementEffectWindow.cs:59-62`). This is what keeps an idle
    desktop agent at ~0% GPU.
    TARGET FILE: TBD — search for CSS animations/transitions in `electron/renderer/*.css`.

18. **In Magic Pointer, express animated chrome (the stage glow) as one canvas/custom draw rather than
    DOM mutation.** Everywhere draws its glow with a single Skia shader op (`GlowBorder.axaml.cs:120-130`)
    instead of animating box-shadow/filters. TARGET FILE: TBD — stage glow in `electron/renderer/stage.css`.

19. **In Magic Pointer, keep the transcript list virtualized with a fixed cache length.**
    Everywhere sets `CacheLength="1" EstimatedItemHeight="140"` on a custom
    variable-height virtualizer (`ChatMessageItemsControl.axaml:12-17`,
    `Views/Controls/VariableHeightVirtualizingStackPanel.cs:14-24`). If the studio transcript renders all
    rows, this is a direct win.
    TARGET FILE: TBD — search for transcript rendering in `electron/renderer/studio.ts`.

20. **In Magic Pointer, defer the "turn complete" visual rearrangement by one transition duration.**
    Everywhere holds a just-finished activity group in place for 400ms so its 320ms glow transition can
    finish before the row set is rebuilt (`ChatPresentation.cs:802-821`). Magic Pointer's card list
    re-lays-out immediately on COMPLETE.
    TARGET FILE: TBD — search for `COMPLETE` handling in `electron/renderer/stage.ts`.

21. **In Magic Pointer, add a time-to-first-token metric per model, measured at the delta, not the request.**
    Everywhere records `gen_ai.request.ttft` from the first streamed item
    (`ChatService.cs:640-648`). Without this you cannot tell whether a slow turn is model latency or
    render latency.
    TARGET: `app/agent_runtime/model_client.py` — search for `MessageDelta` yields.

22. **In Magic Pointer, set `ShowActivated=false` / `focusable:false` on the overlay so revealing it never
    steals focus.** Everywhere combines `ShowActivated = false` with `WS_EX_NOACTIVATE` and
    `WM_MOUSEACTIVATE → MA_NOACTIVATE` (`VisualElementOverlayWindow.cs:17`, `WindowHelper.cs:56-58`).
    TARGET: `electron/main.ts` — search for `createOverlayWindow` (currently sets `focusable: false` on the
    overlay but not on the stage).

---

## The three things a naive implementation gets wrong

1. **It treats "hide" as "destroy."** Everywhere never destroys the panel; it cloaks it, and it set up
   `SetCloaked` specifically so DWM suppresses the reveal animation (`WindowHelper.cs:166-167`). Magic
   Pointer's `ensureFreshGestureOverlay` does the opposite — destroy and rebuild per gesture — and pays
   renderer cold-start on every one.

2. **It lets the overlay become a fullscreen opaque occluder.** This is the single most subtle finding in
   the whole codebase (`docs/ScreenPicker/04`): an opaque fullscreen overlay makes Chromium decide it is
   invisible and *dynamically reparent the UIA provider* to a hidden window. Element picking then silently
   degrades to root-only. `WS_EX_LAYERED` alpha 254 plus `UIA_WindowVisibilityOverridden = 2` is the fix,
   and it costs nothing visually.

3. **It binds to strings instead of to buffers.** Everywhere's answer text is a mutable
   `ObservableStringBuilder` that the markdown renderer subscribes to
   (`ChatPresentationRowPresenter.axaml:588`, `ThreadSafeObservableStringBuilder.cs`). Reassigning a bound
   string per token forces a full re-parse, re-measure, and re-template per token. This is the difference
   between "streaming" and "many small full re-renders."

### One weakness worth not copying

`PickVisualElementParticle.axaml.cs:189-199` animates its morph with `Width`/`Height` +
`Canvas.SetLeft`/`SetTop` — that invalidates layout every frame, contradicting the repo's own rule
(`docs/References/AvaloniaViewPresentation.md`: *"Use `RenderTransform` and opacity for visual-only
movement… These do not participate in measure or arrange"*). It gets away with it because the particles
are few and short-lived. Magic Pointer should use `transform`/`opacity` here, not size.
