import { randomUUID } from 'node:crypto';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { record } from './context';
import { contentHash, projectArtifacts } from './artifacts';
import { ensureNativeTool, runProcess, runPowerShellJson } from './desktop';
import { EventSession, withFileLock } from './session';
import { ContextSessionStore } from './context_sessions';
import { ClipboardHistory } from './context_memory';
type Json = Record<string, any>;

export interface ActionOptions {
  root: string;
  userDataDir: string;
  signal?: AbortSignal;
  executeRecipe?: (proposal: Json) => Promise<Json>;
  executeDocumentOperation?: (proposal: Json) => Promise<Json>;
}
export function wantsRouteDraft(command: string): boolean {
  const value = command.trim().replace(/\s+/g, ' ');
  return (
    ['规划路线', '这两个地方怎么走', '这两处怎么走', '查看路线', '生成路线'].includes(value) ||
    /^(?:route (?:these|them)|get directions between (?:these|them)|plan (?:a )?route between (?:these|them))$/i.test(
      value,
    )
  );
}
export function parseRouteDraft(episode: Json): Json {
  const slots = record(episode.slots),
    these = Array.isArray(slots.these) ? slots.these : [],
    origin = record(these.length === 2 ? these[0] : slots.that),
    destination = record(these.length === 2 ? these[1] : slots.this),
    location = (object: Json) => {
      const value = String(object.content ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      return value.length <= 240 ? value : '';
    },
    safe = (object: Json) =>
      Object.fromEntries(
        ['objectId', 'label', 'app', 'windowTitle']
          .filter((key) => object[key] !== undefined)
          .map((key) => [key, object[key]]),
      ),
    start = location(origin),
    end = location(destination);
  return {
    origin: start,
    destination: end,
    travel_mode: 'driving',
    origin_source: safe(origin),
    destination_source: safe(destination),
    episode_id: String(episode.episodeId ?? ''),
    missing_fields: [...(!start ? ['origin'] : []), ...(!end ? ['destination'] : [])],
  };
}
const psPayload = (value: unknown) =>
  `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(value)).toString('base64')}')) | ConvertFrom-Json\n`;
async function historyRecords(path: string): Promise<Json[]> {
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
export function makePromptDeliveryProposal(text: string, options: Json): Json {
  if (!text.trim()) throw new Error('draft text is empty');
  const window = record(options.targetWindow),
    current = record(options.currentTargetWindow),
    rawPoint = options.targetPoint,
    point = Array.isArray(rawPoint) ? rawPoint : [rawPoint?.x, rawPoint?.y];
  if (
    !(Number(window.hwnd) > 0) ||
    !(Number(window.process_id ?? window.pid) > 0) ||
    !String(window.title ?? '').trim()
  )
    throw new Error('target window identity is missing');
  if (
    point.length !== 2 ||
    !point.every(Number.isFinite) ||
    options.targetPointSpace !== 'physical_screen_pixels'
  )
    throw new Error('target coordinate space is not trusted physical screen pixels');
  return {
    id: `prompt-delivery-${randomUUID()}`,
    action_type: 'paste_text_to_foreground',
    target: { point, description: window.title, metadata: window },
    parameters: {
      text,
      text_sha256: contentHash(text),
      target_hwnd: window.hwnd,
      target_title: window.title,
      target_process_id: window.process_id ?? window.pid,
      target_process_name: window.process_name ?? '',
      target_point: point,
      target_point_space: options.targetPointSpace,
      target_resolution: options.targetResolution === 'adaptive' ? 'adaptive' : 'exact',
      current_target_hwnd: current.hwnd ?? 0,
      current_target_process_id: current.process_id ?? current.pid ?? 0,
      current_target_process_name: current.process_name ?? '',
      context_session_id: options.contextSessionId ?? '',
      review_session_id: options.reviewSessionId ?? '',
      workflow_kind: options.workflow ?? 'context_pack',
      prompt_artifact: options.promptArtifact ?? '',
      submit: false,
    },
    confirmation_required: false,
    safety_level: 'low',
    metadata: {
      trusted_local_intent: true,
      explicit_user_delivery_intent: true,
      auto_execute: true,
      no_submit: true,
      delivery_kind: options.deliveryKind ?? 'context_prompt_delivery',
    },
  };
}
export async function copyText(text: string, signal?: AbortSignal): Promise<Json> {
  return runPowerShellJson(
    psPayload({ text }) +
      `Add-Type -AssemblyName System.Windows.Forms
[Windows.Forms.Clipboard]::SetText([string]$p.text)
if ([Windows.Forms.Clipboard]::GetText() -cne [string]$p.text) { throw 'Clipboard verification failed' }
@{ok=$true; verified=$true; chars=([string]$p.text).Length} | ConvertTo-Json -Compress`,
    signal,
  );
}

async function wordAction(parameters: Json, undo: boolean, options: ActionOptions): Promise<Json> {
  const script =
    psPayload({ ...parameters, undo }) +
    `function HashText([string]$s) { return (([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($s)) | ForEach-Object { $_.ToString('x2') }) -join '') }
$prog = [string]$p.com_prog_id
if ($prog -notin @('Word.Application','kwps.Application','wps.Application')) { $prog='Word.Application' }
$word=[Runtime.InteropServices.Marshal]::GetActiveObject($prog)
$doc=$word.ActiveDocument
if (-not $doc) { throw 'No active Word document' }
if ($p.document -and [string]$doc.FullName -ine [string]$p.document) { throw 'Active Word document changed' }
if ($p.document_name -and [string]$doc.Name -cne [string]$p.document_name) { throw 'Active Word document name changed' }
if ($p.hwnd -and [int64]$word.ActiveWindow.Hwnd -ne [int64]$p.hwnd) { throw 'Active Word window changed' }
if ($p.undo) {
 $before=[string]$p.before_text; $after=[string]$p.after_text; $range=$null
 if ($null -ne $p.selection_start -and $null -ne $p.after_selection_end) { try { $candidate=$doc.Range([int]$p.selection_start,[int]$p.after_selection_end); if ([string]$candidate.Text -ceq $after) { $range=$candidate } } catch {} }
 $method='recorded_range'
 if (-not $range -and ($p.left_anchor -or $p.right_anchor -or $p.left_anchor_sha256 -or $p.right_anchor_sha256)) {
  $matches=@(); $start=0
  while ($start -lt [int]$doc.Content.End -and $matches.Count -lt 2) {
   $candidate=$doc.Range($start,[int]$doc.Content.End); $find=$candidate.Find; $find.ClearFormatting(); $find.Text=$after; $find.Forward=$true; $find.Wrap=0; $find.MatchWildcards=$false
   if (-not $find.Execute()) { break }; $valid=$true
   $lc=if ($p.left_anchor) { ([string]$p.left_anchor).Length } else { [int]$p.left_anchor_chars }; $rc=if ($p.right_anchor) { ([string]$p.right_anchor).Length } else { [int]$p.right_anchor_chars }
   if ($lc -gt 0) { if ($candidate.Start -lt $lc) { $valid=$false } else { $left=[string]$doc.Range($candidate.Start-$lc,$candidate.Start).Text; if ($p.left_anchor) { $valid=$left -ceq [string]$p.left_anchor } else { $valid=(HashText $left) -eq $p.left_anchor_sha256 } } }
   if ($valid -and $rc -gt 0) { if ($candidate.End+$rc -gt $doc.Content.End) { $valid=$false } else { $right=[string]$doc.Range($candidate.End,$candidate.End+$rc).Text; if ($p.right_anchor) { $valid=$right -ceq [string]$p.right_anchor } else { $valid=(HashText $right) -eq $p.right_anchor_sha256 } } }
   if ($valid) { $matches+=,@([int]$candidate.Start,[int]$candidate.End) }; $start=[Math]::Max($start+1,[int]$candidate.End)
  }
  if ($matches.Count -ne 1) { throw 'No unique anchored replacement to restore' }; $range=$doc.Range($matches[0][0],$matches[0][1]); $method='anchored_text_match'
 }
 if (-not $range -or [string]$range.Text -cne $after) { throw 'Replacement text changed before undo' }
 $start=[int]$range.Start; $range.Text=$before
 if ([string]$doc.Range($start,$start+$before.Length).Text -cne $before) { throw 'Word precise restore verification failed' }
 @{ok=$true; restored_by=$method; document=[string]$doc.FullName} | ConvertTo-Json -Compress
} else {
 $sel=$word.Selection; $before=[string]$sel.Text; $after=[string]$p.replacement_text; $start=[int]$sel.Start; $end=[int]$sel.End
 if ($p.expected_text_sha256 -and (HashText $before) -ne $p.expected_text_sha256) { throw 'Word selection text changed' }
 if ($null -ne $p.selection_start -and $start -ne [int]$p.selection_start) { throw 'Word selection start changed' }
 if ($null -ne $p.selection_end -and $end -ne [int]$p.selection_end) { throw 'Word selection end changed' }
 $left=[string]$doc.Range([Math]::Max(0,$start-64),$start).Text; $right=[string]$doc.Range($end,[Math]::Min([int]$doc.Content.End,$end+64)).Text
 $sel.Text=$after; $written=$doc.Range($start,$start+$after.Length)
 if ([string]$written.Text -cne $after) { $written.Text=$before; throw 'Word write verification failed; original text restored' }
 @{ok=$true; document=[string]$doc.FullName; hwnd=[int64]$word.ActiveWindow.Hwnd; com_prog_id=$prog; before_text=$before; after_text=$after; selection_start=$start; selection_end=$end; after_selection_end=$start+$after.Length; left_anchor=$left; right_anchor=$right; before_sha256=(HashText $before); after_sha256=(HashText $after)} | ConvertTo-Json -Depth 8 -Compress
}`;
  return runPowerShellJson(script, options.signal, 20000);
}
export class ActionBroker {
  readonly path: string;
  constructor(
    readonly taskId: string,
    readonly options: ActionOptions,
  ) {
    this.path = join(
      options.userDataDir,
      'action-ledger',
      `${taskId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`,
    );
  }
  private async append(value: Json): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify({ ...value, task_id: this.taskId })}\n`);
  }
  async execute(proposal: Json, confirmed = false): Promise<Json> {
    const started = new Date().toISOString(),
      action = String(proposal.action_type),
      p = record(proposal.parameters),
      meta = record(proposal.metadata);
    let output: Json = {},
      status = 'succeeded',
      error: string | null = null;
    try {
      if (!proposal.id) throw new Error('Action proposal id is required');
      const trustedDelivery =
        action === 'paste_text_to_foreground' &&
        meta.trusted_local_intent === true &&
        meta.explicit_user_delivery_intent === true &&
        meta.no_submit === true &&
        p.submit === false;
      if (action !== 'copy_text_to_clipboard' && !trustedDelivery && !confirmed) {
        status = 'skipped';
        throw new Error('confirmation required');
      }
      this.options.signal?.throwIfAborted();
      if (action === 'copy_text_to_clipboard') {
        output = await copyText(String(p.text ?? ''), this.options.signal);
        await new ClipboardHistory(join(this.options.userDataDir, 'clipboard-history.json')).record(
          String(p.text ?? ''),
          { app: String(p.app ?? ''), secret: p.secret === true },
        );
      } else if (action === 'paste_text_to_foreground') {
        if (p.submit !== false || contentHash(String(p.text)) !== p.text_sha256)
          throw new Error('Draft text identity or no-submit intent changed');
        if (p.artifact_id) {
          const session = await EventSession.open(
              this.options.userDataDir,
              String(p.review_session_id || this.taskId),
              false,
            ),
            draft = projectArtifacts(session.events).find(
              (item) => item.artifactId === p.artifact_id,
            );
          if (!draft || draft.revision !== p.artifact_revision || draft.content !== p.text)
            throw new Error('Draft artifact changed before delivery');
        }
        const executable = await ensureNativeTool('uia_draft_writer'),
          raw = await runProcess(executable, [], {
            input: JSON.stringify(p),
            signal: this.options.signal,
            timeoutMs: 12000,
          });
        output = record(JSON.parse(raw.trim().split(/\r?\n/).at(-1) || '{}'));
        if (!output.ok || !output.verified || output.submit_sent)
          throw new Error(String(output.error ?? 'Draft write could not be verified'));
      } else if (action === 'office_replace_selection') {
        if (
          p.replacement_text_sha256 &&
          contentHash(String(p.replacement_text)) !== p.replacement_text_sha256
        )
          throw new Error('Replacement text changed');
        const data = await wordAction(p, false, this.options);
        if (!data.ok) throw new Error(String(data.error));
        const historyId = `history-${randomUUID()}`,
          historyPath = join(this.options.root, 'data', 'runtime', 'action_history.jsonl');
        await withFileLock(`${historyPath}.lock`, async () => {
          const entries = await historyRecords(historyPath);
          entries.push({
            ...data,
            id: historyId,
            proposal_id: proposal.id,
            action_type: action,
            app: 'word',
            status: 'succeeded',
            confirmed: true,
            selection_session_id: p.selection_session_id,
            selection_snapshot_id: p.selection_snapshot_id,
            created_at: started,
            metadata: { com_prog_id: data.com_prog_id },
          });
          await mkdir(dirname(historyPath), { recursive: true });
          await writeFile(
            historyPath,
            entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
          );
        });
        output = {
          ...data,
          history_id: historyId,
          undo_proposal: {
            id: `undo-${randomUUID()}`,
            action_type: 'office_undo_last_action',
            parameters: { history_id: historyId },
            confirmation_required: true,
          },
        };
      } else if (action === 'office_undo_last_action') {
        const path = join(this.options.root, 'data', 'runtime', 'action_history.jsonl');
        output = await withFileLock(`${path}.lock`, async () => {
          const entries = await historyRecords(path),
            entry = [...entries]
              .reverse()
              .find((item) => !item.undone_at && (!p.history_id || item.id === p.history_id));
          if (!entry) throw new Error('No undoable Magic Pointer Word action was found');
          const result = await wordAction(
            { ...entry, com_prog_id: entry.com_prog_id ?? record(entry.metadata).com_prog_id },
            true,
            this.options,
          );
          if (!result.ok) throw new Error(String(result.error));
          entry.undone_at = new Date().toISOString();
          entry.before_text = null;
          entry.after_text = null;
          await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
          return { ...result, history_id: entry.id, undone_at: entry.undone_at };
        });
      } else if (action === 'fabric_recipe_execute') {
        if (!this.options.executeRecipe) throw new Error('Recipe executor is not registered');
        output = await this.options.executeRecipe(proposal);
        const receipt = record(output.fabric_receipt ?? output);
        if (receipt.status === 'pending' || receipt.status === 'accepted') status = 'pending';
        else if (receipt.status === 'failed' || receipt.ok === false)
          throw new Error(String(receipt.error ?? 'Recipe failed'));
      } else if (action === 'document_patch_operation') {
        if (!this.options.executeDocumentOperation)
          throw new Error('Document operation executor is not registered');
        output = await this.options.executeDocumentOperation(proposal);
        if (output.ok === false || output.verified === false)
          throw new Error(String(output.error ?? 'Document operation failed verification'));
      } else throw new Error(`unsupported action_type: ${action}`);
      if (status === 'succeeded' && output.undo_proposal)
        await this.append({
          kind: 'record',
          action_id: proposal.id,
          tool_name: action,
          undo_proposal: output.undo_proposal,
        });
    } catch (cause) {
      error = String(cause instanceof Error ? cause.message : cause);
      if (status !== 'skipped') status = 'failed';
    }
    return {
      proposal_id: proposal.id,
      action_type: action,
      status,
      output,
      error,
      started_at: started,
      finished_at: new Date().toISOString(),
      confirmed_by_user: confirmed,
      metadata: {},
    };
  }
  async undo(id?: string): Promise<Json> {
    return withFileLock(`${this.path}.lock`, async () => {
      let text = '';
      try {
        text = await readFile(this.path, 'utf8');
      } catch {}
      const active = new Map<string, Json>();
      for (const line of text.split('\n').filter(Boolean)) {
        const event: Json = record(JSON.parse(line));
        if (event.kind === 'record') active.set(event.action_id, event);
        else if (event.kind === 'undone') active.delete(event.action_id);
      }
      const entry = id ? active.get(id) : [...active.values()].at(-1);
      if (!entry) throw new Error('No matching undoable action');
      const result = await this.execute(entry.undo_proposal, true);
      if (result.status !== 'succeeded') throw new Error(result.error);
      await this.append({ kind: 'undone', action_id: entry.action_id });
      return entry;
    });
  }
}
export async function handleAction(payload: Json, options: ActionOptions): Promise<Json> {
  const proposal = record(payload.proposal),
    taskId = String(
      payload.taskId ?? payload.sessionId ?? record(proposal.metadata).task_id ?? 'action-bridge',
    ),
    broker = new ActionBroker(taskId, options);
  if (payload.operation === 'undo') {
    try {
      const item = await broker.undo(payload.actionId ?? payload.action_id);
      return {
        ok: true,
        prompt: 'Undo result',
        answer: `已撤销 ${item.tool_name}。`,
        undoneActionId: item.action_id,
      };
    } catch (error) {
      return { ok: false, prompt: 'Undo result', error: String(error) };
    }
  }
  if (!proposal.action_type) return { ok: false, error: 'missing proposal' };
  const result = await broker.execute(proposal, payload.confirmed === true),
    completed = result.status === 'succeeded',
    ok = completed || result.status === 'pending';
  let contextSessionFinished = false,
    reviewSessionFinished = false;
  const p = record(proposal.parameters);
  if (
    completed &&
    proposal.action_type === 'paste_text_to_foreground' &&
    p.workflow_kind === 'runtime_issue' &&
    p.context_session_id
  ) {
    try {
      await new ContextSessionStore(options.userDataDir).finish(String(p.context_session_id));
      contextSessionFinished = true;
    } catch {}
  }
  const undo = record(result.output).undo_proposal;
  if (completed && proposal.action_type === 'paste_text_to_foreground' && p.review_session_id) {
    try {
      const { ReviewSessionStore } = require('./review') as typeof import('./review');
      await new ReviewSessionStore(options.userDataDir).finish(String(p.review_session_id));
      reviewSessionFinished = true;
    } catch {}
  }
  return {
    ok,
    prompt: 'Action result',
    answer:
      result.status === 'pending'
        ? '任务已接收，正在运行，尚未完成。'
        : completed
          ? ((
              {
                copy_text_to_clipboard: 'Copied to clipboard.',
                office_replace_selection: '文档选区已替换，可精确撤销这次修改。',
                office_undo_last_action: '已精确恢复这一次 Magic Pointer 文档修改。',
                paste_text_to_foreground:
                  '草稿已完整填入目标输入框，未发送；请检查后由你点击发送。',
              } as Json
            )[String(proposal.action_type)] ?? 'Action completed.')
          : result.error,
    executionResult: result,
    taskId,
    actions:
      completed && undo
        ? [{ id: proposal.id, kind: 'undo', label: '撤销这一步', actionId: proposal.id, taskId }]
        : [],
    actionProposals: ok && undo ? [undo] : [],
    contextSessionFinished,
    reviewSessionFinished,
  };
}
export async function handleDelivery(payload: Json, options: ActionOptions): Promise<Json> {
  const text = String(payload.text ?? '');
  if (!text.trim() || text.length > 20000)
    return {
      ok: false,
      prompt: '填入',
      error: !text.trim()
        ? '没有可填入的文字。'
        : `这段文字有 ${text.length} 字，超过一次填入的上限 20000 字。`,
    };
  let attempted = false,
    reason = 'missing_target_identity',
    detail = '';
  try {
    const proposal = makePromptDeliveryProposal(text, payload);
    attempted = true;
    const result = await new ActionBroker('delivery', options).execute(proposal, true);
    if (result.status === 'succeeded')
      return {
        ok: true,
        prompt: '填入',
        answer: '已填入输入框并核对过内容，没有发送。',
        detail: '',
        delivery: {
          kind: 'written',
          reasonCode: 'verified',
          message: '已填入输入框并核对过内容，没有发送。',
          writeAttempted: true,
        },
      };
    reason = 'write_unverified';
    detail = String(result.error);
  } catch (error) {
    detail = String(error);
  }
  const message = `${attempted ? '目标输入框未确认写入成功。' : '没有可信的目标窗口或坐标，所以没往任何地方写。'}结果已复制，把光标点进输入框按 Ctrl+V 就行。`;
  try {
    await copyText(text, options.signal);
    return {
      ok: true,
      prompt: '填入',
      answer: message,
      detail,
      delivery: { kind: 'clipboard', reasonCode: reason, message, writeAttempted: attempted },
    };
  } catch (error) {
    return {
      ok: false,
      prompt: '填入',
      answer: '目标输入框和剪贴板均未确认写入成功。',
      detail: `${detail}; ${error}`,
      delivery: {
        kind: 'failed',
        reasonCode: reason,
        message: '目标输入框和剪贴板均未确认写入成功。',
        writeAttempted: attempted,
      },
    };
  }
}
