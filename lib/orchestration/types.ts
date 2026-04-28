/**
 * Shared types for orchestration: whiteboard action ledger + agent turn summaries.
 *
 * These types describe runtime data structures used by the director, prompt builders,
 * summarizers, and the LangGraph runner. They're imported widely, so they live in
 * a neutral module rather than alongside any single consumer.
 */

/**
 * A single whiteboard action performed by an agent, recorded in the ledger.
 */
export interface WhiteboardActionRecord {
  actionName:
    | 'wb_draw_text'
    | 'wb_draw_shape'
    | 'wb_draw_chart'
    | 'wb_draw_latex'
    | 'wb_draw_table'
    | 'wb_draw_line'
    | 'wb_draw_code'
    | 'wb_edit_code'
    | 'wb_clear'
    | 'wb_delete'
    | 'wb_open'
    | 'wb_close';
  agentId: string;
  agentName: string;
  params: Record<string, unknown>;
}

/**
 * Summary of an agent's turn in the current round.
 */
export interface AgentTurnSummary {
  agentId: string;
  agentName: string;
  contentPreview: string;
  actionCount: number;
  whiteboardActions: WhiteboardActionRecord[];
}
