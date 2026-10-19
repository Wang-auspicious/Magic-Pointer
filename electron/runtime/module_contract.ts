export interface ModsActionField {
  name: string;
  label: string;
  type: 'text' | 'number';
  value?: string | number;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
}
export interface ModsPanelAction {
  id: string;
  label: string;
  disabled?: boolean;
  primary?: boolean;
  fields?: ModsActionField[];
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
  inputs?: Record<string, string | number>;
}
export interface ModuleAgentRequest {
  moduleId: string;
  moduleTitle: string;
  actionLabel: string;
  toolName: string;
  arguments: Record<string, unknown>;
}
export interface ModuleActionResult extends ModuleWorkspaceSnapshot {
  result?: {text?: string; panelId?: string};
  agentRequest?: ModuleAgentRequest;
  usedBackend?: string;
  timingMs?: number;
}
export interface ModuleRequestContext {
  moduleId: string;
  text: string;
}
