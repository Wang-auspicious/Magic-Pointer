// Copyright (c) 2025 Bytedance Ltd. and/or its affiliates.
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DesktopActionSession, nativeRequest, captureSurface, delay, type DesktopRecord, type DesktopWindow, type Rect } from './desktop';
import { requestVision, type ModelConfig } from './model';
import { ActionFailure, type Effect } from './tools';
import { validateTargetLease } from './context_policy';
import { approachLeadMs, flightDurationMs } from '../agent_cursor_policy';

export interface ActionIntent { kind: string; start?: [number, number]; end?: [number, number]; text?: string; keys: string[]; scroll_delta: number; duration_ms: number; thought: string }
export interface SurfaceGrant { grant_id: string; frame_lease_id: string; surface_bounds_px: Rect; window: DesktopWindow; allowed_effects: Effect[]; expires_at: string; task_id?: string }
export async function surfaceGrantFromLeases(frame: DesktopRecord, target: DesktopRecord, actionEffect: Effect, signal?: AbortSignal): Promise<SurfaceGrant> {
  if (!['reversible_write', 'local_irreversible', 'external_send', 'destructive', 'purchase'].includes(actionEffect)) throw new Error('computer_input_requires_explicit_non_read_effect');
  const expected = target?.window || target?.windows?.[0], source = frame?.targetWindow, bounds = frame?.surfaceBoundsPx;
  if (frame?.schemaVersion !== 1 || target?.schemaVersion !== 1 || !frame.frameLeaseId || !expected?.hwnd || !source?.hwnd || Number(expected.hwnd) !== Number(source.hwnd) || !Number(source.processId || source.pid) || Number(expected.processId || expected.pid) !== Number(source.processId || source.pid)) throw new Error('computer_frame_target_identity_mismatch');
  if (!/^sha256:[a-f\d]{64}$/i.test(frame.contentHash || '') || !Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) throw new Error('computer_frame_evidence_invalid');
  const window = await nativeRequest<DesktopWindow>('window', { hwnd: source.hwnd }, signal), valid = await validateTargetLease(target, [window]); if (!valid.valid) throw new ActionFailure('stale_anchor', valid.reason);
  if (bounds[0] < window.bbox[0] || bounds[1] < window.bbox[1] || bounds[2] > window.bbox[2] || bounds[3] > window.bbox[3]) throw new Error('computer_surface_outside_target_window');
  return { grant_id: randomUUID(), frame_lease_id: frame.frameLeaseId, surface_bounds_px: bounds as Rect, window, allowed_effects: ['read', actionEffect], expires_at: target.expiresAt };
}
export interface Anchor extends DesktopRecord { anchor_id: string; app_identity: { process_name: string; process_id?: number; window_class?: string; title_pattern?: string }; structural_path?: string; content_hash?: string; spatial?: { normalized_x: number; normalized_y: number; monitor_index: number; anchor_offset_x: number; anchor_offset_y: number }; captured_at_utc: string; dpi_scale: number }
export interface AnchorProbe { appMatches(anchor: Anchor): Promise<boolean>; structureCandidates(anchor: Anchor): Promise<Anchor[]>; contentHashAt(anchor: Anchor): Promise<string | null>; spatialPosition(anchor: Anchor): Promise<[number, number] | null> }
export async function resolveAnchor(anchor: Anchor, probe: AnchorProbe): Promise<DesktopRecord> {
  if (!anchor.anchor_id || !anchor.captured_at_utc || !(anchor.dpi_scale > 0)) throw new Error('invalid_anchor');
  if (!await probe.appMatches(anchor)) return { kind: 'gone', anchor, reason: 'app_identity_mismatch' };
  const candidates = await probe.structureCandidates(anchor);
  if (candidates.length > 1) return { kind: 'ambiguous', anchor, candidates, evidence: ['multiple_structural_candidates'] };
  if (candidates.length === 1) return anchor.content_hash && candidates[0].content_hash === anchor.content_hash ? { kind: 'exact', anchor, evidence: ['structure_match', 'content_match'] } : { kind: 'changed', anchor, expected_hash: anchor.content_hash, actual_hash: candidates[0].content_hash };
  const content = await probe.contentHashAt(anchor);
  if (content !== null) return anchor.content_hash && content === anchor.content_hash ? { kind: 'moved', anchor, new_position: anchor.spatial ? [anchor.spatial.normalized_x, anchor.spatial.normalized_y] : null, evidence: ['content_match'] } : { kind: 'changed', anchor, expected_hash: anchor.content_hash, actual_hash: content };
  const position = await probe.spatialPosition(anchor); return position ? { kind: 'moved', anchor, new_position: position, evidence: ['spatial_fallback'] } : { kind: 'gone', anchor, reason: 'no_surviving_evidence' };
}

class LiteralParser {
  position = 0;
  constructor(readonly text: string) {}
  space(): void { while (/\s/.test(this.text[this.position] || '') && this.position < this.text.length) this.position++; }
  value(): unknown {
    this.space(); const character = this.text[this.position];
    if (character === "'" || character === '"') { this.position++; let value = ''; while (this.position < this.text.length) { const c = this.text[this.position++]; if (c === character) return value; if (c === '\\') { const escaped = this.text[this.position++]; if (escaped === 'n') value += '\n'; else if (escaped === 't') value += '\t'; else if (escaped === 'r') value += '\r'; else if (escaped === 'u') { const code = this.text.slice(this.position, this.position + 4); if (!/^[\da-f]{4}$/i.test(code)) throw new Error('invalid_string_escape'); value += String.fromCharCode(parseInt(code, 16)); this.position += 4; } else value += escaped; } else value += c; } throw new Error('unterminated_literal'); }
    if (character === '[' || character === '(') { const close = character === '[' ? ']' : ')'; this.position++; const result: unknown[] = []; this.space(); while (this.text[this.position] !== close) { result.push(this.value()); this.space(); if (this.text[this.position] === ',') { this.position++; this.space(); } else if (this.text[this.position] !== close) throw new Error('invalid_literal_sequence'); if (this.position >= this.text.length) throw new Error('unterminated_literal_sequence'); } this.position++; return result; }
    const match = /^(?:-?\d+(?:\.\d*)?(?:e[+-]?\d+)?|True|False|None)/i.exec(this.text.slice(this.position)); if (!match) throw new Error('action_arguments_must_be_literals'); this.position += match[0].length; return /^true$/i.test(match[0]) ? true : /^false$/i.test(match[0]) ? false : /^none$/i.test(match[0]) ? null : Number(match[0]);
  }
}
const kindMap: Record<string, string> = { click: 'click', left_single: 'click', left_double: 'double_click', right_single: 'right_click', hover: 'hover', drag: 'drag', select: 'drag', scroll: 'scroll', type: 'type_text', hotkey: 'hotkey', press: 'hotkey', keydown: 'key_down', release: 'key_up', keyup: 'key_up', wait: 'wait', finished: 'finish', call_user: 'request_user' };
export function parseComputerResponse(text: string, imageSize?: [number, number]): ActionIntent[] {
  if (!text.includes('Action:')) throw new Error('computer_response_missing_action');
  const prefix = text.slice(0, text.lastIndexOf('Action:')); const thought = prefix.split(/Thought:|Reflection:|Action_Summary:/).at(-1)!.trim().slice(0, 2000);
  const parser = new LiteralParser(text.slice(text.lastIndexOf('Action:') + 7).replaceAll('[EOS]', '').trim()); const intents: ActionIntent[] = [];
  const point = (raw: unknown): [number, number] | undefined => {
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw === 'string') { const match = /^<point>\s*([\d.]+)\s+([\d.]+)\s*<\/point>$/.exec(raw.trim()); raw = match ? [Number(match[1]), Number(match[2])] : new LiteralParser(raw).value(); }
    if (!Array.isArray(raw) || ![2, 4].includes(raw.length) || !raw.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) throw new Error('invalid_coordinate_box');
    let values = raw as number[];
    if (values.some(value => value > 1)) { if (!imageSize || !imageSize.every(value => value > 0)) throw new Error('absolute_coordinates_require_model_image_size'); values = values.map((value, index) => value / imageSize[index % 2]); }
    if (values.some(value => value > 1)) throw new Error('coordinate_outside_image');
    return values.length === 2 ? values as [number, number] : [(values[0] + values[2]) / 2, (values[1] + values[3]) / 2];
  };
  while (parser.position < parser.text.length) {
    parser.space(); const match = /^([a-z_]+)\s*\(/i.exec(parser.text.slice(parser.position)); if (!match || !kindMap[match[1].toLowerCase()]) throw new Error('unsupported_computer_action');
    const name = match[1].toLowerCase(); parser.position += match[0].length; const args: DesktopRecord = {}; parser.space();
    while (parser.text[parser.position] !== ')') { const key = /^([a-z_]+)\s*=\s*/i.exec(parser.text.slice(parser.position)); if (!key || key[1] in args) throw new Error('invalid_computer_action_argument'); parser.position += key[0].length; args[key[1]] = parser.value(); parser.space(); if (parser.text[parser.position] === ',') { parser.position++; parser.space(); } else if (parser.text[parser.position] !== ')') throw new Error('invalid_computer_action_syntax'); }
    parser.position++; parser.space();
    const allowed = ['click', 'left_single', 'left_double', 'right_single', 'hover'].includes(name) ? ['start_box', 'start_point', 'point'] : ['drag', 'select'].includes(name) ? ['start_box', 'start_point', 'point', 'end_box', 'end_point'] : name === 'scroll' ? ['start_box', 'start_point', 'point', 'direction'] : ['type', 'finished', 'call_user'].includes(name) ? ['content'] : name === 'wait' ? ['duration', 'duration_ms'] : ['key', 'hotkey', 'press'];
    if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('unsupported_computer_action_argument');
    const duration = Number(args.duration_ms ?? args.duration ?? 1000);
    intents.push({ kind: kindMap[name], start: point(args.start_box ?? args.start_point ?? args.point), end: point(args.end_box ?? args.end_point), text: args.content === undefined ? undefined : String(args.content), keys: String(args.key || args.hotkey || args.press || '').toLowerCase().split(/[+\s]+/).filter(Boolean), scroll_delta: /up/i.test(args.direction || '') ? 5 : /down/i.test(args.direction || '') ? -5 : 0, duration_ms: name === 'wait' ? duration * (duration <= 30 && args.duration_ms === undefined ? 1000 : 1) : 0, thought });
  }
  return intents;
}

export async function runComputerTask(task: string, grant: SurfaceGrant, model: ModelConfig, options: { signal?: AbortSignal; classifyEffect(intent: ActionIntent): Effect | undefined | Promise<Effect | undefined>; onProgress?: (event: DesktopRecord) => void; invariantFuse?: number } ): Promise<DesktopRecord> {
  if (!task.trim() || !grant.grant_id || !grant.frame_lease_id) throw new Error('computer_task_requires_explicit_surface_grant');
  const signal = options.signal; const session = new DesktopActionSession(`computer-${grant.grant_id}`, grant.window.hwnd); const receipts: DesktopRecord[] = []; const history: DesktopRecord[] = [];
  let lastImage: Buffer | undefined, lastIntent: ActionIntent | undefined, repeats = 0;
  const check = async () => { signal?.throwIfAborted(); if (Date.parse(grant.expires_at) <= Date.now()) throw new ActionFailure('stale_anchor', 'surface grant expired'); const live = await nativeRequest<DesktopWindow>('window', { hwnd: grant.window.hwnd }, signal); if (live.pid !== grant.window.pid || grant.window.processStartTime && live.processStartTime !== grant.window.processStartTime || !isDeepStrictEqual(live.bbox, grant.window.bbox)) throw new ActionFailure('stale_anchor', 'surface identity changed'); return live; };
  try {
    for (let round = 1; round <= (options.invariantFuse || 100); round++) {
      const window = await check(); const capture = await captureSurface(grant.surface_bounds_px, signal); const snapshot = await session.observe({ hwnd: window.hwnd, mode: 'image' }, signal); snapshot.surface = capture.bytes;
      const prediction = await requestVision(model, { images: [{ dataUrl: `data:image/png;base64,${capture.bytes.toString('base64')}` }], prompt: `${task}\n\nReturn Thought: followed by exactly one Action: using click(start_box=...), type(content=...), hotkey(key=...), scroll(start_box=...,direction=...), drag(start_box=...,end_box=...), wait(duration=...), finished(content=...) or call_user(content=...). Coordinates refer to this image.\nRecent actions: ${JSON.stringify(history.slice(-8))}`, signal, timeoutMs: 30000 });
      const intents = parseComputerResponse(prediction.text, [capture.width, capture.height]); if (intents.length !== 1) return { status: 'failed', rounds: round, receipts, error: 'one_action_per_observation_required', usedBackend: prediction.usedBackend };
      const intent = intents[0]; if (intent.kind === 'finish' || intent.kind === 'request_user') return { status: intent.kind === 'finish' ? 'completed' : 'needs_user', rounds: round, receipts, final_text: intent.text || '', question: intent.kind === 'request_user' ? intent.text || '' : '', usedBackend: prediction.usedBackend };
      if (lastImage?.equals(capture.bytes) && isDeepStrictEqual(lastIntent, intent)) repeats++; else repeats = 0;
      if (repeats >= 2) return { status: 'stalled', rounds: round, receipts, error: 'repeated_action_unchanged_surface', usedBackend: prediction.usedBackend };
      lastImage = capture.bytes; lastIntent = intent;
      const effect = await options.classifyEffect(intent); if (!effect || !grant.allowed_effects.includes(effect) || effect === 'read' && !['hover', 'wait'].includes(intent.kind)) throw new ActionFailure('permission_denied', 'action effect is outside surface grant');
      await check();
      const actionId = randomUUID(); const parameters: DesktopRecord = { snapshot_id: snapshot.snapshot_id };
      const physical = (point: [number, number]) => ({ x: Math.round(grant.surface_bounds_px[0] + point[0] * Math.max(0, grant.surface_bounds_px[2] - grant.surface_bounds_px[0] - 1)), y: Math.round(grant.surface_bounds_px[1] + point[1] * Math.max(0, grant.surface_bounds_px[3] - grant.surface_bounds_px[1] - 1)) });
      if (intent.start) Object.assign(parameters, physical(intent.start));
      if (intent.end) { const end = physical(intent.end); parameters.to_x = end.x; parameters.to_y = end.y; }
      let result: DesktopRecord;
      if (intent.kind === 'wait') { const duration = Math.max(0, Math.min(30000, intent.duration_ms)); await delay(duration, signal); result = { waitedMs: duration, usedBackend: 'timer' }; }
      else {
        if (Number.isFinite(parameters.x) && Number.isFinite(parameters.y)) {
          const cursor = await nativeRequest('cursor', {}, signal), leadMs = approachLeadMs(Math.hypot(parameters.x - cursor.x, parameters.y - cursor.y));
          options.onProgress?.({ phase: 'agent_cursor', action: 'approach', id: 'agent', x: parameters.x, y: parameters.y, leadMs });
          await nativeRequest('input', { action: 'move', x: parameters.x, y: parameters.y, duration_ms: leadMs, window }, signal); await delay(20, signal);
          if (intent.kind === 'drag') parameters.duration_ms = flightDurationMs(Math.hypot(parameters.to_x - parameters.x, parameters.to_y - parameters.y));
        }
        if (['click', 'double_click', 'right_click'].includes(intent.kind)) { parameters.count = intent.kind === 'double_click' ? 2 : 1; parameters.button = intent.kind === 'right_click' ? 'right' : 'left'; result = await session.call('click', parameters, signal); }
        else if (intent.kind === 'type_text') result = await session.call('type_text', { ...parameters, text: intent.text }, signal);
        else if (intent.kind === 'hotkey') result = await session.call('press_key', { ...parameters, keys: intent.keys.join('+') }, signal);
        else if (intent.kind === 'scroll') { if (!intent.start) throw new Error('scroll_anchor_required'); result = await session.call('scroll', { ...parameters, dy: intent.scroll_delta * 120 }, signal); }
        else if (intent.kind === 'drag') result = await session.call('drag', parameters, signal);
        else if (intent.kind === 'hover') result = await nativeRequest('input', { ...parameters, action: 'move', window }, signal);
        else result = await nativeRequest('input', { action: intent.kind, keys: intent.keys.join('+'), window }, signal);
        options.onProgress?.({ phase: 'agent_cursor', action: 'idle', id: 'agent', x: parameters.x, y: parameters.y });
      }
      await delay(80, signal); await check(); const after = await captureSurface(grant.surface_bounds_px, signal);
      const receipt = { actionId, intent, effect, ...result, imageChanged: !capture.bytes.equals(after.bytes), verification: result.verification || { matched: false, status: 'unavailable' } };
      receipts.push(receipt); history.push({ intent, result: receipt }); options.onProgress?.({ phase: 'computer_action', round, receipt });
    }
    return { status: 'failed', receipts, error: 'computer_invariant_fuse', usedBackend: 'native_desktop' };
  } finally { await nativeRequest('release_input', {}, undefined, 2000).catch(() => {}); }
}

export function extractTerminalEvidence(text: string, method: string, anchorText = ''): DesktopRecord {
  const clean = text.replace(new RegExp(String.fromCharCode(27) + '\\[[0-?]*[ -/]*[@-~]', 'g'), '').replace(/\r\n?/g, '\n').replace(/(--?(?:api[-_]?key|token|secret|password|passwd|authorization|credential))(=|\s+)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[redacted]').replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL))=\S+/gi, '$1=[redacted]');
  const lines = clean.split('\n').map(line => line.trimEnd()); let anchor = -1;
  for (let index = 0; index < lines.length; index++) if (anchorText ? lines[index].includes(anchorText) : /error|exception|traceback|fatal|failed|panic/i.test(lines[index])) anchor = index;
  if (anchor < 0) anchor = Math.max(0, lines.length - 1);
  const commandPattern = /^(?:\s*PS\s+[^>]+>|\s*[A-Z]:\\[^>]*>|\s*(?:\S+@\S+.*?)?[$#])\s*(.*)$/i;
  let command = '', commandLine = 0, nextPrompt = lines.length;
  for (let index = anchor; index >= 0; index--) { const match = commandPattern.exec(lines[index]); if (match) { command = match[1].trim(); commandLine = index; break; } }
  for (let index = anchor + 1; index < lines.length; index++) if (commandPattern.test(lines[index])) { nextPrompt = index; break; }
  const begin = Math.max(commandLine, anchor - 8), end = Math.min(nextPrompt, anchor + 13), block = lines.slice(commandLine, nextPrompt).join('\n');
  const code = /(?:process\s+exited\s+with\s+(?:exit\s+)?code|command\s+failed\s+with\s+exit\s+code|^\s*exit\s+code)\s*[:=]?\s*(-?\d+)/im.exec(block);
  return { schemaVersion: 1, state: command ? 'resolved' : 'partial', method, capturedAt: new Date().toISOString(), command, exitCode: code ? Number(code[1]) : null, anchor: { line: anchor + 1, text: lines[anchor].slice(0, 1000) }, window: { startLine: begin + 1, endLine: end, lineCount: end - begin, before: lines.slice(begin, anchor).join('\n').slice(0, 4000), error: lines[anchor].slice(0, 6000), after: lines.slice(anchor + 1, end).join('\n').slice(0, 4000), text: lines.slice(begin, end).join('\n').slice(0, 8000) }, pixelFallbackUsed: false, provenance: { structural: /^(uia|dom|native|ax):/i.test(method), exitCodeObserved: !!code }, uncertainty: [...(!command ? ['command_not_observed'] : []), ...(!code ? ['exit_code_not_observed'] : [])] };
}
