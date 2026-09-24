import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeAtomic } from './learning';
import { withFileLock } from './session';
import { settingsStore } from './model_admin';
import { requestText, requestVision, resolveModelConfig } from './model';
import { ArtifactRegistry } from './artifacts';
import { CapturePolicyEngine, buildCapturePolicy, buildContextPacket, createTargetLease, renderAgentPrompt, validateTargetLease } from './context_policy';
import { probeGitWorkspace } from './context_workspace';
import { ScreenMemory, ProvenanceIndex } from './context_memory';
import { listWindows, runPowerShellJson } from './desktop';
import { planOverlay, recognizeText } from './desktop_perception';
import { runComputerTask, surfaceGrantFromLeases } from './desktop_operator';
import { ExternalTasks, dispatchExternal } from './external';
import { ActionFailure, ToolRegistry, type Effect } from './tools';
import { SkillCandidateStore } from './context_skill_candidates';
import { RuntimeWorkspaceResolver } from './context_workspace';
import { authorizeAccess, scopeFromEvents, type TaskSourceScope } from './context';
import type { EventSession } from './session';
import type { RuntimeOptions } from './index';

type Data = Record<string, any>;
const content = (object: Data) => String(object.content || object.text || object.selectedText || '');
const safeId = (value: unknown) => { const id = String(value || ''); if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new Error('invalid_id'); return id; };
const time = () => new Date().toISOString();

export async function recipeCatalog(root: string, userDataDir: string): Promise<Data[]> {
  const result: Data[] = (await readJson(path.join(root, 'data', 'recipes', 'builtin.recipes.json'))).recipes;
  const directory = path.join(userDataDir, 'recipes', 'plugins');
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.endsWith('.recipes.json')) continue;
    const plugin = await readJson(path.join(directory, name));
    for (const item of plugin.recipes || []) if (item.id && item.title && item.risk && item.inputKinds && !result.some(existing => existing.id === item.id)) result.push(item);
  }
  return result;
}

function permission(settings: Data, recipe: Data, parameters: Data, objects: Data[]): string {
  const rules = settings.permissions || {}, app = objects.map(item => `${item.source?.app || ''} ${item.source?.title || ''}`).join(' ').toLowerCase();
  const scoped = (rules.scoped_rules || []).find((rule: Data) => (!rule.recipeId || rule.recipeId === recipe.id) && (!rule.app || app.includes(String(rule.app).toLowerCase())) && (!rule.project || path.resolve(parameters.cwd || '') === path.resolve(rule.project)));
  return scoped?.decision || rules.recipe_overrides?.[recipe.id] || rules[recipe.risk === 'read' ? 'default_read' : recipe.risk === 'local_write' ? 'default_write' : recipe.risk === 'external_send' ? 'default_send' : `default_${recipe.risk}`] || (recipe.risk === 'read' ? 'allow' : 'confirm');
}

export const readsHistory = (recipe: Data) => ['memory.recall', 'clipboard.history'].includes(String(recipe.id || recipe.recipeId)) || ['local.memory', 'clipboard.history'].includes(String(recipe.provider));
const restoresClipboard = (recipe: Data, parameters: Data) =>
  (recipe.id === 'clipboard.history' || recipe.recipeId === 'clipboard.history' || recipe.provider === 'clipboard.history') && !!parameters.digest;

export class Fabric {
  readonly settings: Data;
  constructor(readonly options: RuntimeOptions, readonly modelRuntime?: Data) { this.settings = settingsStore(options.userDataDir).load(); }
  async catalog(): Promise<Data[]> { return recipeCatalog(this.options.root, this.options.userDataDir); }
  async search(command: string, objects: Data[] = [], selected = '', limit = 6): Promise<Data[]> {
    const value = command.toLowerCase();
    const matches = (await this.catalog()).filter(recipe => recipe.id === selected || [...(recipe.keywords?.zh || []), ...(recipe.keywords?.en || []), recipe.id, recipe.title].some(word => value.includes(String(word).toLowerCase())) || !command && objects.some(object => recipe.inputKinds.includes(object.kind)));
    return matches.sort((a, b) => Number(b.id === selected) - Number(a.id === selected)).slice(0, limit).map(recipe => ({ ...recipe, selected: recipe.id === selected, availability: recipe.provider.startsWith('unavailable:') ? 'unavailable' : 'available', available: !recipe.provider.startsWith('unavailable:'), enabled: this.settings.recipe_enabled?.[recipe.id] !== false }));
  }
  async plan(payload: Data): Promise<Data> {
    const objects: Data[] = payload.objects || [], parameters = { ...payload.parameters }, command = String(payload.command || '');
    let id = payload.recipeId || payload.selectedRecipeId || /^\s*recipe\s*:\s*([a-z0-9_.-]+)\s*$/i.exec(command)?.[1];
    if (!id) { const found = await this.search(command, objects); if (found.length !== 1) return { ok: false, error: 'ambiguous_command', capabilities: found }; id = found[0].id; }
    const recipe = (await this.catalog()).find(item => item.id === id); if (!recipe) throw new Error('unknown_recipe');
    if (this.settings.recipe_enabled?.[id] === false) throw new Error('recipe_disabled');
    if (objects.length < recipe.minObjects || objects.length > recipe.maxObjects) throw new Error('object_count_mismatch');
    const privacy = this.settings.privacy, engine = new CapturePolicyEngine(privacy.upload_screenshots, privacy.default_capture_mode, privacy.sensitive_apps, privacy.app_capture_modes);
    const attachments: string[] = [...new Set([...(parameters.attachments || []), ...objects.flatMap(object => [object.source?.imagePath, object.source?.capturePath, object.source?.screenshotPath, object.source?.path].filter(Boolean))])] as string[];
    const capture = buildCapturePolicy(engine, objects, attachments) as Data;
    if (capture.deniedObjectIds.length) throw new Error('capture_policy_denied');
    const lease = await createTargetLease(objects, { selectionSessionId: parameters.selectionSessionId, ttlSeconds: parameters.targetLeaseTtlSeconds });
    const risk = restoresClipboard(recipe, parameters) ? 'local_write' : recipe.risk;
    const capabilities = await this.search(command, objects, id), requestedDecision = permission(this.settings, { ...recipe, risk }, parameters, objects);
    const decision = readsHistory(recipe) && requestedDecision === 'allow' ? 'confirm' : requestedDecision;
    const binding = await new RuntimeWorkspaceResolver().resolve(objects, parameters.cwd || this.options.root);
    Object.assign(parameters, { objects, targetLease: lease, capturePolicy: capture, permissionDecision: { decision }, contextPacket: buildContextPacket({ command, recipeId: id, objects, cwd: binding.cwd, workspace: { ...(await probeGitWorkspace(binding.cwd)), cwd: binding.cwd, repoRoot: binding.repoRoot, bindingState: binding.state, bindingRelation: binding.relation }, processBinding: binding, targetLease: lease, captureDecisions: capture.decisions, capabilities, attachments }) });
    const planId = randomUUID(), plan = { id: planId, recipeId: id, command, risk, provider: decision === 'deny' ? 'denied' : recipe.provider,
      objectIds: objects.map((object, index) => object.id || `object-${index + 1}`), parameters, preview: { title: recipe.title, description: recipe.description, provider: recipe.provider, permission: decision, objectCount: objects.length },
      requiresConfirmation: decision === 'confirm' || decision === 'ask' || capture.requiresExplicitConfirmation, idempotencyKey: parameters.idempotencyKey || planId, integrityToken: randomUUID() };
    await writeAtomic(path.join(this.options.userDataDir, 'plans', `${planId}.json`), plan);
    return { ok: true, match: { recipeId: id, confidence: 1, referenceMode: 'this', reason: 'explicit_plan' }, plan };
  }
  async artifact(plan: Data, suffix: string, text: string): Promise<Data> {
    const file = path.join(this.options.userDataDir, 'artifacts', `${safeId(plan.id)}-${suffix}`);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text, 'utf8');
    if (await readFile(file, 'utf8') !== text) throw new Error('artifact_readback_mismatch');
    const artifact = await new ArtifactRegistry(this.options.userDataDir).register(file, { sourceObjectIds: plan.objectIds, recipeId: plan.recipeId, planId: plan.id });
    return { artifact: file, artifactId: artifact.artifactId };
  }
  async execute(plan: Data, confirmed = false): Promise<Data> {
    const file = path.join(this.options.userDataDir, 'plans', `${safeId(plan.id)}.json`), saved = await readJson(file);
    if (!isDeepStrictEqual(saved, JSON.parse(JSON.stringify(plan)))) throw new Error('plan_changed');
    if (restoresClipboard(plan, plan.parameters || {}) && plan.risk !== 'local_write') throw new Error('plan_risk_mismatch');
    const receiptFile = path.join(this.options.userDataDir, 'receipts', `${safeId(plan.idempotencyKey)}.json`);
    return withFileLock(receiptFile + '.execution', async () => {
      const receipt: Data = { id: randomUUID(), planId: plan.id, recipeId: plan.recipeId, status: 'failed', provider: plan.provider, output: {}, verified: false, verification: {}, undo: null, error: null };
      if ((plan.requiresConfirmation || readsHistory(plan) && plan.provider !== 'denied') && !confirmed) return { ...receipt, status: 'confirmation_required', error: 'confirmation_required' };
      if (plan.provider === 'denied') return { ...receipt, status: 'denied', error: 'permission_denied' };
      const previous = await readJson(receiptFile, null); if (previous) return previous;
      try {
        const lease = plan.parameters.targetLease, check = await validateTargetLease(lease, lease.requiresLiveValidation ? await listWindows(this.options.signal) : []);
        if (!check.valid) throw new Error(check.reason);
        const output = await this.perform(plan);
        Object.assign(receipt, { status: output.proposalRequired ? 'capability_unavailable' : output.accepted ? 'accepted' : output.verified === false ? 'verification_failed' : 'succeeded', output, error: output.proposalRequired ? 'writeback_requires_action_proposal' : output.error || null, verified: output.verified ?? (output.accepted !== true && !output.proposalRequired), verification: output.verification || (output.accepted ? { mode: 'task_accepted', terminalOutcomeVerified: false } : { mode: output.artifact ? 'artifact_readback' : output.verificationMethod || 'result_readback' }) });
      } catch (error) { receipt.error = error instanceof Error ? error.message : String(error); receipt.status = receipt.error.startsWith('capability_unavailable:') ? 'capability_unavailable' : 'failed'; }
      await writeAtomic(receiptFile, receipt);
      await appendFile(path.join(this.options.userDataDir, 'audit.jsonl'), JSON.stringify({ timestamp: time(), event: 'recipe.executed', planId: plan.id, recipeId: plan.recipeId, status: receipt.status, error: receipt.error }) + '\n');
      await new ProvenanceIndex(this.options.userDataDir).recordExecution(plan, receipt);
      await new SkillCandidateStore(this.options.userDataDir).observeExecution(plan, receipt);
      return receipt;
    });
  }
  async perform(plan: Data): Promise<Data> {
    const params = plan.parameters, objects: Data[] = params.objects, provider = plan.provider, source = objects.map(content).filter(Boolean).join('\n\n');
    const config = resolveModelConfig(params.modelRuntime || this.modelRuntime, this.options.root, this.options.userDataDir), signal = this.options.signal;
    if (provider.startsWith('unavailable:')) throw new Error(`capability_unavailable:${provider.slice(12)}`);
    if (provider === 'internal') return { state: 'available', recipeId: plan.recipeId, verificationMethod: 'internal_contract' };
    if (provider === 'clipboard' || provider === 'native.ocr') {
      let text = source;
      if (!text) { const image = objects[0]?.source?.capturePath || objects[0]?.source?.imagePath || objects[0]?.source?.path; if (image) text = (await recognizeText(image, { signal })).text; }
      if (!text) throw new Error('selected_text_is_empty');
      if (plan.recipeId === 'text.ocr_clean') text = /去掉空格|remove spaces|号码空格/.test(plan.command) ? text.replace(/\s+/g, '') : text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      await copyToClipboard(text, signal); return { text, verificationMethod: 'clipboard_readback' };
    }
    if (provider === 'artifact.table') {
      const tables = objects.map(object => parseTable(content(object))).filter(rows => rows.length); if (!tables.length) throw new Error('no_structured_table_content');
      const rows = [...tables[0]]; if (plan.recipeId === 'table.merge') for (const table of tables.slice(1)) { if (!isDeepStrictEqual(table[0], rows[0])) throw new Error('table_schema_conflict'); rows.push(...table.slice(1)); }
      const width = Math.max(...rows.map(row => row.length)), text = rows.map(row => [...row, ...Array(width - row.length).fill('')].map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n') + '\n';
      if (!isDeepStrictEqual(parseTable(text), rows.map(row => [...row, ...Array(width - row.length).fill('')]))) throw new Error('table_readback_mismatch');
      return { ...await this.artifact(plan, 'table.csv', text), format: 'csv', rows: rows.length, columns: width };
    }
    if (provider === 'artifact.evidence') return this.artifact(plan, 'evidence.md', objects.map((object, index) => `## Evidence ${index + 1}\n\n${JSON.stringify(object.source || {})}\n\n${content(object)}\n`).join('\n'));
    if (provider === 'artifact.compare') { const before = content(objects[0]), after = content(objects[1]), diff = before === after ? '' : `--- ${objects[0].label || 'THIS'}\n+++ ${objects[1].label || 'THAT'}\n${before.split('\n').map(line => '-' + line).join('\n')}\n${after.split('\n').map(line => '+' + line).join('\n')}`; return { ...await this.artifact(plan, 'comparison.md', '```diff\n' + diff + '\n```\n'), diff }; }
    if (provider === 'artifact.visual_context') {
      if (plan.recipeId === 'image.to_prompt') {
        const images = params.capturePolicy.uploadAllowedPaths.map((file: string) => ({ path: file }));
        const reply = images.length ? await requestVision(config, { images, prompt: 'Describe these images as a precise reusable image generation prompt. Distinguish visible content, composition, light, color and style. Do not invent unseen details.', context: source, signal }) : await requestText(config, { prompt: plan.command, context: source, signal });
        return { ...await this.artifact(plan, 'image-prompt.md', reply.text), text: reply.text, usedBackend: reply.usedBackend };
      }
      return this.artifact(plan, 'visual-context.json', JSON.stringify({ schemaVersion: 1, sourceObjectIds: plan.objectIds, objects }, null, 2));
    }
    if (provider === 'model.text' || provider === 'inplace.text') {
      if (!source) throw new Error('selected_text_is_empty'); const reply = await requestText(config, { prompt: plan.command, context: source, signal });
      if (!reply.text.trim()) throw new Error('text_model_returned_empty');
      return { ...await this.artifact(plan, 'text.md', reply.text), text: reply.text, usedBackend: reply.usedBackend, ...(provider === 'inplace.text' ? { proposalRequired: true, verificationMethod: 'draft_only' } : {}) };
    }
    if (provider === 'overlay.translation') {
      const blocks = objects.flatMap(object => object.blocks || []).filter(block => block.text); if (!blocks.length) throw new Error('region_has_no_readable_text');
      const reply = await requestText(config, { prompt: `逐行翻译成${params.targetLanguage || '中文'}，保留行号，严格对应输入行数。`, context: blocks.map((block, index) => `${index + 1}. ${block.text}`).join('\n'), signal });
      const translations = reply.text.split('\n').filter(Boolean).map(line => line.replace(/^\s*\d+[.)、]\s*/, '')); if (translations.length !== blocks.length) throw new Error('translation_line_count_mismatch');
      const overlay = planOverlay(blocks, translations); return { overlay, targetLanguage: params.targetLanguage || '中文', coverage: { blocks: blocks.length, covered: overlay.length }, usedBackend: reply.usedBackend };
    }
    if (provider === 'local.memory') return { entries: await new ScreenMemory(path.join(this.options.userDataDir, 'screen-memory.json'), true).recall(params.query || plan.command, params), verificationMethod: 'read_only' };
    if (provider === 'clipboard.history') {
      const history = await readJson(path.join(this.options.userDataDir, 'clipboard-history.json'), { entries: [] });
      if (params.digest) { const item = history.entries.find((entry: Data) => entry.digest === params.digest); if (!item) throw new Error('clipboard_entry_expired'); await copyToClipboard(item.text, signal); return { text: item.text, restored: true }; }
      return { entries: history.entries.filter((entry: Data) => !params.query || String(entry.text).includes(params.query)).map((entry: Data) => ({ ...entry, excerpt: String(entry.text).slice(0, 200), text: undefined })), verificationMethod: 'read_only' };
    }
    if (provider === 'local.task') {
      const file = path.join(this.options.userDataDir, 'tasks', 'tasks.json'); return withFileLock(file + '.lock', async () => { const state = await readJson(file, { schemaVersion: 1, tasks: [] }); let task = state.tasks.find((item: Data) => item.idempotencyKey === plan.idempotencyKey); if (!task) { task = { id: randomUUID(), title: (source || plan.command).split('\n')[0].slice(0, 160), description: source, sourceObjectIds: plan.objectIds, status: 'open', idempotencyKey: plan.idempotencyKey }; state.tasks.push(task); await writeAtomic(file, state); } return { taskId: task.id, store: file }; });
    }
    if (provider === 'maps.deep_link') { if (objects.length !== 2 || objects.some(object => !content(object))) throw new Error('route_requires_two_locations'); const url = `https://www.google.com/maps/dir/?${new URLSearchParams({ api: '1', origin: content(objects[0]), destination: content(objects[1]), travelmode: params.travelMode || 'driving' })}`; await runPowerShellJson(`Start-Process '${url.replace(/'/g, "''")}' -WindowStyle Hidden\n@{opened=$true}|ConvertTo-Json -Compress`, signal); return { url, verificationMethod: 'shell_open_accepted' }; }
    if (provider === 'computer.task') {
      const actionEffect = String(params.actionEffect || params.action_effect || ({ local_write: 'local_irreversible', external_send: 'external_send', destructive: 'destructive', purchase: 'purchase' } as Data)[plan.risk] || '') as Effect;
      const permitted = ({ local_write: ['reversible_write', 'local_irreversible'], external_send: ['external_send'], destructive: ['destructive'], purchase: ['purchase'] } as Data)[plan.risk] || [];
      if (!permitted.includes(actionEffect)) throw new Error('computer_effect_exceeds_approved_recipe');
      if (params.backend && params.backend !== 'windows-native') throw new Error(`capability_unavailable:computer_backend:${params.backend}`);
      const frame = params.frameLease || params.frame_lease || objects[0]?.source?.frameLease || objects[0]?.source?.frame_lease;
      if (!frame) throw new Error('computer_task_requires_frozen_frame');
      const capture = params.capturePolicy?.decisions || [];
      if (!capture.length || capture.some((decision: Data) => decision.allowUpload !== true)) throw new Error('computer_screenshot_upload_not_authorized');
      const grant = await surfaceGrantFromLeases(frame, params.targetLease, actionEffect, signal);
      const result = await runComputerTask(plan.command, grant, config, { signal, classifyEffect: intent => intent.kind === 'wait' ? 'read' : actionEffect, onProgress: event => this.options.onProgress?.(event.phase || 'computer_action', event) });
      if (!['completed', 'needs_user'].includes(result.status)) throw new Error(result.error || `computer_task_${result.status}`);
      return { ...result, verified: false, verification: { mode: 'observed_action_changes', terminalOutcomeVerified: false }, verificationMethod: 'observed_action_changes', needsUser: result.status === 'needs_user' };
    }
    if (provider === 'agent.task') {
      const task = await dispatchExternal({ ...params, provider: params.agent || this.settings.agents.preferred, prompt: renderAgentPrompt(params.contextPacket), cwd: params.cwd || this.options.root, deliveryMode: params.deliveryMode || this.settings.agents.delivery_mode, attachments: params.capturePolicy.uploadAllowedPaths, background: plan.recipeId === 'agent.background_task' }, this.options.userDataDir);
      await new ExternalTasks(this.options.userDataDir).mutate(task.taskId, value => { value.targetLease = { state: 'active', lease: params.targetLease }; }); return { ...task, accepted: true };
    }
    throw new Error(`capability_unavailable:executor_not_registered:${provider}`);
  }
}

export async function copyToClipboard(text: string, signal?: AbortSignal): Promise<void> {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  const result = await runPowerShellJson(`Add-Type -AssemblyName System.Windows.Forms\n$text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))\n[Windows.Forms.Clipboard]::SetText($text)\n@{verified=([Windows.Forms.Clipboard]::GetText() -ceq $text)}|ConvertTo-Json -Compress`, signal);
  if (!result.verified) throw new Error('clipboard_readback_mismatch');
}

function parseTable(text: string): string[][] {
  const delimiter = text.includes('\t') ? '\t' : ',', rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index++) { const char = text[index]; if (char === '"') { if (quoted && text[index + 1] === '"') { cell += '"'; index++; } else quoted = !quoted; } else if (!quoted && char === delimiter) { row.push(cell); cell = ''; } else if (!quoted && char === '\n') { row.push(cell.replace(/\r$/, '')); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; } else cell += char; }
  if (cell || row.length) { row.push(cell); rows.push(row); } return rows;
}

function requireRecipeScope(args: Data, scope: TaskSourceScope): void {
  if (args.operation === 'catalog') return;
  const parameters: Data = args.operation === 'execute' ? (args.plan as Data)?.parameters || {} : args.parameters || {};
  const objects: Data[] = args.operation === 'execute' ? parameters.objects || [] : args.objects || [];
  const paths: string[] = [];
  const windowIds: string[] = [];
  for (const object of objects) {
    const source = object.source || {};
    const sourceId = String(object.sourceId || source.sourceId || '');
    if (sourceId) {
      const decision = authorizeAccess(scope, { action: 'read', sourceIds: [sourceId] });
      if (!decision.allowed) throw new ActionFailure('permission_denied', decision.reason);
    }
    for (const value of [object.path, source.path, source.imagePath, source.screenshotPath, source.capturePath, source.annotatedPath, source.frameLease?.localArtifact?.path])
      if (typeof value === 'string' && value) paths.push(value);
    const hwnd = Number(source.hwnd || source.windowHwnd);
    if (Number.isInteger(hwnd) && hwnd > 0) windowIds.push(`w-${hwnd}`);
  }
  for (const value of [...(Array.isArray(parameters.attachments) ? parameters.attachments : []), parameters.cwd, parameters.frameLease?.localArtifact?.path])
    if (typeof value === 'string' && value) paths.push(value);
  if (windowIds.length) {
    const decision = authorizeAccess(scope, { action: 'read', windowIds });
    if (!decision.allowed) throw new ActionFailure('permission_denied', decision.reason);
  }
  const samePath = (left: string, right: string) => {
    const a = path.resolve(left), b = path.resolve(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  };
  for (const candidate of paths) {
    if (authorizeAccess(scope, { action: 'read', paths: [candidate] }).allowed) continue;
    const pointed = scope.sources.some(source => {
      const identity = source.identity as Data;
      const sourcePaths = [identity.absolutePath, identity.path, identity.frameLease?.localArtifact?.path];
      return sourcePaths.some(value => typeof value === 'string' && samePath(candidate, value)) &&
        authorizeAccess(scope, { action: 'read', sourceIds: [source.sourceId] }).allowed;
    });
    if (!pointed) throw new ActionFailure('permission_denied', `path_not_granted:${candidate}`);
  }
}

function approvedRecipeExecution(session: EventSession, args: Data, callId: string): boolean {
  if (!callId.startsWith('approval-')) return false;
  const requestId = callId.slice('approval-'.length);
  const answer = session.events.find(event => event.type === 'user_input/answered' && event.data.requestId === requestId);
  if (!answer) return false;
  const pending = answer.data.pendingInput as Data, response = answer.data.response as Data;
  if (pending?.kind !== 'permission' || pending.harnessPermission !== true || pending.tool !== 'Recipe' ||
    pending.action?.tool !== 'Recipe' || !['once', 'grant'].includes(String(response?.decision)) ||
    !isDeepStrictEqual(pending.action.arguments, args)) return false;
  if (session.events.some(event => event.type === 'permission/cancelled' && (event.data.requestIds as string[] || []).includes(requestId))) return false;
  const prepared = session.events.filter(event => event.type === 'operation/prepared' && event.data.callId === callId);
  if (prepared.length !== 1 || prepared[0]!.data.name !== 'Recipe' || !isDeepStrictEqual(prepared[0]!.data.arguments, args)) return false;
  return !session.events.some(event => event.type === 'operation/settled' && event.data.operationId === prepared[0]!.data.operationId);
}

export function registerRecipeTools(registry: ToolRegistry, fabric: Fabric, session: EventSession): void {
  registry.register({ name: 'Recipe', description: 'Inspect explicit built-in workflows and execute a reviewed plan. Natural tasks run on this Agent; external delivery is only for an explicitly requested client.', input_schema: { type: 'object', properties: { operation: { type: 'string', enum: ['catalog', 'plan', 'execute'] }, recipeId: { type: 'string' }, command: { type: 'string' }, objects: { type: 'array', items: { type: 'object', additionalProperties: true } }, parameters: { type: 'object', additionalProperties: true }, plan: { type: 'object', additionalProperties: true } }, required: ['operation'] },
    effect_for: args => {
      if (args.operation !== 'execute') return 'read';
      const plan = args.plan as Data, risk = String(plan?.risk || '');
      if (['external_send', 'destructive', 'purchase'].includes(risk)) return risk as Effect;
      if (plan?.requiresConfirmation) return risk === 'read' ? 'read' : 'local_irreversible';
      return risk === 'read' ? 'read' : 'reversible_write';
    }, deferred: true,
    execute: (args, context) => {
      requireRecipeScope(args, scopeFromEvents(session.events, session.id));
      return args.operation === 'catalog' ? fabric.catalog() : args.operation === 'plan' ? fabric.plan(args)
        : fabric.execute(args.plan as Data, approvedRecipeExecution(session, args, context.tool_call_id));
    } });
}
