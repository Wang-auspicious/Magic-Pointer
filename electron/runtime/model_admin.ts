import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readJson } from './learning';
import { listModels, requestText, resolveModelConfig, type ModelConfig } from './model';
import { CapturePolicyEngine } from './context_policy';

type Data = Record<string, any>;
const { ElectronSettingsStore } = require('../settings_store');

export function settingsStore(userDataDir: string): { load(): Data; save(settings: Data): string } {
  return new ElectronSettingsStore(path.join(userDataDir, 'fabric-settings.json'));
}

export function mergeSettings(base: Data, patch: Data): Data {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) result[key] = value && typeof value === 'object' && !Array.isArray(value)
    ? mergeSettings(base[key] && typeof base[key] === 'object' ? base[key] : {}, value) : value;
  return result;
}

export async function resolveCapabilities(profile: Data, root: string): Promise<Data> {
  const catalog = await readJson(path.join(root, 'data', 'model_capabilities.v1.json'), { entries: [] });
  let host = ''; try { host = new URL(profile.baseUrl).hostname.toLowerCase(); } catch {}
  const entries = catalog.entries.filter((entry: Data) => entry.provider === profile.provider && String(profile.model).toLowerCase().startsWith(String(entry.modelPrefix).toLowerCase()) && (!entry.baseUrlHosts?.length || entry.baseUrlHosts.includes(host)));
  const entry = entries.sort((a: Data, b: Data) => b.modelPrefix.length - a.modelPrefix.length)[0];
  const probe = profile.resolved?.source === 'explicit_probe' ? profile.resolved : null;
  const result: Data = { source: 'unknown', evidence: '', checkedAt: new Date().toISOString() };
  for (const capability of ['audioInput', 'toolCalls']) {
    const manual = profile.overrides?.[capability];
    if (['yes', 'no'].includes(manual)) { result[capability] = manual; Object.assign(result, { source: 'manual_override', evidence: `profile override: ${capability}=${manual}` }); }
    else if (['yes', 'no'].includes(probe?.[capability])) { result[capability] = probe[capability]; if (result.source !== 'manual_override') Object.assign(result, { source: 'explicit_probe', evidence: probe.evidence, checkedAt: probe.checkedAt }); }
    else if (entry) { result[capability] = entry.capabilities[capability] || 'unknown'; if (result.source === 'unknown') Object.assign(result, { source: 'catalog', evidence: entry.evidence, checkedAt: entry.checkedAt }); }
    else result[capability] = 'unknown';
  }
  return result;
}

export async function handleModels(payload: Data, root: string, userDataDir: string, signal?: AbortSignal): Promise<Data> {
  const operation = String(payload.operation), config = resolveModelConfig(payload.modelRuntime, root, userDataDir);
  if (operation === 'model.catalog') return { ok: true, catalog: await listModels(config) };
  if (operation === 'model.select') {
    const model = String(payload.model || '').trim(); if (!model || /[\r\n]/.test(model)) throw new Error('invalid_model');
    if (process.env.MAGIC_POINTER_MODEL) throw new Error('model_selection_overridden_by_environment');
    const secrets = existsSync(path.join(root, 'secrets', 'model.txt')) ? path.join(root, 'secrets') : path.join(userDataDir, 'secrets');
    await mkdir(secrets, { recursive: true }); await writeFile(path.join(secrets, 'model.txt'), model, 'utf8');
    return { ok: true, model, catalog: await listModels({ ...config, model }) };
  }
  if (operation === 'model.health') {
    const file = path.join(userDataDir, 'model-health.json');
    if (payload.probe === true) { try { await requestText(config, { prompt: 'Reply with exactly OK.', maxTokens: 16, timeoutMs: Number(payload.timeoutS || 6) * 1000, signal, attempts: 1, healthFile: file }); } catch {} }
    const data = await readJson(file, {}), health = data.entries?.[String(config.baseUrl || '').replace(/\/+$/, '')] || (data.state ? data : { state: 'unknown' });
    return { ok: true, health: { ...health, open: Number(health.open_until || 0) > Date.now() / 1000 } };
  }
  const store = settingsStore(userDataDir), settings = store.load(), profiles: Data[] = settings.models.profiles;
  const id = String(payload.profileId || payload.id || ''), profile = profiles.find(item => item.id === id);
  if (operation === 'models.list') return { ok: true, state: 'completed', models: await Promise.all(profiles.map(async item => ({ ...item, resolved: await resolveCapabilities(item, root) }))), defaultProfileId: settings.models.defaultProfileId, evidence: { count: profiles.length } };
  if (operation === 'models.save') {
    const next = { ...payload.profile }; next.resolved = await resolveCapabilities(next, root);
    settings.models.profiles = [...profiles.filter(item => item.id !== next.id), next].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    store.save(settings); return { ok: true, state: 'saved', profile: store.load().models.profiles.find((item: Data) => item.id === next.id), evidence: { profileId: next.id, capabilitySource: next.resolved.source } };
  }
  if (!profile) return { ok: false, state: 'failed', error: 'model_profile_not_found', evidence: { profileId: id } };
  if (operation === 'visual_relay.plan') {
    const target = payload.target || {}, source = target.source || {}, privacy = settings.privacy;
    const capture = new CapturePolicyEngine(privacy.upload_screenshots, privacy.default_capture_mode, privacy.sensitive_apps, privacy.app_capture_modes).decide(target);
    if (!capture.allowStructure) return { ok: false, state: 'failed', error: 'capture_policy_denied', evidence: { mode: 'deny' } };
    const text = (value: unknown, limit = 2000) => String(value || '').replace(/[\r\n]/g, ' ').trim().slice(0, limit);
    const strings = (value: unknown, limit = 20): string[] => Array.isArray(value) ? [...new Set(value.slice(0, limit).map(item => text(item, 500)).filter(Boolean))] : [];
    const label = text(target.label || target.content || target.text, 1000), title = text(source.title || source.windowTitle, 1000), role = text(target.elements?.find((element: Data) => element.role)?.role || target.role || target.kind || 'unknown', 120);
    const attachments = capture.allowUpload ? [...new Set<string>([source.screenshotPath, source.imagePath, source.capturePath, source.annotatedPath, source.path].filter(value => typeof value === 'string' && /\.(png|jpe?g|bmp|gif|tiff?|webp|heic|avif)$/i.test(value)))].slice(0, 2) : [];
    const relay: Data = { schemaVersion: 1, profileId: profile.id, intent: text(payload.intent || payload.command, 6000),
      target: { objectId: text(target.id || target.objectId, 240), kind: text(target.kind, 120), label, bbox: target.bbox, app: text(source.app || target.app, 300), windowTitle: title },
      grounding: { ocr: text(target.content || target.text, 8000), role, hierarchy: strings(target.hierarchy).length ? strings(target.hierarchy) : [title, label].filter(Boolean), locatorHints: strings(target.locatorHints || target.locator_hints).length ? strings(target.locatorHints || target.locator_hints) : [`role=${role}`, `name=${label}`] },
      appearance: { foreground: text(target.appearance?.foreground || target.foregroundColor || 'unknown', 80), background: text(target.appearance?.background || target.backgroundColor || 'unknown', 80), shape: text(target.appearance?.shape || target.shape || 'unknown', 160), localImageSummary: text(target.localImageSummary || target.local_image_summary || target.visionObservation || target.vision_observation || target.appearance?.localImageSummary || 'not available', 1200) },
      spatial: { relativeToPointer: text(target.relativeToPointer || 'under-pointer', 120), neighbors: strings(target.neighbors) }, uncertainty: strings(target.uncertainty), provenance: strings(target.provenance || ['grounded_object']), attachments,
      mode: attachments.length ? 'direct_visual' : 'structured_text' };
    if (attachments.length) relay.locatorText = `Object: ${label || role}\nSource: ${relay.target.app} · ${title}\nPointer: ${relay.spatial.relativeToPointer}; bbox=${JSON.stringify(target.bbox)}\nIntent: ${relay.intent}`;
    else { relay.capabilityNotice = 'visual_attachment_blocked_by_policy'; relay.structuredText = JSON.stringify({ target: relay.target, grounding: relay.grounding, appearance: relay.appearance, spatial: relay.spatial, uncertainty: relay.uncertainty, provenance: relay.provenance, intent: relay.intent }, null, 2); }
    return { ok: true, state: 'planned', relay, evidence: { profileId: id, capabilitySource: (await resolveCapabilities(profile, root)).source, captureMode: capture.mode } };
  }
  if (operation === 'models.inspect') return { ok: true, state: 'completed', profile: { ...profile, resolved: await resolveCapabilities(profile, root) }, evidence: { profileId: id } };
  if (operation === 'models.delete') { settings.models.profiles = profiles.filter(item => item.id !== id); if (settings.models.defaultProfileId === id) settings.models.defaultProfileId = null; store.save(settings); return { ok: true, state: 'deleted', profileId: id, evidence: { remaining: settings.models.profiles.length } }; }
  if (operation === 'models.set_default') { settings.models.defaultProfileId = id; store.save(settings); return { ok: true, state: 'saved', defaultProfileId: id, evidence: { profileId: id } }; }
  if (operation === 'models.test') {
    const reply = await requestText({ ...profile, credential: String(payload.credential || '') } as ModelConfig, { prompt: 'Reply with exactly OK.', signal, attempts: 1, timeoutMs: 30000 });
    return { ok: true, state: 'completed', text: reply.text, profile, evidence: { profileId: id, apiMode: profile.apiMode, probe: 'text_connection' } };
  }
  throw new Error(`Unknown model operation: ${operation}`);
}
