const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { projectRoot: resolveProjectRoot } = require('./runtime_paths');

type PreflightData = Record<string, any>;
interface CommandResult { error?: unknown; status: number | null; stderr: string; stdout: string }
interface CommandOptions { cwd?: string; env?: NodeJS.ProcessEnv; input?: unknown; signal?: AbortSignal | null; timeout?: number }
interface PreflightOptions {
  root: string; projectRoot?: string; settings?: PreflightData; credentialStore?: { status(reference?: string): PreflightData | null } | null;
  wiggleDetector?: unknown; platform?: NodeJS.Platform; environment?: NodeJS.ProcessEnv; runtimeExecutable?: string;
  commandRunner?: (command: string, args: string[], options: any) => CommandResult;
  asyncCommandRunner?: (command: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;
}
function lastJson(value: string): PreflightData | null { for (const line of value.trim().split(/\r?\n/).reverse()) { try { return JSON.parse(line); } catch {} } return null; }
function failed(error: unknown): PreflightData { return { state: 'fail', evidence: `runtime_check_failed:${error instanceof Error ? error.message : String(error)}`, fixAction: 'repair_runtime' }; }
function writable(root: string): void { fs.mkdirSync(root, { recursive: true }); const file = path.join(root, `.preflight-${process.pid}.tmp`); fs.writeFileSync(file, 'ok'); fs.unlinkSync(file); }
function commandInput(options: PreflightOptions, kind: string): [string, string[], CommandOptions] {
  const runtime = path.join(options.projectRoot || resolveProjectRoot(__dirname), 'build', 'electron', 'runtime');
  const expression = kind === 'agents'
    ? `require(${JSON.stringify(path.join(runtime, 'external.js'))}).discoverProviders().then(providers=>console.log(JSON.stringify({ok:true,providers}))).catch(e=>{console.error(e);process.exitCode=1})`
    : kind === 'smoke'
      ? `const {ToolRegistry}=require(${JSON.stringify(path.join(runtime, 'tools.js'))});const {registerDesktopTools}=require(${JSON.stringify(path.join(runtime, 'desktop.js'))});const r=new ToolRegistry();registerDesktopTools(r);if(!r.get('get_app_state'))throw Error('desktop_tools_missing');console.log(JSON.stringify({ok:true,count:r.list().length}))`
      : 'console.log(JSON.stringify({ok:true,node:process.versions.node}))';
  return [options.runtimeExecutable || process.execPath, ['-e', expression], { cwd: options.projectRoot || resolveProjectRoot(__dirname), timeout: 15000, env: { ...(options.environment || process.env), ELECTRON_RUN_AS_NODE: '1', MAGIC_POINTER_USER_DATA_DIR: path.resolve(options.root) } }];
}
function resultFor(kind: string, result: CommandResult): PreflightData {
  const data = lastJson(result.stdout), ok = result.status === 0 && data?.ok;
  if (kind === 'runtime') return ok ? { state: 'pass', evidence: `node=${data.node}; typescript_runtime_ready` } : { state: 'fail', evidence: 'node_runtime_unavailable', fixAction: 'repair_runtime' };
  if (kind === 'agents') { const providers = data?.providers?.filter((item: PreflightData) => item.available) || []; return ok && providers.length ? { state: 'pass', evidence: `available_agents=${providers.map((item: PreflightData) => item.id).join(',')}` } : { state: 'warn', evidence: 'agent_discovery_not_completed; configure_or_retry', fixAction: 'retry_agent_discovery' }; }
  return ok ? { state: 'pass', evidence: 'runtime_tool_contract_smoke_passed; real_pointer_context_packet_smoke_recommended', fixAction: 'run_desktop_smoke' } : { state: 'fail', evidence: 'runtime_tool_contract_smoke_failed', fixAction: 'inspect_diagnostics' };
}
function buildPreflightChecks(options: PreflightOptions) {
  const settings = options.settings || {}, platform = options.platform || process.platform;
  const command = (kind: string) => { const [file, args, opts] = commandInput(options, kind); const run = options.commandRunner || ((file: string, args: string[], opts: any) => { const result = spawnSync(file, args, { ...opts, encoding: 'utf8', windowsHide: true }); return { ...result, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') }; }); return resultFor(kind, run(file, args, opts)); };
  return {
    runtime: () => { try { writable(options.root); return command('runtime'); } catch (error) { return failed(error); } },
    os_permissions: () => platform === 'win32' ? { state: 'pass', evidence: 'windows_uia_host; screen_checked_in_separate_stage' } : { state: 'needs_user', evidence: `native_permission_review_required:${platform}`, fixAction: 'request_permission' },
    pointer_host: () => !options.wiggleDetector ? { state: 'fail', evidence: 'wiggle_detector_not_started', fixAction: 'restart_pointer_host' } : settings.activation?.wiggle_enabled === false && settings.activation?.fallback_hotkey_enabled !== true ? { state: 'needs_user', evidence: 'no_pointer_activation_enabled', fixAction: 'enable_activation' } : { state: 'pass', evidence: settings.activation?.wiggle_enabled === false ? 'fallback_hotkey_enabled' : 'wiggle_detector_ready' },
    grounding: () => ['desktop_perception.js', 'context_prepare.js'].every(name => fs.existsSync(path.join(options.projectRoot || resolveProjectRoot(__dirname), 'build', 'electron', 'runtime', name))) ? { state: 'pass', evidence: 'native_perception_and_task_context_present' } : { state: 'fail', evidence: 'grounding_runtime_missing', fixAction: 'repair_grounding_runtime' },
    agents: () => command('agents'),
    model_profile: () => { const profiles = settings.models?.profiles || []; if (!profiles.length) return { state: 'skipped', evidence: 'no_model_profile_configured' }; const profile = profiles.find((item: PreflightData) => item.enabled !== false) || profiles[0]; if (profile.apiMode === 'local') return { state: 'pass', evidence: `local_profile=${profile.id}` }; try { const credential = options.credentialStore?.status(profile.credentialRef); if (credential?.present && credential.available) return { state: 'pass', evidence: `credential_present_for=${profile.id}` }; } catch {} return { state: 'needs_user', evidence: `credential_missing_for=${profile.id}`, fixAction: 'save_credential' }; },
    privacy: () => { const privacy = settings.privacy || {}; return !String(privacy.default_capture_mode || '').trim() || !Array.isArray(privacy.sensitive_apps) ? { state: 'fail', evidence: 'privacy_policy_invalid', fixAction: 'review_privacy' } : { state: 'pass', evidence: `capture_mode=${privacy.default_capture_mode}; sensitive_rules=${privacy.sensitive_apps.length}` }; },
    e2e_smoke: () => command('smoke'),
  };
}
function runCommandAsync(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  return new Promise(resolve => {
    if (options.signal?.aborted) { resolve({ status: null, stdout: '', stderr: '', error: new Error('preflight_cancelled') }); return; }
    let stdout = '', stderr = '', settled = false, timedOut = false;
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const abort = () => child.kill(), timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeout || 15000);
    const finish = (status: number | null, error?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); resolve({ status, stdout, stderr, error }); };
    options.signal?.addEventListener('abort', abort, { once: true }); child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk).slice(-1048576); }); child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk).slice(-1048576); });
    child.on('error', (error: Error) => finish(null, error)); child.on('close', (code: number | null) => finish(timedOut || options.signal?.aborted ? null : code, timedOut ? new Error('preflight_command_timeout') : undefined)); child.stdin.on('error', () => {}); child.stdin.end(options.input == null ? undefined : String(options.input));
  });
}
function buildAsyncPreflightChecks(options: PreflightOptions) {
  const command = async (kind: string, signal?: AbortSignal) => { try { if (kind === 'runtime') writable(options.root); const [file, args, opts] = commandInput(options, kind); return resultFor(kind, await (options.asyncCommandRunner || runCommandAsync)(file, args, { ...opts, signal })); } catch (error) { return failed(error); } };
  return { ...buildPreflightChecks(options), runtime: (_stage: unknown, { signal }: { signal?: AbortSignal } = {}) => command('runtime', signal), agents: (_stage: unknown, { signal }: { signal?: AbortSignal } = {}) => command('agents', signal), e2e_smoke: (_stage: unknown, { signal }: { signal?: AbortSignal } = {}) => command('smoke', signal) };
}
module.exports = { buildPreflightChecks, buildAsyncPreflightChecks, runCommandAsync };
