/**
 * The single source of truth for "which agent tools WRITE a stage document".
 *
 * Three consumers, one list:
 *  - the server scheduler (`DOCUMENT_WRITING_TOOLS` in course-tools.ts) marks
 *    these tools `executionMode: 'sequential'` so parallel writers cannot
 *    clobber each other (a consistency test pins the relation);
 *  - the workbench fold arms write ownership (veto + realtime sync) the moment
 *    one of these tools STARTS (`tool_execution_start` carries the target
 *    stageId in its args) — and deliberately NOT for reader tools:
 *    ownership's side effect is dropping the user's own pending edits, so a
 *    `read_stage` must never take it;
 *  - `rename_stage` is a writer for ownership purposes and is marked
 *    sequential in the curriculum toolset (it rewrites stage identity, not
 *    scene content, so it does not run through the course toolset scheduler).
 *
 * This module is shared between server and client code: keep it free of any
 * server-only imports.
 */
export const STAGE_WRITER_TOOL_NAMES: ReadonlySet<string> = new Set([
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
]);

export function isStageWriterTool(toolName: string): boolean {
  return STAGE_WRITER_TOOL_NAMES.has(toolName);
}
