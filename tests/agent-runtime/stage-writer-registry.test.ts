import { describe, expect, it } from 'vitest';
import { STAGE_WRITER_TOOL_NAMES, isStageWriterTool } from '@/lib/agent-runtime/stage-writer-tools';
import { DOCUMENT_WRITING_TOOLS } from '@/lib/server/agent-runtime/course-tools';
import { DSL_COURSE_WRITE_TOOLS } from '@/lib/server/agent-runtime/dsl-tools';
import {
  buildCurriculumTools,
  type CurriculumToolDeps,
} from '@/lib/server/agent-runtime/curriculum-tools';

/**
 * The stage-writer registry is the single source of truth for "which agent
 * tools WRITE a stage document". The cross-module consistency assertions
 * against the server scheduler (`DOCUMENT_WRITING_TOOLS`) and the per-toolset
 * writer lists live here: the scheduler set must be exactly the shared list
 * minus `rename_stage`, and every per-toolset writer list must be contained in
 * the shared registry.
 */
describe('stage writer registry is the single source (R6-P1-1)', () => {
  it('every registered name is recognized as a writer', () => {
    for (const name of STAGE_WRITER_TOOL_NAMES) {
      expect(isStageWriterTool(name)).toBe(true);
    }
  });

  it('pins the exact writer set so scheduling/ownership cannot drift silently', () => {
    expect([...STAGE_WRITER_TOOL_NAMES].sort()).toEqual(
      [
        // course generation writers
        'set_roster',
        'generate_scene',
        'generate_actions',
        'duplicate_scene',
        'import_pptx',
        // course audio and page-list writers
        'generate_tts',
        'edit_deck',
        // generic stage-document writer
        'patch_stage',
        // curriculum writer (stage identity)
        'rename_stage',
      ].sort(),
    );
  });

  it('the server scheduler set is exactly the shared list minus rename_stage', () => {
    const expected = new Set(
      [...STAGE_WRITER_TOOL_NAMES].filter((name) => name !== 'rename_stage'),
    );
    expect(new Set(DOCUMENT_WRITING_TOOLS)).toEqual(expected);
  });

  it('every per-toolset writer list is contained in the shared registry', () => {
    for (const name of [...DSL_COURSE_WRITE_TOOLS]) {
      expect(isStageWriterTool(name)).toBe(true);
    }
    expect(isStageWriterTool('rename_stage')).toBe(true);
  });

  it('marks the curriculum writer rename_stage sequential', () => {
    const rename = buildCurriculumTools({} as CurriculumToolDeps).find(
      (tool) => tool.name === 'rename_stage',
    );
    expect(isStageWriterTool('rename_stage')).toBe(true);
    expect(rename?.executionMode).toBe('sequential');
  });

  it('reader tools are NOT writers — ownership must never arm on them', () => {
    for (const reader of [
      'read_stage',
      'grep_stage',
      'list_scenes',
      'read_stage_outline',
      'list_folder_stages',
      'render_scene_preview',
      'generate_image',
      'use_material_media',
      'generate_video',
    ]) {
      expect(isStageWriterTool(reader)).toBe(false);
    }
  });
});
