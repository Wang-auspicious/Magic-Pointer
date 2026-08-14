type ReviewRequest = {
  requested?: boolean;
  sessionId?: string;
  terminalReason?: string;
};

type BridgeRunner = (
  payload: ReviewRequest,
  scriptPath: string,
  target: null,
  options: {
    allowWithoutSurface: boolean;
    timeoutMs: number;
    onComplete: (result: any) => void;
  },
) => unknown;

function scheduleBackgroundLearning({
  request,
  runBridge,
  log = () => {},
}: {
  request: ReviewRequest | null | undefined;
  runBridge: BridgeRunner;
  log?: (message: string) => void;
}): boolean {
  if (
    request?.requested !== true
    || typeof request.sessionId !== 'string'
    || request.sessionId.length === 0
    || typeof request.terminalReason !== 'string'
    || request.terminalReason.length === 0
  ) return false;
  const child = runBridge(
    {
      requested: true,
      sessionId: request.sessionId,
      terminalReason: request.terminalReason,
    },
    'scripts/learning_review_bridge.py',
    null,
    {
      allowWithoutSurface: true,
      timeoutMs: 45_000,
      onComplete: (result: any) => {
        log(
          `background learning complete session=${request.sessionId} `
          + `ok=${result?.ok === true} candidates=${Array.isArray(result?.candidateIds) ? result.candidateIds.length : 0}`,
        );
      },
    },
  );
  return Boolean(child);
}

module.exports = { scheduleBackgroundLearning };
