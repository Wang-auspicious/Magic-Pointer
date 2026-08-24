'use strict';

/* 权限预设（渲染层镜像）。
   执行真值在 app/agent_runtime/permission_presets.py：这里只负责展示与
   选择，桥对未知预设 fail-closed。custom 是派生展示态，不可选。 */

interface PresetOption {
  value: string;
  name: string;
  description: string;
  label: string;
  confirm?: { title: string; description: string };
}

const PRESETS: PresetOption[] = [
  {
    value: 'plan',
    name: '计划模式',
    label: '计划',
    description: '先只读研究并提交计划；你批准后才以写入权限执行。',
  },
  {
    value: 'read-only',
    name: '只读',
    label: '只读',
    description: '只允许读取；任何写入、发送或删除都要先经你确认。',
  },
  {
    value: 'workspace-write',
    name: '项目写入',
    label: '项目写入',
    description: '项目文件夹内的可逆写入直接执行；更大范围的操作需要确认。',
  },
  {
    value: 'danger-full-access',
    name: '完全访问',
    label: 'Full access',
    description: '完整文件访问，不再弹出确认提示。',
    confirm: {
      title: '确认启用 Full access？',
      description:
        '启用 Full access 后，agent 将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。',
    },
  },
];

const CUSTOM_OPTION: PresetOption = {
  value: 'custom',
  name: '自定义',
  label: '自定义',
  description: '当前权限设置不匹配任何预设。',
};

function optionOf(value: string): PresetOption | undefined {
  if (value === 'custom') return CUSTOM_OPTION;
  return PRESETS.find(option => option.value === value);
}

/** 与 Studio 其余控件一致的 24px / 1.5px 线性图标。 */
function presetSvg(option: PresetOption): string {
  const paths: Record<string, string> = {
    plan: 'M5 6h9M5 11h9M5 16h6M17 5v12M14.5 14.5 17 17l2.5-2.5',
    'read-only': 'M12 3 5 6v5.5c0 4 2.8 7.3 7 8.5 4.2-1.2 7-4.5 7-8.5V6l-7-3Zm-3 8.5 2 2 4-4',
    'workspace-write': 'M3 8a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Zm10.5 7.5 4-4 1.5 1.5-4 4-2 .5.5-2Z',
    'danger-full-access': 'M12 3 5 6v5.5c0 4 2.8 7.3 7 8.5 4.2-1.2 7-4.5 7-8.5V6l-7-3Zm0 5v5m0 3v.1',
    custom: 'M4 7h9m4 0h3M4 12h3m4 0h9M4 17h11m4 0h1M15 5v4M9 10v4m8 1v4',
  };
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[option.value] || paths.custom}" /></svg>`;
}

const PermissionPresets = { PRESETS, optionOf, presetSvg };
if (typeof module !== 'undefined' && module.exports) module.exports = PermissionPresets;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { PermissionPresets?: typeof PermissionPresets }).PermissionPresets = PermissionPresets;
}
