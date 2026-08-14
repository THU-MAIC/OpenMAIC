import { z } from 'zod';

export const RUNTIME_DIAGNOSTIC_CODES = [
  'interactive-load-failure',
  'interactive-load-timeout',
  'interactive-ready-failure',
  'interactive-ready-timeout',
  'interactive-runtime-failure',
] as const;

export const RuntimeDiagnosticCodeSchema = z.enum(RUNTIME_DIAGNOSTIC_CODES);
export type RuntimeDiagnosticCode = z.infer<typeof RuntimeDiagnosticCodeSchema>;

export const RuntimeDiagnosticSchema = z.object({
  sceneId: z.string().min(1),
  code: RuntimeDiagnosticCodeSchema,
  message: z.string().max(1200),
});
export type RuntimeDiagnostic = z.infer<typeof RuntimeDiagnosticSchema>;
