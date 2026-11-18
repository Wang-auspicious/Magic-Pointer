/* exported StreamSmoother */

interface TextSmootherStep {
  delta: string;
  emitted: string;
  pending: number;
  done: boolean;
  paused: boolean;
  dontSmooth: boolean;
}

interface TextSmootherOptions {
  immediateFlushChars?: number;
}

interface TextSmoother {
  push(fullText: string, nowMs?: number): void;
  append(delta: string, nowMs?: number): void;
  setPaused(paused: boolean, nowMs?: number): void;
  isPaused(): boolean;
  step(nowMs?: number): TextSmootherStep;
  flush(): TextSmootherStep;
  reset(): void;
  getTarget(): string;
  getEmitted(): string;
}

interface StageDebouncerOptions {
  debounceMs?: number;
  minHoldMs?: number;
}

interface StageDebouncer {
  update(candidateLabel: string, nowMs?: number): string;
  step(nowMs?: number): string;
  current(): string;
  reset(): void;
}

const StreamSmoother = (() => {
  const TOKEN_GATE_MS = 5000;
  const ELAPSED_THRESHOLD_MS = 2000;
  const TOKEN_FIRST_DURATION_MS = 1200;
  const TOKEN_MIN_DURATION_MS = 300;
  const TOKEN_MAX_DURATION_MS = 3000;
  const STAGE_DEBOUNCE_MS = 150;
  const STAGE_MIN_HOLD_MS = 650;
  const DEFAULT_IMMEDIATE_FLUSH_CHARS = 2400;

  function formatElapsedTime(elapsedMs: number): string {
    if (!Number.isFinite(elapsedMs) || elapsedMs < ELAPSED_THRESHOLD_MS) {
      return '';
    }
    const totalSeconds = Math.floor(elapsedMs / 1000);
    if (totalSeconds < 60) {
      return `${totalSeconds}s`;
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }

  function formatThinkingLabel(elapsedMs: number): string {
    const ms = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
    if (ms < 15000) {
      return 'Thinking\u2026';
    }
    if (ms < 30000) {
      return 'Still thinking\u2026';
    }
    if (ms < 45000) {
      return 'Thinking more\u2026';
    }
    if (ms < 60000) {
      return 'Thinking some more\u2026';
    }
    return 'Almost done thinking\u2026';
  }

  function clampTokenDuration(rawMs: number): number {
    return Math.max(
      TOKEN_MIN_DURATION_MS,
      Math.min(TOKEN_MAX_DURATION_MS, rawMs),
    );
  }

  class TokenCountSmoother {
    private displayed = 0;
    private from = 0;
    private target = 0;
    private startMs = 0;
    private durationMs = 0;
    private lastUpdateMs: number | null = null;
    private hasStartedFirst = false;

    setTarget(targetTokens: number, nowMs = Date.now()): void {
      const nextTarget = Math.max(
        0,
        Math.round(Number.isFinite(targetTokens) ? targetTokens : 0),
      );
      this.step(nowMs);
      if (nextTarget < this.target) {
        this.displayed = nextTarget;
        this.from = nextTarget;
        this.target = nextTarget;
        this.startMs = nowMs;
        this.durationMs = 0;
        this.lastUpdateMs = nowMs;
        return;
      }
      if (nextTarget === this.target) {
        return;
      }
      let nextDuration = TOKEN_FIRST_DURATION_MS;
      if (!this.hasStartedFirst && this.displayed === 0) {
        this.hasStartedFirst = true;
        nextDuration = TOKEN_FIRST_DURATION_MS;
      } else if (this.lastUpdateMs !== null) {
        const dt = Math.max(0, nowMs - this.lastUpdateMs);
        nextDuration = clampTokenDuration(
          dt > 0 ? Math.round(dt * 1.15) : TOKEN_FIRST_DURATION_MS,
        );
      }
      this.from = this.displayed;
      this.target = nextTarget;
      this.startMs = nowMs;
      this.durationMs = nextDuration;
      this.lastUpdateMs = nowMs;
    }

    step(nowMs = Date.now()): number {
      if (this.displayed >= this.target || this.durationMs <= 0) {
        if (this.displayed < this.target && this.durationMs <= 0) {
          this.displayed = this.target;
        }
        return this.displayed;
      }
      const elapsed = Math.max(0, nowMs - this.startMs);
      const progress = Math.min(1, elapsed / this.durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      const candidate = Math.round(
        this.from + (this.target - this.from) * eased,
      );
      this.displayed = Math.min(
        this.target,
        Math.max(this.displayed, candidate),
      );
      if (progress >= 1) {
        this.displayed = this.target;
        this.durationMs = 0;
      }
      return this.displayed;
    }

    flush(): number {
      this.displayed = this.target;
      this.from = this.target;
      this.durationMs = 0;
      return this.displayed;
    }

    reset(): void {
      this.displayed = 0;
      this.from = 0;
      this.target = 0;
      this.startMs = 0;
      this.durationMs = 0;
      this.lastUpdateMs = null;
      this.hasStartedFirst = false;
    }

    getTarget(): number {
      return this.target;
    }

    getDisplayed(): number {
      return this.displayed;
    }

    getVisible(
      elapsedMs: number,
      isRunning: boolean,
      nowMs = Date.now(),
    ): number | null {
      if (this.target <= 0) {
        return null;
      }
      if (!isRunning) {
        const finalCount = this.flush();
        return finalCount > 0 ? finalCount : null;
      }
      const current = this.step(nowMs);
      if (!Number.isFinite(elapsedMs) || elapsedMs < TOKEN_GATE_MS) {
        return null;
      }
      return current > 0 ? current : null;
    }
  }

  function createTokenSmoother(): TokenCountSmoother {
    return new TokenCountSmoother();
  }

  function isHighSurrogate(code: number): boolean {
    return code >= 0xd800 && code <= 0xdbff;
  }

  function isWordByte(ch: string): boolean {
    return /[A-Za-z0-9_'-]/.test(ch);
  }

  function snapBoundary(
    target: string,
    startIndex: number,
    rawEndIndex: number,
  ): number {
    const len = target.length;
    if (rawEndIndex >= len) {
      return len;
    }
    let idx = Math.max(startIndex + 1, rawEndIndex);
    // Walk forward past contiguous ASCII word chars so a word emits intact,
    // capped so long URLs/tokens don't stall for too long.
    let scanned = 0;
    while (idx < len && scanned < 16 && isWordByte(target[idx] || '')) {
      idx += 1;
      scanned += 1;
    }
    // Include trailing horizontal space so word + space emits cleanly together.
    while (idx < len && (target[idx] === ' ' || target[idx] === '\t')) {
      idx += 1;
    }
    // Never leave an unpaired UTF-16 high surrogate at the end of a slice.
    if (idx > startIndex && idx < len) {
      const lastCode = target.charCodeAt(idx - 1);
      if (isHighSurrogate(lastCode)) {
        idx += 1;
      }
    }
    return Math.min(len, idx);
  }

  function createTextSmoother(
    options: TextSmootherOptions = {},
  ): TextSmoother {
    const immediateFlushChars =
      options.immediateFlushChars ?? DEFAULT_IMMEDIATE_FLUSH_CHARS;
    let target = '';
    let emittedLen = 0;
    let paused = false;
    let lastStepMs: number | null = null;

    function snapshot(delta: string, dontSmooth: boolean): TextSmootherStep {
      const emitted = target.slice(0, emittedLen);
      const pending = Math.max(0, target.length - emittedLen);
      return {
        delta,
        emitted,
        pending,
        done: pending === 0,
        paused,
        dontSmooth,
      };
    }

    return {
      push(fullText: string, nowMs = Date.now()): void {
        const next = String(fullText || '');
        if (!next.startsWith(target.slice(0, emittedLen))) {
          let common = 0;
          const limit = Math.min(emittedLen, next.length);
          while (common < limit && next[common] === target[common]) {
            common += 1;
          }
          if (common > 0 && isHighSurrogate(next.charCodeAt(common - 1))) {
            common -= 1;
          }
          emittedLen = common;
        }
        target = next;
        if (lastStepMs === null) {
          lastStepMs = nowMs;
        }
      },

      append(delta: string, nowMs = Date.now()): void {
        this.push(target + String(delta || ''), nowMs);
      },

      setPaused(nextPaused: boolean, nowMs = Date.now()): void {
        const flag = Boolean(nextPaused);
        if (paused === flag) {
          return;
        }
        paused = flag;
        lastStepMs = nowMs;
      },

      isPaused(): boolean {
        return paused;
      },

      step(nowMs = Date.now()): TextSmootherStep {
        if (paused || emittedLen >= target.length) {
          if (!paused) {
            lastStepMs = nowMs;
          }
          return snapshot('', false);
        }
        const prevMs = lastStepMs ?? nowMs;
        const dt = Math.max(0, nowMs - prevMs);
        lastStepMs = nowMs;
        const pending = target.length - emittedLen;
        if (pending >= immediateFlushChars) {
          const prevLen = emittedLen;
          emittedLen = target.length;
          return snapshot(target.slice(prevLen), true);
        }
        if (dt === 0) {
          return snapshot('', false);
        }
        let ratePerMs = 0.065;
        if (pending > 160) {
          ratePerMs = Math.max(0.28, pending / 95);
        } else if (pending > 24) {
          ratePerMs = Math.max(0.09, pending / 180);
        }
        const budget = Math.max(1, Math.ceil(dt * ratePerMs));
        const nextLen = snapBoundary(target, emittedLen, emittedLen + budget);
        const delta = target.slice(emittedLen, nextLen);
        emittedLen = nextLen;
        return snapshot(delta, false);
      },

      flush(): TextSmootherStep {
        const delta = target.slice(emittedLen);
        emittedLen = target.length;
        return snapshot(delta, true);
      },

      reset(): void {
        target = '';
        emittedLen = 0;
        paused = false;
        lastStepMs = null;
      },

      getTarget(): string {
        return target;
      },

      getEmitted(): string {
        return target.slice(0, emittedLen);
      },
    };
  }

  function tokenizeWordsForFade(delta: string): string[] {
    if (!delta) {
      return [];
    }
    const tokens = delta.match(/\S+\s*|\s+/g);
    return tokens ?? [delta];
  }

  function createStageDebouncer(
    options: StageDebouncerOptions = {},
  ): StageDebouncer {
    const debounceMs = options.debounceMs ?? STAGE_DEBOUNCE_MS;
    const minHoldMs = options.minHoldMs ?? STAGE_MIN_HOLD_MS;
    let activeLabel = '';
    let activeSinceMs = 0;
    let pendingLabel = '';
    let pendingSinceMs = 0;

    function evaluate(nowMs: number): string {
      if (!pendingLabel || pendingLabel === activeLabel) {
        return activeLabel;
      }
      if (!activeLabel) {
        activeLabel = pendingLabel;
        activeSinceMs = nowMs;
        return activeLabel;
      }
      const debounced = nowMs - pendingSinceMs >= debounceMs;
      const heldLongEnough = nowMs - activeSinceMs >= minHoldMs;
      if (debounced && heldLongEnough) {
        activeLabel = pendingLabel;
        activeSinceMs = nowMs;
      }
      return activeLabel;
    }

    return {
      update(candidateLabel: string, nowMs = Date.now()): string {
        const next = String(candidateLabel || '').trim();
        if (!activeLabel && next) {
          activeLabel = next;
          activeSinceMs = nowMs;
          pendingLabel = next;
          pendingSinceMs = nowMs;
          return activeLabel;
        }
        if (next === activeLabel) {
          pendingLabel = next;
          pendingSinceMs = nowMs;
          return activeLabel;
        }
        if (next !== pendingLabel) {
          pendingLabel = next;
          pendingSinceMs = nowMs;
        }
        return evaluate(nowMs);
      },

      step(nowMs = Date.now()): string {
        return evaluate(nowMs);
      },

      current(): string {
        return activeLabel;
      },

      reset(): void {
        activeLabel = '';
        activeSinceMs = 0;
        pendingLabel = '';
        pendingSinceMs = 0;
      },
    };
  }

  return {
    TOKEN_GATE_MS,
    ELAPSED_THRESHOLD_MS,
    TOKEN_FIRST_DURATION_MS,
    TOKEN_MIN_DURATION_MS,
    TOKEN_MAX_DURATION_MS,
    STAGE_DEBOUNCE_MS,
    STAGE_MIN_HOLD_MS,
    TokenCountSmoother,
    createTokenSmoother,
    createTextSmoother,
    tokenizeWordsForFade,
    formatElapsedTime,
    formatThinkingLabel,
    createStageDebouncer,
  };
})();

if (typeof globalThis !== 'undefined') {
  (globalThis as Record<string, unknown>).StreamSmoother = StreamSmoother;
}

if (typeof module === 'object' && module.exports) {
  module.exports = StreamSmoother;
}
