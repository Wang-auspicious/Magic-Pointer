/**
 * Next-prompt suggestions.
 *
 * A background request predicts what the user would naturally type next, and
 * the composer shows it as ghost text that Tab or Right-arrow accepts. The
 * reference describes the whole design in one line — "Would they think *I was
 * just about to type that*?" — and everything here exists to hold that line:
 *
 *   - the request runs on the same model as the session, with the same
 *     context, so it can hit the prompt cache instead of paying for a second
 *     full read;
 *   - tool use is denied outright, because a suggestion must never act;
 *   - the answer is filtered hard before it is shown, because a ghost line the
 *     user would not have typed is worse than no ghost line at all.
 *
 * This module is pure. It decides *whether* to ask and *whether* to show the
 * answer; the caller owns the model call and the abort signal.
 */

/**
 * The reference's suggestion instruction, verbatim.
 *
 * Two constraints in here are load-bearing and easy to drop when paraphrasing:
 * the test the model is asked to apply ("I was just about to type that"), and
 * the silence rule for anything unsafe — which applies *even when the user is
 * doing legitimate security work*.
 */
export const SUGGESTION_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next into Magic Pointer.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code written → "try it out"
The assistant offers options → suggest the one the user would likely pick, based on conversation
The assistant asks to continue → "yes" or "go ahead"
Task complete, obvious follow-up → "commit this" or "push it"
After error or misunderstanding → silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Assistant-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Stay silent if a suggestion could be unsafe or inappropriate — including any sensitive topic (security incidents, credentials, harm, private data). Even when the user is doing legitimate security or cybersecurity work, do not predict potentially unsafe actions.

Format: 2-12 words, match the user's style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.`;

/**
 * Above this many tokens of conversation, the prediction is skipped.
 *
 * The reference sets the same ceiling on the previous assistant turn's total
 * tokens. Past it the request would no longer be a cache hit, so one ghost
 * line would cost a full re-read of the context.
 */
export const CACHE_COLD_TOKENS = 10_000;

/** Assistant turns required before predicting. A fresh session has nothing to
 *  extrapolate from, and guessing on turn one reads as noise. */
export const MIN_ASSISTANT_TURNS = 2;

/** How many suggestions the user may leave unused before the frequency drops. */
export const UNUSED_BEFORE_THROTTLE = 3;

export interface SuggestionGateState {
  aborted?: boolean;
  /** How many assistant turns the conversation already has. */
  assistantTurns?: number;
  /** The previous turn failed, so the user's next move is a correction, not a
   *  continuation — exactly the case the prompt tells the model to stay silent on. */
  lastResponseError?: boolean;
  /** Total tokens (input + cache reads + cache writes + output) of the last
   *  assistant turn, when known. */
  lastTurnTokens?: number;
  /** The window holding the composer is not focused. */
  unfocused?: boolean;
  /** A plan is awaiting approval, so the next input is dictated by the plan. */
  planMode?: boolean;
  /** The account is at or near its usage limit. */
  rateLimited?: boolean;
  /** An approval prompt is open; the user is answering that, not composing. */
  elicitationActive?: boolean;
  /** The user has left this many suggestions unused in a row. */
  unusedStreak?: number;
}

/**
 * Why a prediction was skipped. Every gate is named so the caller can log the
 * reason rather than only the outcome — "no suggestion appeared" and "we chose
 * not to ask" look identical from the outside otherwise.
 */
export type SuggestionSkipReason =
  | 'aborted'
  | 'early_conversation'
  | 'last_response_error'
  | 'cache_cold'
  | 'unfocused'
  | 'plan_mode'
  | 'rate_limit'
  | 'elicitation_active'
  | 'throttled';

/**
 * The gates, in the reference's order, each short-circuiting.
 *
 * Order matters for cost and for honesty: cheap disqualifiers run before the
 * token comparison, and `aborted` runs before everything so a cancelled turn
 * never starts new work.
 */
export function suggestionGate(
  state: SuggestionGateState,
): {allowed: true} | {allowed: false; reason: SuggestionSkipReason} {
  if (state.aborted) {
    return {allowed: false, reason: 'aborted'};
  }
  if ((state.assistantTurns ?? 0) < MIN_ASSISTANT_TURNS) {
    return {allowed: false, reason: 'early_conversation'};
  }
  if (state.lastResponseError) {
    return {allowed: false, reason: 'last_response_error'};
  }
  if (
    state.lastTurnTokens !== undefined &&
    state.lastTurnTokens > CACHE_COLD_TOKENS
  ) {
    return {allowed: false, reason: 'cache_cold'};
  }
  if (state.unfocused) {
    return {allowed: false, reason: 'unfocused'};
  }
  if (state.planMode) {
    return {allowed: false, reason: 'plan_mode'};
  }
  if (state.rateLimited) {
    return {allowed: false, reason: 'rate_limit'};
  }
  if (state.elicitationActive) {
    return {allowed: false, reason: 'elicitation_active'};
  }
  if ((state.unusedStreak ?? 0) >= UNUSED_BEFORE_THROTTLE) {
    return {allowed: false, reason: 'throttled'};
  }
  return {allowed: true};
}

/**
 * Single words that are a complete instruction on their own.
 *
 * The two-word minimum exists to kill fragments, but it also kills these — and
 * "yes", "go ahead" and "commit" are precisely what a continuation looks like.
 */
const SHORT_ALLOWED = new Set([
  'yes',
  'no',
  'ok',
  'sure',
  'go',
  'push',
  'commit',
  'deploy',
  'stop',
  'continue',
  'check',
  'exit',
  'quit',
  'run',
  'retry',
  'undo',
  'revert',
]);

/** Praise, not instruction. The user would not have typed it as a next step. */
const EVALUATIVE = [
  'thanks',
  'thank you',
  'looks good',
  'looks great',
  'sounds good',
  'nice',
  'great',
  'perfect',
  'awesome',
  'makes sense',
  'well done',
  'good job',
];

/** The assistant's own voice. A suggestion in this voice is a reply, not a prompt. */
const ASSISTANT_VOICE = [
  "let me",
  "i'll",
  "i have",
  "i've",
  "i'm",
  "here's",
  "here is",
  "you can",
  "you should",
  'sure,',
  'of course',
];

function stripWrapper(raw: string): string {
  let text = raw.trim();
  // The model sometimes wraps its answer in a tag or a label even though the
  // prompt forbids it; unwrap before judging the contents.
  const tagged = text.match(/^<(?:suggestion|answer)>([\s\S]*?)<\/(?:suggestion|answer)>$/i);
  if (tagged) {
    text = tagged[1].trim();
  }
  const prefixed = text.match(/^(?:suggestion|answer)\s*:\s*([\s\S]*)$/i);
  if (prefixed) {
    text = prefixed[1].trim();
  }
  return text;
}

/**
 * Decide whether a predicted string is worth showing.
 *
 * Returns the cleaned suggestion, or null when it should be dropped. The rules
 * are the reason predictions always feel the same shape — short, imperative,
 * unpunctuated — because everything outside that channel is discarded here.
 */
export function acceptSuggestion(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const text = stripWrapper(String(raw));
  if (text === '') {
    return null;
  }

  const lower = text.toLowerCase();

  if (lower === 'done') {
    return null;
  }
  if (
    /^(?:nothing found|no suggestion|stay silent|silence|none|n\/a)\.?$/i.test(text)
  ) {
    return null;
  }
  // The model answered the instruction instead of following it.
  if (
    /^[([]/.test(text) &&
    /[)\]]$/.test(text) &&
    !/[.!?]\s+\S/.test(text.slice(1, -1))
  ) {
    return null;
  }
  if (/^(?:api error|prompt is too long|rate limit|error)\b/i.test(text)) {
    return null;
  }
  // "Label: rest" is a caption, not something the user would type.
  if (/^\s*[\w-]{1,24}\s*:\s+\S/.test(text) && !/^[a-z]+:\/\//i.test(text)) {
    return null;
  }
  if (text.length >= 100) {
    return null;
  }
  if (/[\n\r]/.test(text) || text.includes('*')) {
    return null;
  }
  if (/[.!?]\s+[A-Z]/.test(text)) {
    return null;
  }
  // Matched at a word boundary, so "thanks" is praise but "thanksgiving" is
  // not swallowed by it.
  const startsPhrase = (list: readonly string[]): boolean =>
    list.some(phrase =>
      new RegExp(`^${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text),
    );
  if (startsPhrase(EVALUATIVE)) {
    return null;
  }
  if (
    ASSISTANT_VOICE.some(
      phrase => lower === phrase || lower.startsWith(phrase),
    )
  ) {
    return null;
  }

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 12) {
    return null;
  }
  // A bare slash-command is a complete instruction at one "word".
  if (text.startsWith('/')) {
    return text;
  }
  if (words.length < 2 && !SHORT_ALLOWED.has(lower.replace(/[.!?]+$/, ''))) {
    return null;
  }
  return text;
}

/**
 * Tracks how many suggestions have been offered and ignored.
 *
 * The reference drops the frequency after a run of unused suggestions and
 * restores it as soon as one is used, so the feature backs off instead of
 * nagging. `used` is what resets the streak — accepting, not merely seeing.
 */
export function createSuggestionThrottle(limit = UNUSED_BEFORE_THROTTLE) {
  let unused = 0;
  return {
    offered(): void {
      unused += 1;
    },
    used(): void {
      unused = 0;
    },
    unusedStreak(): number {
      return unused;
    },
    throttled(): boolean {
      return unused >= limit;
    },
  };
}
