'use strict';

(() => {
type SettingOption = { label: string; value: string | number };
type SettingRow = {
  control: 'toggle' | 'select' | 'range' | 'text' | 'tags' | 'info';
  description?: string;
  infoKey?: 'active-model' | 'credential' | 'terminal';
  label: string;
  max?: number;
  min?: number;
  options?: SettingOption[];
  path?: string;
  step?: number;
};
type SettingSection = { title: string; rows: SettingRow[] };
type SettingsPage = { description: string; group: '设置' | 'Agent' | '自定义'; icon: string; id: string; sections: SettingSection[]; title: string };

const option = (value: string | number, label: string): SettingOption => ({ value, label });

const SETTINGS_PAGES: SettingsPage[] = [
  { id: 'general', group: '设置', icon: 'ic-window', title: '通用', description: '启动、后台与更新。', sections: [
    { title: '运行', rows: [
      { path: 'general.launch_at_login', control: 'toggle', label: '开机时启动', description: '登录后静默驻留。' },
      { path: 'general.keep_running', control: 'toggle', label: '关闭窗口后继续运行', description: '划线与快捷键仍然可用。' },
    ] },
    { title: '更新', rows: [
      { path: 'general.update_channel', control: 'select', label: '更新通道', options: [option('stable', '稳定'), option('preview', '预览')] },
    ] },
  ] },
  { id: 'interaction', group: '设置', icon: 'ic-cursor', title: '交互', description: '怎么唤起、怎么输入，以及全局快捷键。', sections: [
    { title: '唤起', rows: [
      { path: 'activation.wake_mode', control: 'select', label: '唤起方式', options: [option('wiggle_hotkey', '晃动 + 快捷键'), option('wiggle', '只用晃动'), option('hotkey', '只用快捷键'), option('mouse_button', '鼠标侧键')] },
      { path: 'activation.sensitivity', control: 'range', label: '晃动灵敏度', min: 0, max: 1, step: 0.05 },
      { path: 'activation.gesture_arm_delay_ms', control: 'select', label: '长按判定', options: [option(120, '120 ms'), option(180, '180 ms'), option(240, '240 ms'), option(320, '320 ms')] },
      { path: 'activation.mouse_side_button', control: 'select', label: '鼠标按键', options: [option('none', '不使用'), option('xbutton1', '侧键 1'), option('xbutton2', '侧键 2'), option('middle_hold', '按住中键')] },
      { path: 'activation.keep_current_app_focus', control: 'toggle', label: '目标窗口切走时暂停' },
      { path: 'activation.disabled_apps', control: 'tags', label: '不唤起的应用', description: '用逗号分隔进程名或应用名。' },
    ] },
    { title: '默认输入', rows: [
      { path: 'interaction.default_input_mode', control: 'select', label: '划线后先用', options: [option('text', '键盘输入'), option('voice', '语音输入')] },
    ] },
    { title: '快捷键', rows: [
      { path: 'shortcuts.wake', control: 'text', label: '唤起' },
      { path: 'shortcuts.text_mode', control: 'text', label: '直接键盘输入' },
      { path: 'shortcuts.voice_mode', control: 'text', label: '直接语音输入' },
      { path: 'shortcuts.pause', control: 'text', label: '暂停输入' },
    ] },
  ] },
  { id: 'voice', group: '设置', icon: 'ic-mic', title: '语音', description: '语音是可选输入方式；关闭后不会启动语音模型。', sections: [
    { title: '语音输入', rows: [
      { path: 'interaction.voice_enabled', control: 'toggle', label: '启用语音输入', description: '关闭后默认输入强制为键盘，并隐藏普通语音入口。' },
      { path: 'interaction.voice_engine', control: 'select', label: '本地引擎', options: [option('auto', '自动'), option('sense_voice', 'SenseVoice'), option('whisper', 'Whisper')] },
      { path: 'interaction.voice_language', control: 'select', label: '语言', options: [option('auto', '自动'), option('zh', '中文'), option('en', '英语'), option('ja', '日语'), option('ko', '韩语')] },
      { path: 'interaction.voice_silence_ms', control: 'select', label: '静音多久算说完', options: [option(1000, '1.0 秒'), option(1600, '1.6 秒'), option(2400, '2.4 秒')] },
      { path: 'interaction.voice_auto_submit', control: 'toggle', label: '转写完成后自动提交' },
    ] },
    { title: '性能', rows: [
      { path: 'interaction.voice_resident_enabled', control: 'toggle', label: '让语音模型常驻内存' },
      { path: 'interaction.voice_idle_unload_ms', control: 'select', label: '闲置后卸载', options: [option(0, '不自动卸载'), option(300000, '5 分钟'), option(900000, '15 分钟')] },
      { path: 'interaction.voice_memory_limit_mb', control: 'select', label: '内存上限', options: [option(512, '512 MB'), option(1024, '1 GB'), option(2048, '2 GB')] },
    ] },
  ] },
  { id: 'models-agents', group: 'Agent', icon: 'ic-spark', title: '模型与 Agent', description: '选择推理模型与 Magic Pointer 自有 Runtime 的工作方式。', sections: [
    { title: '模型', rows: [
      { control: 'info', infoKey: 'active-model', label: '当前默认模型', description: '普通回答与卡片内展开都使用这一档。' },
      { control: 'info', infoKey: 'credential', label: '模型密钥', description: '只显示是否存在，永不回显原文。' },
      { control: 'info', infoKey: 'terminal', label: '安全配置', description: '在项目终端运行；输入过程不会回显密钥。' },
    ] },
    { title: 'Agent', rows: [
      { path: 'agents.preferred', control: 'select', label: '首选 Agent', options: [option('pi', 'Pi'), option('codex', 'Codex'), option('claude', 'Claude Code'), option('gemini', 'Gemini CLI')] },
      { path: 'agents.delivery_mode', control: 'select', label: '交付方式', options: [option('active_session', '当前会话'), option('managed_session', '托管会话'), option('clipboard', '只复制 Prompt')] },
      { path: 'agents.cwd_match', control: 'select', label: '项目目录匹配', options: [option('strict', '必须完全一致'), option('subtree', '允许子目录'), option('confirm', '不一致时询问')] },
      { path: 'agents.auto_attach', control: 'toggle', label: '自动附加接地证据' },
    ] },
  ] },
  { id: 'perception-privacy', group: 'Agent', icon: 'ic-eye', title: '感知与隐私', description: '它能看什么、画面能否出本机，以及哪些应用永远不看。', sections: [
    { title: '读取', rows: [
      { path: 'privacy.default_capture_mode', control: 'select', label: '默认读取方式', options: [option('follow_global', '自动'), option('structured_only', '只用结构层'), option('local_screenshot', '只在本机看画面'), option('deny', '完全不读')] },
      { path: 'privacy.upload_screenshots', control: 'toggle', label: '允许把画面发给视觉模型' },
    ] },
    { title: '边界', rows: [
      { path: 'privacy.sensitive_apps', control: 'tags', label: '完全不看的应用', description: '不读、不截，也不记。' },
    ] },
    { title: '浏览器', rows: [
      { path: 'connections.browser_devtools_enabled', control: 'toggle', label: '读取已授权的浏览器页面' },
      { path: 'connections.browser_devtools_endpoints', control: 'tags', label: '本机调试端点', description: '只接受 localhost/127.0.0.1。' },
    ] },
  ] },
  { id: 'permissions', group: 'Agent', icon: 'ic-shield', title: '权限', description: '按后果决定直接做、先问还是拒绝。', sections: [
    { title: '默认策略', rows: [
      { path: 'permissions.default_read', control: 'select', label: '读取', options: [option('allow', '直接做'), option('confirm', '每次问我'), option('deny', '拒绝')] },
      { path: 'permissions.default_write', control: 'select', label: '写入', options: [option('allow', '直接做'), option('confirm', '每次问我'), option('deny', '拒绝')] },
      { path: 'permissions.default_send', control: 'select', label: '对外发送', options: [option('confirm', '每次问我'), option('deny', '一律拒绝')] },
      { path: 'permissions.default_destructive', control: 'select', label: '删除或覆盖', options: [option('confirm', '确认后执行'), option('deny', '一律拒绝')] },
      { path: 'permissions.default_purchase', control: 'select', label: '购买与付款', options: [option('confirm', '确认后执行'), option('deny', '一律拒绝')] },
    ] },
    { title: '临时授权', rows: [
      { control: 'info', label: '范围授权', description: '只展示仍有效的应用、项目和到期时间；默认拒绝新增。' },
    ] },
  ] },
  { id: 'memory-context', group: '自定义', icon: 'ic-memory', title: '记忆与上下文', description: '决定 Agent 能记住什么，并查看已经形成的本地上下文。', sections: [
    { title: '记忆', rows: [
      { path: 'privacy.screen_memory_enabled', control: 'toggle', label: '记住处理过的对象', description: '在本机保存应用、窗口和问题摘要，供之后的任务召回。' },
      { path: 'privacy.background_learning_enabled', control: 'toggle', label: '生成学习建议', description: '任务结束后生成候选记忆；应用前仍需你批准。' },
    ] },
    { title: '上下文', rows: [
      { control: 'info', label: '项目上下文', description: '项目文件夹、当前对话与已批准记忆会一起进入 Agent 上下文。' },
      { control: 'info', label: '自动压缩', description: '长任务接近上下文窗口时，由 Runtime 保留目标、决定与未完成工作。' },
    ] },
  ] },
  { id: 'storage', group: '自定义', icon: 'ic-stash', title: '存储', description: '收藏、截图、产物与审计在本机如何保存。', sections: [
    { title: '收藏箱', rows: [
      { path: 'stash.dir', control: 'text', label: '保存目录' },
      { path: 'stash.clipboard', control: 'toggle', label: '自动收藏剪贴板图片' },
      { path: 'stash.text', control: 'toggle', label: '自动收藏剪贴板文字' },
      { path: 'stash.burst_window_ms', control: 'select', label: '归为同一组的时间', options: [option(30000, '30 秒'), option(120000, '2 分钟'), option(600000, '10 分钟')] },
    ] },
    { title: '保留期', rows: [
      { path: 'privacy.retain_captures_days', control: 'select', label: '截图与选区', options: [option(1, '1 天'), option(3, '3 天'), option(7, '7 天'), option(0, '永久')] },
      { path: 'privacy.retain_artifacts_days', control: 'select', label: '生成的产物', options: [option(7, '7 天'), option(30, '30 天'), option(90, '90 天'), option(0, '永久')] },
    ] },
  ] },
  { id: 'appearance-accessibility', group: '自定义', icon: 'ic-img', title: '外观', description: '主题和划线反馈。', sections: [
    { title: '外观', rows: [
      { path: 'appearance.theme', control: 'select', label: '主题', options: [option('system', '跟随系统'), option('light', '浅色'), option('dark', '深色')] },
      { path: 'appearance.material', control: 'select', label: '窗口材质', options: [option('auto', '自动'), option('translucent', '半透明'), option('solid', '不透明')] },
      { path: 'appearance.selection_visual', control: 'select', label: '选区反馈', options: [option('sweep_band', '扫线'), option('soft_glow', '柔光'), option('outline', '描边')] },
      { path: 'appearance.sweep_height_ratio', control: 'range', label: '扫线高度', min: 0.15, max: 1.5, step: 0.05 },
    ] },
    { title: '窗口', rows: [
      { path: 'accessibility.reduce_transparency', control: 'toggle', label: '减少透明效果' },
    ] },
  ] },
];

function valueForSetting(path: string, settings: Record<string, any>) {
  return path.split('.').reduce((node: any, part) => node == null ? undefined : node[part], settings);
}

function nestedPatch(path: string, value: unknown) {
  const root: Record<string, any> = {};
  const parts = path.split('.');
  let node = root;
  parts.forEach((part, index) => {
    node[part] = index === parts.length - 1 ? value : {};
    node = node[part];
  });
  return root;
}

function patchForSetting(path: string, value: unknown) {
  if (path === 'interaction.voice_enabled' && value !== true) {
    return { interaction: { voice_enabled: false, default_input_mode: 'text', voice_resident_enabled: false } };
  }
  if (path === 'interaction.default_input_mode' && value === 'voice') {
    return { interaction: { default_input_mode: 'voice', voice_enabled: true } };
  }
  if (path === 'interaction.voice_resident_enabled' && value === true) {
    return { interaction: { voice_resident_enabled: true, voice_enabled: true } };
  }
  return nestedPatch(path, value);
}

function modelInfoValue(key: string, status: Record<string, any>) {
  if (key === 'active-model') {
    if (!status?.configured) return '未配置';
    return String(status.displayName || status.model || status.provider || '已配置');
  }
  if (key === 'credential') {
    if (!status?.configured) return '等待模型档案';
    if (!status.credentialBackendAvailable) return '系统安全存储不可用';
    return status.credentialPresent ? '已安全保存' : '未配置';
  }
  if (key === 'terminal') return 'npm run model:groq';
  return '只读';
}

const SettingsModel = { SETTINGS_PAGES, modelInfoValue, patchForSetting, valueForSetting };
if (typeof module !== 'undefined' && module.exports) module.exports = SettingsModel;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { SettingsModel?: typeof SettingsModel }).SettingsModel = SettingsModel;
}
})();
