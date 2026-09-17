import { accessDocument } from '@/lib/document-store';

/** Course renames can update document metadata without touching the stage store. */
export async function resolveExportStageName(stage: {
  id: string;
  name?: string;
}): Promise<string> {
  const latest = await accessDocument(stage.id).catch(() => undefined);
  return latest?.document?.stage.name || stage.name || 'classroom';
}
