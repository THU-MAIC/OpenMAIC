import { describe, expect, it } from 'vitest';
import {
  COURSE_STAGE_ID_DESCRIPTION,
  stageIdForCall,
} from '@/lib/server/agent-runtime/course-stage';

describe('stageIdForCall', () => {
  it('is deterministic for the same session/call pair', () => {
    expect(stageIdForCall('session-1', 'call-1')).toBe(stageIdForCall('session-1', 'call-1'));
  });

  it('differs across calls and sessions', () => {
    expect(stageIdForCall('session-1', 'call-1')).not.toBe(stageIdForCall('session-1', 'call-2'));
    expect(stageIdForCall('session-1', 'call-1')).not.toBe(stageIdForCall('session-2', 'call-1'));
  });

  it('produces a stable, prefixed id shape', () => {
    const id = stageIdForCall('session-1', 'call-1');
    expect(id).toMatch(/^stage-[A-Za-z0-9_-]{10}$/);
  });
});

describe('COURSE_STAGE_ID_DESCRIPTION', () => {
  it('is the shared model-visible wording', () => {
    expect(COURSE_STAGE_ID_DESCRIPTION).toContain('create_stage');
    expect(COURSE_STAGE_ID_DESCRIPTION).toContain('list_folder_stages');
  });
});
