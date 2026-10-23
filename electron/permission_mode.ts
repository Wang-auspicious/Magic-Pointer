export const PERMISSION_MODES = {
  auto: 'accept_reversible',
  'read-only': 'safe',
  'workspace-write': 'default',
  plan: 'plan',
  'danger-full-access': 'bypass',
} as const;

export type PermissionPreset = keyof typeof PERMISSION_MODES;
export type PermissionMode = (typeof PERMISSION_MODES)[PermissionPreset];

export interface PermissionSelectionResult {
  ok: boolean;
  preset?: PermissionPreset;
  permissionMode?: PermissionMode;
  sessionId?: string;
  warning?: 'conversation_not_saved' | 'permission_save_unconfirmed';
  error?: string;
}

export function normalizePermissionPreset(
  value: unknown,
): PermissionPreset | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !Object.hasOwn(PERMISSION_MODES, value)) {
    throw new Error(`Unknown permission preset: ${String(value)}`);
  }
  return value as PermissionPreset;
}

export function presetForPermissionMode(
  mode: unknown,
): PermissionPreset | undefined {
  return (Object.keys(PERMISSION_MODES) as PermissionPreset[]).find(
    preset => PERMISSION_MODES[preset] === mode,
  );
}
