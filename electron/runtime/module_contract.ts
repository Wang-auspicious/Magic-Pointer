export interface ModsPanelAction {
  id: string;
  label: string;
  disabled?: boolean;
  primary?: boolean;
}
export interface ModsPanelRow {
  id: string;
  label: string;
  value?: string;
  tone?: 'neutral' | 'success' | 'warning' | 'error';
}
export interface ModsPanel {
  id: string;
  moduleId: string;
  title: string;
  description?: string;
  status: {
    state: 'ready' | 'running' | 'error' | 'disabled';
    label?: string;
    detail?: string;
  };
  sections: Array<{
    id: string;
    title?: string;
    rows: ModsPanelRow[];
    actions?: ModsPanelAction[];
  }>;
}
export interface ModuleContribution {
  id: string;
  title: string;
  description?: string;
  status: 'active' | 'error';
  commands: Array<{id: string; label: string; description?: string}>;
  panels: ModsPanel[];
}
export interface ModuleWorkspaceSnapshot {
  ok: boolean;
  sessionId: string;
  modules: ModuleContribution[];
  errors: Array<{moduleId?: string; message: string}>;
  error?: string;
}
export interface ModuleActionRequest {
  sessionId: string;
  moduleId: string;
  panelId: string;
  actionId: string;
}
export interface ModuleActionResult extends ModuleWorkspaceSnapshot {
  result?: {text?: string; panelId?: string};
  usedBackend?: string;
  timingMs?: number;
}
export interface ModuleRequestContext {
  moduleId: string;
  text: string;
}
