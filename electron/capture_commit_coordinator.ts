'use strict';

// Deterministic arm/commit/cancel ordering for gesture completion, independent
// of Electron window timing:
//
//   idle -> armed -> committing -> committed | failed | cancelled
//
// pointerup must freeze pixels (commit) before the overlay is released and
// before the selection session opens. On commit failure the overlay is still
// released and the failure is reported — the old late-capture path is never
// called silently.

const { randomUUID } = require('crypto');
const { validateFrameLease } = require('./frame_lease');

type CoordinatorState = 'idle' | 'armed' | 'committing' | 'committed' | 'failed' | 'cancelled';
type UnknownRecord = Record<string, unknown>;

interface CaptureArmRequest {
  epochId: string;
  displayId: string;
  scaleFactor: number;
  surfaceBoundsPx: [number, number, number, number];
  targetWindow: { hwnd: number; processId: number; processName: string; title: string };
  overlayExcluded?: boolean;
}

interface CaptureCommitRequest {
  epochId: string;
  gesture: UnknownRecord;
}

interface CaptureCommitProvider {
  arm(request: CaptureArmRequest): Promise<void>;
  commit(request: CaptureCommitRequest): Promise<unknown>;
  cancel(epochId: string): Promise<void>;
}

interface CaptureCommitCoordinatorOptions {
  provider: CaptureCommitProvider;
  releaseOverlay: () => void;
  beginSession: (gesture: unknown, lease: ReturnType<typeof validateFrameLease>) => void;
  onCommitFailure?: (error: unknown) => void;
  tokenFactory?: () => string;
  commitTimeoutMs?: number;
}

const DEFAULT_COMMIT_TIMEOUT_MS = 12_000;

class CaptureCommitCoordinator {
  provider: CaptureCommitProvider;
  releaseOverlay: () => void;
  beginSession: (gesture: unknown, lease: ReturnType<typeof validateFrameLease>) => void;
  onCommitFailure: (error: unknown) => void;
  tokenFactory: () => string;
  commitTimeoutMs: number;
  state: CoordinatorState;
  activeToken: string | null;
  armedRequest: CaptureArmRequest | null;
  cancelledDuringCommit: boolean;

  constructor({
    provider,
    releaseOverlay,
    beginSession,
    onCommitFailure = () => {},
    tokenFactory = () => randomUUID(),
    commitTimeoutMs = DEFAULT_COMMIT_TIMEOUT_MS,
  }: CaptureCommitCoordinatorOptions) {
    this.provider = provider;
    this.releaseOverlay = releaseOverlay;
    this.beginSession = beginSession;
    this.onCommitFailure = onCommitFailure;
    this.tokenFactory = tokenFactory;
    this.commitTimeoutMs = Math.max(1_000, Number(commitTimeoutMs) || DEFAULT_COMMIT_TIMEOUT_MS);
    this.state = 'idle';
    this.activeToken = null;
    this.armedRequest = null;
    this.cancelledDuringCommit = false;
  }

  async arm(request: CaptureArmRequest): Promise<string> {
    if (this.state === 'armed' || this.state === 'committing') {
      await this.cancel();
    }
    const token = this.tokenFactory();
    this.activeToken = token;
    this.armedRequest = { ...request };
    this.cancelledDuringCommit = false;
    this.state = 'armed';
    try {
      await this.provider.arm(request);
    } catch (error) {
      this.state = 'failed';
      this.activeToken = null;
      this.armedRequest = null;
      throw error;
    }
    return token;
  }

  async complete(gesture: UnknownRecord, token?: string): Promise<unknown> {
    if (token !== undefined && token !== this.activeToken) {
      throw new Error('frame_commit_stale_token');
    }
    if (this.state !== 'armed' || !this.activeToken || !this.armedRequest) {
      throw new Error('frame_commit_not_armed');
    }
    const request = this.armedRequest;
    const owningToken = this.activeToken;
    this.state = 'committing';
    let lease: ReturnType<typeof validateFrameLease> | null = null;
    let failure: unknown = null;
    // A provider whose commit never settles must not leave pointerup hanging
    // and the overlay pinned forever (electron audit P2: the coordinator
    // cannot rely on every provider having its own internal timeout).
    const commitDeadline = Date.now() + this.commitTimeoutMs;
    let commitTimeout: NodeJS.Timeout | null = null;
    try {
      const settled = await Promise.race([
        this.provider.commit({
          epochId: request.epochId,
          gesture,
        }),
        new Promise<never>((_resolve, reject) => {
          const wait = Math.max(0, commitDeadline - Date.now());
          commitTimeout = setTimeout(
            () => reject(new Error(`frame_commit_timeout_${this.commitTimeoutMs}ms`)),
            wait,
          );
        }),
      ]);
      lease = validateFrameLease(settled);
    } catch (error) {
      failure = error;
    } finally {
      if (commitTimeout) clearTimeout(commitTimeout);
    }
    // A newer arm may have replaced this epoch while the commit was in
    // flight. The stale commit's tail must not touch the new gesture: no
    // overlay release, no armedRequest clobber, no session for the old
    // gesture. Discard silently (the newer arm owns the surface now).
    if (this.state !== 'committing' || this.activeToken !== owningToken) {
      return null;
    }
    if (this.state === 'committing') this.state = failure ? 'failed' : 'committed';
    try {
      this.releaseOverlay();
    } catch (_releaseError) {
      // Overlay release is best effort: a destroyed window must not turn a
      // successful freeze into a failed gesture.
    }
    this.activeToken = null;
    this.armedRequest = null;
    if (failure !== null) {
      this.onCommitFailure(failure);
      return null;
    }
    if (this.cancelledDuringCommit) {
      this.state = 'cancelled';
      return null;
    }
    this.beginSession(gesture, lease as ReturnType<typeof validateFrameLease>);
    return lease;
  }

  async cancel(): Promise<void> {
    if (this.state === 'armed' && this.activeToken && this.armedRequest) {
      const request = this.armedRequest;
      this.state = 'cancelled';
      this.activeToken = null;
      this.armedRequest = null;
      try {
        await this.provider.cancel(request.epochId);
      } catch (error) {
        this.onCommitFailure(error);
      }
      return;
    }
    if (this.state === 'committing') {
      this.cancelledDuringCommit = true;
      return;
    }
    // idle / committed / failed / cancelled: nothing to cancel.
  }
}

module.exports = { CaptureCommitCoordinator };
