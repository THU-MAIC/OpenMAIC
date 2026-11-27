import { z } from 'zod';

/** A portable voice binding contains identifiers only. Hosts resolve their own provider settings. */
export const voiceConfigSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    modelId: z.string().min(1).max(128).optional(),
    voiceId: z.string().min(1).max(256),
  })
  .strict();
