'use client';

/**
 * Which file exports are in flight, shared by every mounted export menu.
 *
 * The classroom header's export menu can be mounted more than once over an
 * export's lifetime: the workspace shows it in the split header and in the
 * full-screen header, and toggling full screen swaps one for the other. Kept
 * in the export hooks' component state, an in-flight export would vanish from
 * the newly mounted menu (no spinner, items enabled) and a second export of
 * the same kind could start. Same reasoning as `video-render.ts`.
 */
import { create } from 'zustand';

export type ExportKind = 'pptx' | 'classroomZip' | 'html' | 'script';

interface ExportBusyState {
  readonly busy: Readonly<Record<ExportKind, boolean>>;
}

export const useExportBusyStore = create<ExportBusyState>(() => ({
  busy: { pptx: false, classroomZip: false, html: false, script: false },
}));

export function isExportBusy(kind: ExportKind): boolean {
  return useExportBusyStore.getState().busy[kind];
}

export function setExportBusy(kind: ExportKind, value: boolean): void {
  useExportBusyStore.setState((s) => ({ busy: { ...s.busy, [kind]: value } }));
}

/** Whether an export of this kind is running, in any mounted menu. */
export function useExportBusy(kind: ExportKind): boolean {
  return useExportBusyStore((s) => s.busy[kind]);
}
