import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const ast = ts.createSourceFile('studio.ts', source, ts.ScriptTarget.Latest, true);
const functions = ['openConversation', 'startNewChat', 'detachPendingConversation'];
const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) && functions.includes(node.name?.text || ''))
  .map(node => node.getText(ast)).join('\n');

function setup() {
  const recovery = { hidden: false, replaceChildren() {} };
  const sandbox: any = {
    activeConversationId: 'old', activeConversationView: {}, activeConversationRecord: {},
    activeConversationTurns: [{ answer: 'old answer' }], activeConversationObject: { label: 'old source' },
    activeConversationTurnCount: 1, activeConversationTab: 'chat', conversationRefreshSequence: 0,
    conversationOpenGeneration: 0, recoveryRenderGeneration: 0, conversationNotificationSequence: 0,
    externalConversationRun: null, pendingConversation: null, composerPlan: { steps: [{ content: 'old plan' }] },
    pendingRenderTimer: null, studioComposerBusy: false,
    pendingPermissionChoice: { grant: 'old authorization' }, composerAttachments: [],
    projectEnvironment: null, repositoryContextDismissedFor: '',
    artifactEditor: { state: () => ({}) },
    document: { getElementById: (id: string) => id === 'conversation-recovery' ? recovery : null,
      querySelectorAll: () => [], querySelector: () => null },
    syncConversationPendingInput() {}, setActiveTaskContext() {}, renderComposerAttachments() {},
    refreshFigmaConnection() {}, renderProjectContext() {}, setStudioHomeVisible() {},
    renderUsageMeter() {}, setConversationTab() {}, renderStudioHome() {}, renderProjectTasks() {},
    renderPlanCard() {}, clearComposerSuggestion() {}, renderArtifactEditor() {},
    setActiveProject() {}, show() {}, renderRepositoryContextBar: async () => {},
    renderConversationRecovery() {},
    stopPendingClock() {}, setComposerRunningState() {},
    Data: { conversation: async (id: string) => ({ id, turns: [] }) },
  };
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  return { sandbox, recovery };
}

async function main() {
  const { sandbox, recovery } = setup();
  sandbox.startNewChat();
  assert.equal(sandbox.activeConversationTurns.length, 0, 'new chat must not project historical child tasks or usage');
  assert.equal(Object.keys(sandbox.activeConversationObject).length, 0, 'new chat must clear the prior selection object');
  assert.equal(sandbox.composerPlan, null, 'new chat must clear the previous task plan');
  assert.equal(sandbox.pendingPermissionChoice, null, 'a previous task authorization must not enter the new task');
  assert.equal(recovery.hidden, true, 'new chat must remove the previous task recovery panel');
  sandbox.pendingConversation = { requestId: 'old-running' };
  sandbox.studioComposerBusy = true;
  sandbox.startNewChat();
  assert.equal(sandbox.pendingConversation, null, 'new chat detaches the previous running task instead of steering it');
  assert.equal(sandbox.studioComposerBusy, false, 'the blank chat can submit its own task');

  let finishRead!: (value: any) => void;
  sandbox.Data.conversation = () => new Promise(resolve => { finishRead = resolve; });
  const opening = sandbox.openConversation('slow-old');
  sandbox.startNewChat();
  finishRead({ id: 'slow-old', turns: [] });
  await opening;
  assert.equal(sandbox.activeConversationId, null, 'a late historical read must not replace a newly requested blank chat');

  const readers = new Map<string, (value: any) => void>();
  sandbox.Data.conversation = (id: string) => new Promise(resolve => readers.set(id, resolve));
  const older = sandbox.openConversation('a');
  const newer = sandbox.openConversation('b');
  readers.get('b')!({ id: 'b', turns: [] }); await newer;
  readers.get('a')!({ id: 'a', turns: [] }); await older;
  assert.equal(sandbox.activeConversationId, 'b', 'the latest navigation must own the displayed conversation');
  const completing = { requestId: 'normal-send' };
  sandbox.pendingConversation = completing;
  sandbox.Data.conversation = async (id: string) => ({ id, turns: [] });
  await sandbox.openConversation('b');
  assert.equal(sandbox.pendingConversation, completing, 'reopening the just-saved active task must preserve its normal submit settlement');
  console.log('Studio conversation isolation passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
