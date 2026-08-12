'use strict';

// Static wiring: the gesture lifecycle must freeze the frame before perception
// starts. These assertions pin the shape of electron/main.ts — arm arms the
// capture coordinator with physical bounds, complete awaits the commit before
// releasing the overlay and opening the session, and the old 34ms late-capture
// timer is gone.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'electron', 'main.ts'), 'utf8');

// Overlay and stage windows are both excluded from capture under the same
// policy, so neither the drawing canvas nor the capsule can enter the frame.
assert(main.includes('stageWindow.setContentProtection(true)'),
  'stage window must call setContentProtection(true)');
assert(main.includes('overlayWindow.setContentProtection(true)'),
  'overlay window must call setContentProtection(true)');

// One persistent worker client, created once and reused across gestures.
assert(main.includes('new FrameCaptureWorkerClient({'),
  'main must own a single FrameCaptureWorkerClient');
assert(main.includes('frameCaptureWorkerClient.shutdown()'),
  'the worker client must shut down during app quit');

// Arm wires physical display bounds and the committed foreground identity.
assert(main.includes('getCaptureCommitCoordinator().arm({'),
  'armSelectionGesture must arm the capture coordinator');
assert(main.includes('surfaceBoundsPx: physicalDisplayBounds({'),
  'the coordinator arm must carry physical display bounds');
assert(main.includes('hwnd: selectionGestureArm.source.foregroundHwnd'),
  'the coordinator arm must carry the committed foreground HWND');

// Complete awaits the commit before releasing the overlay and opening the
// session; the old fixed 34ms commit timer is gone.
assert(main.includes('getCaptureCommitCoordinator().complete(gesture)'),
  'completeSelectionGesture must await the coordinator commit');
const completeIndex = main.indexOf('getCaptureCommitCoordinator().complete(gesture)');
const cancelCompletedIndex = main.indexOf("cancelSelectionGesture('completed')", completeIndex);
const sessionIndex = main.indexOf('beginSelectionSession(reason, gesture, lease)', completeIndex);
assert(completeIndex >= 0 && cancelCompletedIndex > completeIndex,
  'the overlay may only be released after the commit resolves');
assert(sessionIndex > cancelCompletedIndex && sessionIndex > completeIndex,
  'the session may only start after the commit resolves and the overlay is released');
assert(!main.includes('selectionGestureCommitTimer'),
  'the old fixed 34ms commit timer must be absent');

// The snapshot payload forwards the immutable lease instead of recapturing.
assert(main.includes("function beginSelectionSession(reason = 'manual', gesture: SelectionGesture | null = null, frameLease"),
  'beginSelectionSession must accept a frameLease');
assert(main.includes('frameLease: frameLease ? safeClone(frameLease) : null'),
  'the capture_selection_snapshot payload must forward a safe clone of the lease');

console.log('frame lease main wiring test ok');
