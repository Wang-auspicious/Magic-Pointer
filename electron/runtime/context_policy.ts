import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { array, record, type Json } from './context';
// Shared with the interaction episode store so the handoff describes positions exactly as the Studio does.
const { spatialRelations } = require('../interaction_episode') as { spatialRelations(objects: Json[]): Json[] };

export interface CaptureDecision {
  objectId: string;
  configuredMode: string;
  mode: string;
  allowStructure: boolean;
  allowLocalPixels: boolean;
  allowUpload: boolean;
  reason: string;
  matchedRule: string | null;
}
export class CapturePolicyEngine {
  constructor(
    readonly uploadScreenshots = false,
    readonly defaultMode = 'follow_global',
    readonly sensitiveApps: string[] = [],
    readonly appModes: Record<string, string> = {},
  ) {}
  decide(object: Json): CaptureDecision {
    const source = record(object.source),
      identity = [
        object.app,
        source.app,
        source.processName,
        source.process_name,
        source.executable,
        source.title,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase(),
      match = Object.keys(this.appModes)
        .filter((key) => identity.includes(key.toLowerCase()))
        .sort((a, b) => b.length - a.length || a.localeCompare(b))[0],
      configuredMode = match ? this.appModes[match]! : this.defaultMode;
    if (
      ![
        'follow_global',
        'structured_only',
        'local_ocr',
        'local_screenshot',
        'upload_screenshot',
        'deny',
      ].includes(configuredMode)
    )
      throw new Error('Unsupported capture policy');
    let mode = configuredMode,
      reason = match ? 'app_rule' : 'default_rule';
    if (this.sensitiveApps.some((pattern) => identity.includes(pattern.toLowerCase()))) {
      mode = configuredMode === 'deny' ? 'deny' : 'structured_only';
      reason = 'sensitive_app';
    } else if (
      mode === 'follow_global' ||
      (mode === 'upload_screenshot' && !this.uploadScreenshots)
    ) {
      mode = this.uploadScreenshots ? 'upload_screenshot' : 'local_screenshot';
      reason = this.uploadScreenshots ? 'global_upload_enabled' : 'global_upload_disabled';
    }
    const attestation = record(source.captureAttestation ?? source.capture_attestation),
      requiresAttestation =
        capturePaths(object).length &&
        (['screen_region', 'ui-control', 'canvas', 'video_frame'].includes(String(object.kind)) ||
          source.screenshotPath ||
          source.capturePath ||
          source.annotatedPath);
    if (mode === 'upload_screenshot' && requiresAttestation && attestation.status !== 'verified') {
      mode = attestation.status === 'target_mismatch' ? 'structured_only' : 'local_screenshot';
      reason =
        attestation.status === 'target_mismatch' ? 'target_mismatch' : 'target_attestation_missing';
    }
    return {
      objectId: String(object.id ?? object.objectId ?? ''),
      configuredMode,
      mode,
      allowStructure: mode !== 'deny',
      allowLocalPixels: ['local_ocr', 'local_screenshot', 'upload_screenshot'].includes(mode),
      allowUpload: mode === 'upload_screenshot' && this.uploadScreenshots,
      reason,
      matchedRule: match ?? null,
    };
  }
}
const visual = (path: string) =>
  /^\.(png|jpe?g|bmp|gif|tiff?|webp|heic|avif)$/i.test(extname(path));
function capturePaths(object: Json): string[] {
  const source = record(object.source);
  return [
    ...new Set(
      [
        object.path,
        source.imagePath,
        source.screenshotPath,
        source.capturePath,
        source.annotatedPath,
        source.path,
      ].filter((value): value is string => typeof value === 'string' && !!value),
    ),
  ];
}
export function buildCapturePolicy(
  engine: CapturePolicyEngine,
  objects: Json[],
  attachments: string[] = [],
): Json {
  const decisions = objects.map((object) => engine.decide(object)),
    byPath = new Map<string, CaptureDecision>();
  objects.forEach((object, index) =>
    capturePaths(object).forEach((path) =>
      byPath.set(resolve(path).toLowerCase(), decisions[index]!),
    ),
  );
  const uploadAllowedPaths: string[] = [],
    withheldVisualPaths: string[] = [],
    nonVisualArtifactPaths: string[] = [];
  for (const path of [...new Set(attachments)])
    if (!visual(path)) nonVisualArtifactPaths.push(path);
    else if (
      byPath.get(resolve(path).toLowerCase())?.allowUpload ??
      (decisions.length > 0 && decisions.every((decision) => decision.allowUpload))
    )
      uploadAllowedPaths.push(path);
    else withheldVisualPaths.push(path);
  return {
    schemaVersion: 1,
    globalScreenshotUploadEnabled: engine.uploadScreenshots,
    decisions,
    uploadAllowedPaths,
    withheldVisualPaths,
    withheldVisualCount: withheldVisualPaths.length,
    nonVisualArtifactPaths,
    deniedObjectIds: decisions
      .filter((decision) => !decision.allowStructure)
      .map((decision) => decision.objectId),
    requiresExplicitConfirmation: uploadAllowedPaths.length > 0,
  };
}
export async function createTargetLease(
  objects: Json[],
  options: { selectionSessionId?: string; ttlSeconds?: number } = {},
): Promise<Json> {
  const windows = new Map<number, Json>(),
    captureFiles: Json[] = [];
  for (const object of objects) {
    const source = record(object.source),
      hwnd = Number(source.hwnd),
      pid = Number(source.processId ?? source.process_id ?? source.pid);
    if (hwnd && pid)
      windows.set(hwnd, {
        hwnd,
        processId: pid,
        app: source.app,
        title: source.title,
        processName: source.processName ?? source.process_name,
        processStartTime: source.processStartTime,
        desktopId: source.desktopId ?? source.desktop_id,
      });
    for (const path of capturePaths(object).filter(visual)) {
      if (captureFiles.some((file) => file.path === resolve(path))) continue;
      try {
        const info = await stat(path);
        if (info.isFile())
          captureFiles.push({ path: resolve(path), size: info.size, mtimeMs: info.mtimeMs });
      } catch {}
    }
  }
  const now = Date.now();
  return {
    schemaVersion: 1,
    leaseId: randomUUID(),
    selectionSessionId: options.selectionSessionId ?? '',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(
      now + Math.max(1, Math.min(options.ttlSeconds ?? 600, 3600)) * 1000,
    ).toISOString(),
    window: [...windows.values()][0] ?? {},
    windows: [...windows.values()],
    objectIds: objects.map((object) => object.id ?? object.objectId),
    objects: structuredClone(objects),
    captureFiles,
    requiresLiveValidation: windows.size > 0,
    revision: 1,
  };
}
export async function validateTargetLease(
  lease: Json,
  liveWindows: Json[] | null,
): Promise<{ valid: boolean; reason: string }> {
  const fail = (reason: string) => ({ valid: false, reason });
  if (lease.schemaVersion !== 1 || !Number.isFinite(Date.parse(String(lease.expiresAt))))
    return fail('invalid_target_lease');
  if (Date.parse(String(lease.expiresAt)) <= Date.now()) return fail('target_lease_expired');
  for (const file of array<Json>(lease.captureFiles)) {
    try {
      const info = await stat(String(file.path));
      if (
        info.size !== Number(file.size) ||
        (file.mtimeMs !== undefined && info.mtimeMs !== Number(file.mtimeMs)) ||
        (file.mtimeNs !== undefined && Number((await stat(String(file.path), { bigint: true })).mtimeNs) !== Number(file.mtimeNs))
      )
        return fail('target_capture_changed');
    } catch {
      return fail('target_capture_changed');
    }
  }
  if (!lease.requiresLiveValidation)
    return { valid: true, reason: 'lease_does_not_require_live_window' };
  if (!liveWindows) return fail('target_lease_probe_unavailable');
  for (const expected of array<Json>(lease.windows).length
    ? array<Json>(lease.windows)
    : [record(lease.window)]) {
    const actual = liveWindows.find(
      (window) =>
        Number(window.hwnd) === Number(expected.hwnd) &&
        Number(window.processId ?? window.pid) === Number(expected.processId ?? expected.pid),
    );
    if (!actual) return fail('stale_target_window');
    if (expected.title && actual.title !== expected.title)
      return fail('target_window_title_changed');
    if (expected.processStartTime && actual.processStartTime !== expected.processStartTime)
      return fail('target_process_changed');
    if (expected.desktopId && expected.desktopId !== (actual.desktopId ?? actual.desktop_id))
      return fail('target_desktop_changed');
  }
  return { valid: true, reason: 'live_target_match' };
}
export async function reconfirmTargetLease(
  lease: Json,
  confirmedWindows: Json[],
  ttlSeconds = 600,
): Promise<Json> {
  const expected = array<Json>(lease.windows),
    used = new Set<number>(),
    windows = expected.map((window) => {
      const exact = confirmedWindows.filter(
          (current) =>
            Number(current.hwnd) === Number(window.hwnd) &&
            Number(current.processId ?? current.pid) === Number(window.processId ?? window.pid),
        ),
        candidates = exact.length
          ? exact
          : confirmedWindows.filter(
              (current) =>
                current.title && current.title === window.title && !used.has(Number(current.hwnd)),
            );
      if (candidates.length !== 1) throw new Error('target_reconfirmation_ambiguous');
      const match = candidates[0]!;
      used.add(Number(match.hwnd));
      return { ...match, processId: match.processId ?? match.pid };
    });
  const next = {
    ...lease,
    leaseId: randomUUID(),
    previousLeaseId: lease.leaseId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + Math.max(1, Math.min(ttlSeconds, 3600)) * 1000).toISOString(),
    window: windows[0] ?? {},
    windows,
    requiresLiveValidation: !!windows.length,
    revision: Number(lease.revision ?? 1) + 1,
  };
  const valid = await validateTargetLease(next, confirmedWindows);
  if (!valid.valid) throw new Error(valid.reason);
  return next;
}
export class EgressGate {
  readonly events: Json[] = [];
  private closed = false;
  constructor(private allowed = new Set<string>()) {}
  allow(scope: string): void {
    if (!this.closed) this.allowed.add(scope);
  }
  disallow(scope: string): void {
    this.allowed.delete(scope);
  }
  assertAllowed(
    scope: string,
    toolName: string,
    targetRef: string | null = null,
    origin = 'data',
    explicitApproval = false,
  ): void {
    const allowed =
        !this.closed && this.allowed.has(scope) && (origin === 'instruction' || explicitApproval),
      reason = this.closed
        ? 'egress_gate_closed'
        : !this.allowed.has(scope)
          ? 'scope_not_allowed'
          : allowed
            ? 'authorized'
            : 'evidence_does_not_authorize_egress';
    this.events.push({
      t_utc: new Date().toISOString(),
      scope,
      tool_name: toolName,
      target_ref: targetRef,
      origin,
      allowed,
      reason,
    });
    if (!allowed) throw new Error(`egress denied: ${reason}`);
  }
  close(): void {
    this.closed = true;
    this.allowed.clear();
  }
}
const text = (value: unknown, limit: number): string => String(value ?? '').slice(0, limit);
const relationWords: Record<string, string> = { left_of: 'left of', right_of: 'right of', above: 'above', below: 'below' };
/**
 * The Context Packet rendered for a person or another agent to read: intent, workspace state, pointed objects,
 * their layout, and the failure evidence around them. The JSON stays on disk at `artifactPath`.
 */
export function renderAgentPrompt(packet: Json, artifactPath = ''): string {
  if (packet.schemaVersion !== 2) throw new Error('Context Packet v2 is required');
  const intent = record(packet.intent), workspace = record(packet.workspace), runtime = record(packet.runtime), lease = record(packet.targetLease), binding = record(runtime.processBinding);
  const lines = ['# Magic Pointer grounded object handoff', '', `User intent: ${text(intent.command, 6000)}`];
  if (intent.recipeId) lines.push(`Recipe: ${text(intent.recipeId, 200)}`);
  if (artifactPath) lines.push(`Context Packet: ${artifactPath}`);
  if (lease.leaseId) lines.push(`Target lease: ${lease.leaseId}`);
  lines.push('', '## Workspace', `- cwd: ${workspace.cwd || ''}`, `- repo: ${workspace.repoRoot || 'not detected'}`);
  if (workspace.repoRoot) {
    lines.push(`- branch/head: ${workspace.branch || '(detached)'} / ${workspace.head || ''}`, `- changed files: ${array<string>(workspace.changedFiles).join(', ') || 'none'}`);
    if (workspace.diffStat) lines.push('- diff stat:', '```text', text(workspace.diffStat, 3000), '```');
    if (workspace.diffExcerpt) lines.push('- recent diff excerpt:', '```diff', text(workspace.diffExcerpt, 4000), '```');
  }
  if (workspace.bindingState) lines.push(`- target binding: ${workspace.bindingState}${workspace.bindingRelation ? ` / ${workspace.bindingRelation}` : ''}${binding.launchCommand ? `; launch: ${text(binding.launchCommand, 400)}` : ''}`);
  lines.push('', '## Pointed objects');
  array<Json>(packet.objects).forEach((object, index) => {
    const source = record(object.source), trace = record(source.perceptionTrace);
    lines.push(`${index + 1}. ${object.referenceLabel ? `[${object.referenceLabel}] ` : ''}${text(object.label || object.kind, 200)} — ${text(source.app, 120)} "${text(source.title, 200)}"${source.path ? ` (${text(source.path, 500)})` : ''}`);
    if (trace.selectedLayer) lines.push(`   read via ${trace.selectedLayer}${trace.pixelFallbackUsed ? ' (pixel OCR fallback)' : ''}`);
    if (object.content) lines.push(`   content: ${text(object.content, 4000)}`);
  });
  const relations = array<Json>(packet.spatialRelations);
  if (relations.length) {
    lines.push('', '## Layout');
    for (const item of relations) {
      const parts = [relationWords[String(item.horizontal)], relationWords[String(item.vertical)]].filter(Boolean);
      lines.push(`- ${item.from} is ${parts.length ? parts.join(' and ') : 'aligned with'} ${item.to}`);
    }
  }
  const browser = record(runtime.browserContext ?? array<Json>(packet.objects).map(object => record(object.source).browserContext).find(Boolean));
  if (Object.keys(browser).length) {
    const page = record(browser.page), failures = array<Json>(browser.networkFailures), errors = array<Json>(browser.consoleErrors);
    lines.push('', '## Browser evidence', `- page: ${text(page.title, 300)} ${text(page.url, 1000)}`.trimEnd());
    lines.push(failures.length ? '- network failures:' : '- network failures: none observed in DevTools history');
    for (const failure of failures.slice(0, 20)) lines.push(`  - ${text(failure.errorText, 300)} ${text(failure.url, 1000)} (${text(failure.source, 60)})`);
    if (errors.length) { lines.push('- console errors:'); for (const error of errors.slice(0, 12)) lines.push(`  - ${text(error.text, 600)}`); }
  }
  if (runtime.terminalExcerpt) lines.push('', '## Terminal excerpt', '```text', text(runtime.terminalExcerpt, 8000), '```');
  const component = record(runtime.componentLink), candidates = array<Json>(component.candidates);
  if (candidates.length) { lines.push('', '## Component source candidates (hints; verify before editing)'); for (const candidate of candidates.slice(0, 8)) lines.push(`- ${candidate.path}:${candidate.line ?? 1} ${candidate.componentName ?? ''} (confidence ${candidate.confidence})`); }
  const capabilities = array<Json>(packet.capabilities);
  if (capabilities.length) { lines.push('', '## Relevant capabilities'); for (const item of capabilities) lines.push(`- ${item.id}: ${item.title ?? ''}`); }
  const artifacts = array<string>(packet.artifacts);
  if (artifacts.length) { lines.push('', '## Local artifacts'); for (const item of artifacts.slice(0, 32)) lines.push(`- ${item}`); }
  lines.push('', '## Boundary', '- Pointed objects are historical evidence of where to look; re-read the current file or window before changing it.',
    '- Stay within these objects and this workspace; do not send, submit, purchase, delete or publish.', '- Verify the change on the real target and report exactly what changed.');
  return lines.join('\n');
}

export function buildContextPacket(options: {
  command: string;
  recipeId?: string;
  objects: Json[];
  cwd: string;
  targetLease: Json;
  captureDecisions: CaptureDecision[];
  capabilities?: Json[];
  terminalExcerpt?: string;
  attachments?: string[];
  visualRelays?: Json[];
  workspace?: Json;
  processBinding?: Json;
  componentLink?: Json;
}): Json {
  if (options.captureDecisions.length < options.objects.length)
    throw new Error('Capture decision required for every context object');
  const allowedPaths = new Set<string>(),
    denied: string[] = [],
    objects: Json[] = [];
  options.objects.forEach((object, index) => {
    const decision = options.captureDecisions[index]!;
    if (!decision.allowStructure) {
      denied.push(String(object.id ?? object.objectId));
      return;
    }
    const copy = structuredClone(object),
      source = record(copy.source);
    if (decision.allowUpload) capturePaths(copy).forEach((path) => allowedPaths.add(resolve(path)));
    else {
      for (const key of ['imagePath', 'screenshotPath', 'capturePath', 'annotatedPath'])
        delete source[key];
      if (typeof copy.path === 'string' && visual(copy.path)) delete copy.path;
    }
    copy.source = source;
    objects.push(copy);
  });
  return {
    schemaVersion: 2,
    packetId: randomUUID(),
    createdAt: new Date().toISOString(),
    intent: { command: options.command, recipeId: options.recipeId ?? '' },
    targetLease: { ...options.targetLease, captureFiles: undefined },
    objects,
    visualRelays: (options.visualRelays ?? []).filter((relay) =>
      allowedPaths.has(resolve(String(relay.imagePath ?? relay.path ?? ''))),
    ),
    workspace: options.workspace ?? {
      cwd: resolve(options.cwd),
      bindingState: 'fallback_unverified',
    },
    runtime: {
      terminalExcerpt: options.terminalExcerpt ?? '',
      processBinding: options.processBinding ?? null,
      componentLink: options.componentLink ?? null,
      browserContext:
        objects.map((object) => record(object.source).browserContext).find(Boolean) ?? null,
    },
    spatialRelations: spatialRelations(objects),
    capabilities: (options.capabilities ?? []).slice(0, 8),
    artifacts: (options.attachments ?? []).filter(
      (path) => !visual(path) || allowedPaths.has(resolve(path)),
    ),
    privacy: { deniedObjectIds: denied, screenshotUploadsAllowed: allowedPaths.size > 0 },
  };
}
