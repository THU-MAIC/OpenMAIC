/** Local-only protocol shared by the desktop shell and the sync route. */
export const DESKTOP_SETTINGS_SYNC_VERSION = 2;
export const DESKTOP_SETTINGS_SYNC_HEADER = 'x-openmaic-desktop-sync';

export type DesktopSyncAction =
  | { action: 'create' }
  | { action: 'register'; id: string }
  | { action: 'apply'; id: string }
  | { action: 'confirm'; id: string };

export function isDesktopSyncAction(value: unknown): value is DesktopSyncAction {
  if (!value || typeof value !== 'object') return false;
  const body = value as { action?: unknown; id?: unknown };
  if (body.action === 'create') return body.id === undefined;
  return (
    (body.action === 'register' || body.action === 'apply' || body.action === 'confirm') &&
    typeof body.id === 'string' &&
    body.id.length > 0 &&
    body.id.length <= 128
  );
}
