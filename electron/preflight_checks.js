const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  pythonInvocationArgs,
  pythonSpawnEnvironment,
  resolvePythonRuntime,
} = require('./python_runtime');
const { projectRoot: resolveProjectRoot } = require('./runtime_paths');

function lastJson(value) {
  try { return JSON.parse(String(value || '').trim()); } catch (_) {}
  for (const line of String(value || '').split(/\r?\n/).reverse()) {
    try { return JSON.parse(line); } catch (_) {}
  }
  return null;
}

function buildPreflightChecks({
  root,
  projectRoot = resolveProjectRoot(__dirname),
  settings = {},
  credentialStore = null,
  wiggleDetector = null,
  microphoneStatus = () => 'unknown',
  commandRunner = (command, args, options) => spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options }),
  platform = process.platform,
  pythonRuntime = resolvePythonRuntime({ platform }),
  environment = process.env,
}) {
  const userRoot = path.resolve(root);
  const python = String(pythonRuntime?.executable || '').trim();
  const bundledPythonRequired = pythonRuntime?.required === true;
  const command = (args, input = undefined) => commandRunner(
    python,
    pythonInvocationArgs(args, { isolated: bundledPythonRequired }),
    {
      cwd: projectRoot,
      timeout: 15000,
      input,
      env: {
        ...pythonSpawnEnvironment({ env: environment, isolated: bundledPythonRequired }),
        MAGIC_POINTER_USER_DATA_DIR: userRoot,
      },
    },
  );
  return {
    runtime: () => {
      try {
        fs.mkdirSync(userRoot, { recursive: true });
        const probe = path.join(userRoot, `.preflight-${process.pid}.tmp`);
        fs.writeFileSync(probe, 'ok', { encoding: 'utf8', mode: 0o600 });
        fs.unlinkSync(probe);
        const version = command(['--version']);
        if (!python || version.status !== 0) {
          return bundledPythonRequired
            ? { state: 'fail', evidence: 'bundled_python_runtime_unavailable', fixAction: 'repair_runtime' }
            : { state: 'fail', evidence: 'python_runtime_unavailable', fixAction: 'install_python' };
        }
        return { state: 'pass', evidence: `node=${process.versions.node}; python=${String(version.stdout || version.stderr || '').trim().slice(0, 120)}` };
      } catch (error) {
        return { state: 'fail', evidence: `runtime_check_failed:${error.name}`, fixAction: 'repair_runtime' };
      }
    },
    os_permissions: () => {
      if (platform === 'win32') return { state: 'pass', evidence: 'windows_uia_host; screen_and_microphone_checked_in_separate_stages' };
      return { state: 'needs_user', evidence: `native_permission_review_required:${platform}`, fixAction: 'request_permission' };
    },
    pointer_host: () => {
      const activation = settings.activation || {};
      if (!wiggleDetector) return { state: 'fail', evidence: 'wiggle_detector_not_started', fixAction: 'restart_pointer_host' };
      if (activation.wiggle_enabled === false && activation.fallback_hotkey_enabled !== true) {
        return { state: 'needs_user', evidence: 'no_pointer_activation_enabled', fixAction: 'enable_activation' };
      }
      return { state: 'pass', evidence: activation.wiggle_enabled === false ? 'fallback_hotkey_enabled' : 'wiggle_detector_ready' };
    },
    voice: () => {
      const status = String(microphoneStatus() || 'unknown').toLowerCase();
      if (status === 'granted') return { state: 'pass', evidence: 'microphone_permission_granted; local_voice_runtime_configured' };
      return { state: 'needs_user', evidence: `microphone_permission_${status}`, fixAction: 'request_microphone_permission' };
    },
    grounding: () => {
      const selectionBridge = path.join(projectRoot, 'scripts', 'selection_bridge.py');
      const contextPacket = path.join(projectRoot, 'app', 'fabric', 'context_packet.py');
      if (fs.existsSync(selectionBridge) && fs.existsSync(contextPacket)) return { state: 'pass', evidence: 'selection_bridge_and_context_packet_present' };
      return { state: 'fail', evidence: 'grounding_runtime_missing', fixAction: 'repair_grounding_runtime' };
    },
    agents: () => {
      const result = command([path.join('scripts', 'fabric_bridge.py')], JSON.stringify({ operation: 'providers' }));
      if (result.status === 0) {
        const parsed = lastJson(result.stdout);
        if (parsed?.ok && Array.isArray(parsed.providers) && parsed.providers.some((item) => item.available)) {
          return { state: 'pass', evidence: `available_agents=${parsed.providers.filter((item) => item.available).map((item) => item.id).join(',')}` };
        }
      }
      return { state: 'warn', evidence: 'agent_discovery_not_completed; configure_or_retry', fixAction: 'retry_agent_discovery' };
    },
    model_profile: () => {
      const profiles = Array.isArray(settings.models?.profiles) ? settings.models.profiles : [];
      if (!profiles.length) return { state: 'skipped', evidence: 'no_model_profile_configured' };
      const profile = profiles.find((item) => item.enabled !== false) || profiles[0];
      if (profile.apiMode === 'local') return { state: 'pass', evidence: `local_profile=${profile.id}` };
      try {
        const credential = credentialStore?.status(profile.credentialRef);
        if (credential?.present && credential.available) return { state: 'pass', evidence: `credential_present_for=${profile.id}` };
      } catch (_) {}
      return { state: 'needs_user', evidence: `credential_missing_for=${profile.id}`, fixAction: 'save_credential' };
    },
    privacy: () => {
      const privacy = settings.privacy || {};
      if (!String(privacy.default_capture_mode || '').trim() || !Array.isArray(privacy.sensitive_apps)) {
        return { state: 'fail', evidence: 'privacy_policy_invalid', fixAction: 'review_privacy' };
      }
      return { state: 'pass', evidence: `capture_mode=${privacy.default_capture_mode}; sensitive_rules=${privacy.sensitive_apps.length}` };
    },
    e2e_smoke: () => {
      const result = command([path.join('scripts', 'smoke_fabric.py')]);
      const parsed = lastJson(result.stdout);
      if (result.status === 0 && parsed?.ok === true) {
        return { state: 'pass', evidence: 'deterministic_fabric_smoke_passed; real_pointer_voice_context_packet_smoke_recommended', fixAction: 'run_desktop_smoke' };
      }
      return { state: 'fail', evidence: 'deterministic_fabric_smoke_failed', fixAction: 'inspect_diagnostics' };
    },
  };
}

function runCommandAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Math.max(1, Number(options.timeout || 15000));
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer = null;
    const signal = options.signal || null;
    let abortListener = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
      resolve(result);
    };
    if (signal?.aborted === true) {
      finish({ status: null, stdout, stderr, error: new Error('preflight_cancelled') });
      return;
    }
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ status: null, stdout, stderr, error });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (_) {}
    }, timeoutMs);
    abortListener = () => {
      try { child.kill(); } catch (_) {}
    };
    if (signal) signal.addEventListener('abort', abortListener, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-1024 * 1024); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-1024 * 1024); });
    child.on('error', (error) => finish({ status: null, stdout, stderr, error }));
    child.on('close', (status) => finish({
      status: timedOut ? null : status,
      stdout,
      stderr,
      error: timedOut ? new Error('preflight_command_timeout') : null,
    }));
    child.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE') finish({ status: null, stdout, stderr, error });
    });
    child.stdin.end(options.input == null ? undefined : String(options.input));
  });
}

function buildAsyncPreflightChecks({
  root,
  projectRoot = resolveProjectRoot(__dirname),
  settings = {},
  credentialStore = null,
  wiggleDetector = null,
  microphoneStatus = () => 'unknown',
  asyncCommandRunner = runCommandAsync,
  platform = process.platform,
  pythonRuntime = resolvePythonRuntime({ platform }),
  environment = process.env,
}) {
  const baseChecks = buildPreflightChecks({
    root,
    projectRoot,
    settings,
    credentialStore,
    wiggleDetector,
    microphoneStatus,
    platform,
    pythonRuntime,
    environment,
  });
  const userRoot = path.resolve(root);
  const python = String(pythonRuntime?.executable || '').trim();
  const bundledPythonRequired = pythonRuntime?.required === true;
  const command = (args, input = undefined, signal = null) => asyncCommandRunner(
    python,
    pythonInvocationArgs(args, { isolated: bundledPythonRequired }),
    {
      cwd: projectRoot,
      timeout: 15000,
      input,
      signal,
      env: {
        ...pythonSpawnEnvironment({ env: environment, isolated: bundledPythonRequired }),
        MAGIC_POINTER_USER_DATA_DIR: userRoot,
      },
    },
  );

  return {
    ...baseChecks,
    runtime: async (_stage, { signal } = {}) => {
      try {
        fs.mkdirSync(userRoot, { recursive: true });
        const probe = path.join(userRoot, `.preflight-${process.pid}.tmp`);
        fs.writeFileSync(probe, 'ok', { encoding: 'utf8', mode: 0o600 });
        fs.unlinkSync(probe);
        const version = await command(['--version'], undefined, signal);
        if (!python || version.status !== 0) {
          return bundledPythonRequired
            ? { state: 'fail', evidence: 'bundled_python_runtime_unavailable', fixAction: 'repair_runtime' }
            : { state: 'fail', evidence: 'python_runtime_unavailable', fixAction: 'install_python' };
        }
        return {
          state: 'pass',
          evidence: `node=${process.versions.node}; python=${String(version.stdout || version.stderr || '').trim().slice(0, 120)}`,
        };
      } catch (error) {
        return { state: 'fail', evidence: `runtime_check_failed:${error.name}`, fixAction: 'repair_runtime' };
      }
    },
    agents: async (_stage, { signal } = {}) => {
      const result = await command(
        [path.join('scripts', 'fabric_bridge.py')],
        JSON.stringify({ operation: 'providers' }),
        signal,
      );
      if (result.status === 0) {
        const parsed = lastJson(result.stdout);
        if (parsed?.ok && Array.isArray(parsed.providers) && parsed.providers.some((item) => item.available)) {
          return {
            state: 'pass',
            evidence: `available_agents=${parsed.providers.filter((item) => item.available).map((item) => item.id).join(',')}`,
          };
        }
      }
      return {
        state: 'warn',
        evidence: 'agent_discovery_not_completed; configure_or_retry',
        fixAction: 'retry_agent_discovery',
      };
    },
    e2e_smoke: async (_stage, { signal } = {}) => {
      const result = await command([path.join('scripts', 'smoke_fabric.py')], undefined, signal);
      const parsed = lastJson(result.stdout);
      if (result.status === 0 && parsed?.ok === true) {
        return {
          state: 'pass',
          evidence: 'deterministic_fabric_smoke_passed; real_pointer_voice_context_packet_smoke_recommended',
          fixAction: 'run_desktop_smoke',
        };
      }
      return {
        state: 'fail',
        evidence: 'deterministic_fabric_smoke_failed',
        fixAction: 'inspect_diagnostics',
      };
    },
  };
}

module.exports = {
  buildAsyncPreflightChecks,
  buildPreflightChecks,
  runCommandAsync,
};
