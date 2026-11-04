/** Public configuration view. Management keys never leave the server. */
export interface SandboxSettingsFields {
  enabled: boolean;
  provider: 'e2b-compatible';
  connectionId: string;
  apiUrl: string;
  domain: string;
  template: string;
  desktopTemplate: string;
  lifetimeMs: number;
  maxActive: number;
  maxActivePerOwner: number;
}
export interface SandboxSettingsView {
  revision: number;
  source: 'deployment' | 'settings';
  locked: boolean;
  hasOverrides: boolean;
  fields: SandboxSettingsFields;
  keySet: boolean;
  keyUnreadable: boolean;
  configured: boolean;
  activeEnvironments: number;
  previewConfigured: boolean;
  checkpointConfigured: boolean;
}
