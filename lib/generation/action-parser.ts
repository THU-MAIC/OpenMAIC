/**
 * Action Parser - converts structured JSON Array output to Action[]
 *
 * Bridges the stateless-generate parser (used for online streaming) with the
 * offline generation pipeline, producing typed Action objects that preserve
 * the original interleaving order from the LLM output.
 *
 * For complete (non-streaming) responses, uses JSON.parse with partial-json
 * fallback for robustness.
 */

import type { Action, ActionType } from '@/lib/types/action';
import { SLIDE_ONLY_ACTIONS } from '@/lib/types/action';
import { nanoid } from 'nanoid';
import { parse as parsePartialJson, Allow } from 'partial-json';
import { jsonrepair } from 'jsonrepair';
import { createLogger } from '@/lib/logger';
const log = createLogger('ActionParser');

/**
 * Strip markdown code fences (```json ... ``` or ``` ... ```) from a response string.
 */
function stripCodeFences(text: string): string {
  // Remove opening ```json or ``` and closing ```
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '');
}

/**
 * Parse a complete LLM response in JSON Array format into an ordered Action[] array.
 *
 * Expected format (new):
 * [{"type":"action","name":"spotlight","params":{"elementId":"..."}},
 *  {"type":"text","content":"speech content"},...]
 *
 * Also supports legacy format:
 * [{"type":"action","tool_name":"spotlight","parameters":{"elementId":"..."}},...]
 *
 * Text items become `speech` actions; action items are converted to their
 * respective action types (spotlight, discussion, etc.).
 * The original interleaving order is preserved.
 */
export function parseActionsFromStructuredOutput(
  response: string,
  sceneType?: string,
  allowedActions?: string[],
): Action[] {
  // Step 1: Strip markdown code fences if present
  const cleaned = stripCodeFences(response.trim());

  // Step 2: Find the JSON array range
  const startIdx = cleaned.indexOf('[');
  const endIdx = cleaned.lastIndexOf(']');

  if (startIdx === -1) {
    log.warn('No JSON array found in response');
    return [];
  }

  const jsonStr = endIdx > startIdx ? cleaned.slice(startIdx, endIdx + 1) : cleaned.slice(startIdx); // unclosed array — let partial-json handle it

  // Step 3: Parse — try JSON.parse first, then jsonrepair, fallback to partial-json
  let items: unknown[];
  try {
    items = JSON.parse(jsonStr);
  } catch {
    // Try jsonrepair to fix malformed JSON (e.g. unescaped quotes in Chinese text)
    try {
      items = JSON.parse(jsonrepair(jsonStr));
      log.info('Recovered malformed JSON via jsonrepair');
    } catch {
      try {
        items = parsePartialJson(
          jsonStr,
          Allow.ARR | Allow.OBJ | Allow.STR | Allow.NUM | Allow.BOOL | Allow.NULL,
        );
      } catch (e) {
        log.warn('Failed to parse JSON array:', (e as Error).message);
        return [];
      }
    }
  }

  if (!Array.isArray(items)) {
    log.warn('Parsed result is not an array');
    return [];
  }

  // Step 4: Convert items to Action[]
  const actions: Action[] = [];

  for (const item of items) {
    if (!item || typeof item !== 'object' || !('type' in item)) continue;
    const typedItem = item as Record<string, unknown>;

    if (typedItem.type === 'text') {
      const text = ((typedItem.content as string) || '').trim();
      if (text) {
        actions.push({
          id: `action_${nanoid(8)}`,
          type: 'speech',
          text,
        });
      }
    } else if (typedItem.type === 'action') {
      try {
        // Support both new format (name/params) and legacy format (tool_name/parameters)
        const actionName = typedItem.name || typedItem.tool_name;
        const actionParams = (typedItem.params || typedItem.parameters || {}) as Record<
          string,
          unknown
        >;
        actions.push({
          id: (typedItem.action_id || typedItem.tool_id || `action_${nanoid(8)}`) as string,
          type: actionName as Action['type'],
          ...actionParams,
        } as Action);
      } catch (_e) {
        log.warn('Invalid action item, skipping:', JSON.stringify(typedItem).slice(0, 100));
      }
    }
  }

  // Step 5: Post-processing — discussion must be the last action, and at most one
  const discussionIdx = actions.findIndex((a) => a.type === 'discussion');
  if (discussionIdx !== -1 && discussionIdx < actions.length - 1) {
    actions.splice(discussionIdx + 1);
  }

  // Step 6: Filter out slide-only actions for non-slide scenes (defense in depth)
  let result = actions;
  if (sceneType && sceneType !== 'slide') {
    const before = result.length;
    result = result.filter((a) => !SLIDE_ONLY_ACTIONS.includes(a.type as ActionType));
    if (result.length < before) {
      log.info(`Stripped ${before - result.length} slide-only action(s) from ${sceneType} scene`);
    }
  }

  // Step 7: Filter by allowedActions whitelist (defense in depth for role-based isolation)
  // Catches hallucinated actions not in the agent's permitted set, e.g. a student agent
  // mimicking spotlight/laser after seeing teacher actions in chat history.
  if (allowedActions && allowedActions.length > 0) {
    const before = result.length;
    result = result.filter((a) => a.type === 'speech' || allowedActions.includes(a.type));
    if (result.length < before) {
      log.info(
        `Stripped ${before - result.length} disallowed action(s) by allowedActions whitelist`,
      );
    }
  }

  return result;
}
