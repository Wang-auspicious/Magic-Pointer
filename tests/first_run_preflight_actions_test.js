const assert = require('assert');
const fs = require('fs');

const js = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
const css = fs.readFileSync('electron/renderer/dashboard.css', 'utf8');

for (const label of [
  '等待检查',
  '正在检查',
  '已通过',
  '需要留意',
  '未通过',
  '已跳过',
  '需要设置',
  '状态未知',
]) {
  assert(js.includes(label), `human preflight label: ${label}`);
}

for (const fixAction of [
  'install_python',
  'repair_runtime',
  'request_permission',
  'restart_pointer_host',
  'enable_activation',
  'request_microphone_permission',
  'repair_grounding_runtime',
  'retry_agent_discovery',
  'save_credential',
  'review_privacy',
  'run_desktop_smoke',
  'inspect_diagnostics',
]) {
  assert(js.includes(fixAction), `fixAction guidance: ${fixAction}`);
}

for (const target of ["targetView: 'activation'", "targetView: 'voice'", "targetView: 'agents'", "targetView: 'models'", "targetView: 'privacy'"]) {
  assert(js.includes(target), `local navigation mapping: ${target}`);
}

assert(js.includes('preflight-guidance'), 'a human guidance line is rendered');
assert(js.includes('preflight-action'), 'fixable rows render a button');
assert(js.includes('setActiveView(action.targetView)'), 'local fix buttons navigate to the relevant settings');
assert(js.includes('preflight-evidence'), 'raw evidence is disclosed separately');
assert(!js.includes('state.textContent = stage.state'), 'raw machine states are not shown to first users');
assert(css.includes('.preflight-guidance'));
assert(css.includes('.preflight-action'));
assert(css.includes('.preflight-evidence'));

console.log('first-run preflight action test ok');
