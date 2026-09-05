'use strict';

interface EffortOption {
  value: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  label: string;
  description: string;
}

const EFFORT_LEVELS: readonly EffortOption[] = Object.freeze([
  Object.freeze({ value: 'low', label: 'Low', description: 'Quick replies to simple questions' }),
  Object.freeze({ value: 'medium', label: 'Medium', description: 'Light, casual tasks' }),
  Object.freeze({ value: 'high', label: 'High', description: 'Balanced for everyday work' }),
  Object.freeze({ value: 'xhigh', label: 'Extra', description: 'Complex, detailed work' }),
  Object.freeze({ value: 'max', label: 'Max', description: 'The hardest problems. Takes longest.' }),
]);

function normalizeEffort(value: unknown): EffortOption['value'] {
  const candidate = String(value ?? '').trim().toLowerCase();
  return EFFORT_LEVELS.some((option) => option.value === candidate)
    ? candidate as EffortOption['value']
    : 'high';
}

function effortOption(value: unknown): EffortOption {
  const normalized = normalizeEffort(value);
  return EFFORT_LEVELS.find((option) => option.value === normalized) ?? EFFORT_LEVELS[2];
}

const EffortLevels = { EFFORT_LEVELS, normalizeEffort, effortOption };
if (typeof module !== 'undefined' && module.exports) module.exports = EffortLevels;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { EffortLevels?: typeof EffortLevels }).EffortLevels = EffortLevels;
}
