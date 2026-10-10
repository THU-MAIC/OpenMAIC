import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const stageSource = readFileSync(join(process.cwd(), 'components/stage.tsx'), 'utf8');

describe('interactive repair entry wiring', () => {
  it('hands writable standalone/playback failures into the workspace', () => {
    expect(stageSource).toContain('stageInteractiveRepairHandoff');
    expect(stageSource).toContain('proWorkbenchEntry && stage?.id');
    expect(stageSource).toContain(
      'router.replace(workspaceHref({ sessionId: null, courseId: stage.id }))',
    );
    expect(stageSource).toContain('useWorkbenchStore.getState().setPlaybackOn(false)');
  });

  it('keeps the repair mutation behind the writable-stage gate', () => {
    expect(stageSource).toContain('const requestInteractiveRepair = canEditOwnedStage');
  });
});
