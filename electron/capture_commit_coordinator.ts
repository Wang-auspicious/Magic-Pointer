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
}

class CaptureCommitCoordinator {
  provider: CaptureCommitProvider;
  releaseOverlay: () => void;
  beginSession: (gesture: unknown, lease: ReturnType<typeof validateFrameLease>) => void;
  onCommitFailure: (error: unknown) => void;
  tokenFactory: () => string;
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
  }: CaptureCommitCoordinatorOptions) {
    this.provider = provider;
    this.releaseOverlay = releaseOverlay;
    this.beginSession = beginSession;
    this.onCommitFailure = onCommitFailure;
    this.tokenFactory = tokenFactory;
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

  async complete(gesture: UnknownRecord, token?: string): Promise<void> {
    if (token !== undefined && token !== this.activeToken) {
      throw new Error('frame_commit_stale_token');
    }
    if (this.state !== 'armed' || !this.activeToken || !this.armedRequest) {
      throw new Error('frame_commit_not_armed');
    }
    const request = this.armedRequest;
    this.state = 'committing';
    let lease: ReturnType<typeof validateFrameLease> | null = null;
    let failure: unknown = null;
    try {
      lease = validateFrameLease(await this.provider.commit({
        epochId: request.epochId,
        gesture,
      }));
    } catch (error) {
      failure = error;
    }
    if (this.state === 'committing') this.state = failure ? 'failed' : 'committed';
    this.releaseOverlay();
    this.activeToken = null;
    this.armedRequest = null;
    if (failure !== null) {
      this.onCommitFailure(failure);
      return;
    }
    if (this.cancelledDuringCommit) {
      this.state = 'cancelled';
      return;
    }
    this.beginSession(gesture, lease as ReturnType<typeof validateFrameLease>);
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
