/**
 * Provider-Neutral Live Tutor Turn & Practice Problem API
 *
 * POST:
 *  - `action === 'generate-problem'`: Generates a focused practice problem from
 *    the current classroom scene or topic so the teacher can ask the student to
 *    solve it on paper while guiding over camera.
 *  - `action === 'tutor-turn'`: Evaluates a camera snapshot + student question
 *    through OpenMAIC's configured `classroom` slot (`chat-adapter`) and returns
 *    a concise Socratic reply plus optional whiteboard steps/formulas.
 */
import { NextRequest } from 'next/server';
import type { ModelMessage } from 'ai';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess, modelAuthorizationResponse } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { modelSupportsVision } from '@/lib/live-tutor/model-capabilities';
import type { PracticeProblem, WhiteboardOp } from '@/lib/live-tutor/types';

const log = createLogger('LiveTutorTurn');

interface TurnHistoryItem {
  role: 'user' | 'assistant';
  text: string;
}

interface TurnRequest {
  action: 'generate-problem' | 'tutor-turn';
  topic?: string;
  sceneContext?: string;
  problem?: string;
  message?: string;
  imageDataUrl?: string;
  history?: TurnHistoryItem[];
  whiteboardSteps?: string[];
  language?: string;
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const rawBody: unknown = await req.json().catch(() => null);
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      return apiError('INVALID_REQUEST', 400, 'Invalid JSON request body');
    }
    const body = rawBody as TurnRequest;
    const resolved = await resolveModelFromRequest(req, body, 'chat-adapter');
    const { model: languageModel, thinkingConfig, serverManaged } = resolved;

    const langHint = body.language ? `Respond in locale "${body.language}".` : '';

    if (body.action === 'generate-problem') {
      const contextText = [
        body.topic ? `Topic: ${body.topic}` : '',
        body.sceneContext ? `Lesson context:\n${body.sceneContext.slice(0, 2000)}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      const systemPrompt = `You are a supportive classroom teacher assigning one clear, hands-on practice problem that a student can work out step by step in their notebook.
${langHint}
Reply with valid JSON only (no markdown fences):
{
  "statement": "<clear problem statement>",
  "hint": "<one gentle starting hint without giving away the answer>",
  "targetConcept": "<short concept name>",
  "formulaLatex": "<optional key LaTeX formula without surrounding $ signs, or empty string>"
}`;

      const result = await callLLM(
        {
          model: languageModel,
          system: systemPrompt,
          prompt:
            contextText || 'Create an engaging foundational math or science practice problem.',
          abortSignal: req.signal,
        },
        'chat-adapter',
        undefined,
        thinkingConfig,
        { serverManaged, preserveAbortSignal: true },
      );

      const parsed = extractJsonObject(result.text);
      const problem: PracticeProblem = {
        statement:
          typeof parsed?.statement === 'string' && parsed.statement.trim()
            ? parsed.statement.trim()
            : result.text.trim().slice(0, 400),
        hint: typeof parsed?.hint === 'string' ? parsed.hint.trim() : undefined,
        targetConcept:
          typeof parsed?.targetConcept === 'string' ? parsed.targetConcept.trim() : undefined,
        formulaLatex:
          typeof parsed?.formulaLatex === 'string' && parsed.formulaLatex.trim()
            ? parsed.formulaLatex.trim()
            : undefined,
      };

      return apiSuccess({ problem });
    }

    if (body.action === 'tutor-turn') {
      if (body.imageDataUrl && body.imageDataUrl.length > 8_000_000) {
        return apiError('INVALID_REQUEST', 413, 'Snapshot payload is too large');
      }
      const hasImage = Boolean(body.imageDataUrl && body.imageDataUrl.startsWith('data:image/'));
      if (hasImage && !modelSupportsVision(resolved.modelId, resolved.modelInfo?.capabilities?.vision)) {
        return apiError(
          'INVALID_REQUEST',
          400,
          'The configured classroom model does not support camera images. Switch to a vision-capable model in Settings → Model Services.',
        );
      }
      const systemPrompt = `You are a warm, patient Socratic teacher watching a student's physical notebook and guiding them step by step with a shared whiteboard.
${langHint}
Rules:
1. Praise what the student wrote correctly first.
2. Never blurt out the final answer immediately — point out the exact step to check and ask one short guiding question.
3. Keep spoken "reply" concise (1 to 3 sentences).
4. Whenever writing a step, key hint, LaTeX equation, or labeled vector diagram (triangles, rays, forces, shapes, graphs) on the whiteboard helps the student follow along, include it in "whiteboardOps". LaTeX formulas must NOT include surrounding $ or $$ delimiters. Diagrams must be self-contained <svg viewBox="0 0 600 340" xmlns="http://www.w3.org/2000/svg">...</svg> strings with no scripts.

Reply with valid JSON only:
{
  "reply": "<1-3 sentence encouraging spoken response>",
  "whiteboardOps": [
    { "op": "add_heading" | "add_step" | "add_formula" | "add_diagram" | "clear", "content": "<text, LaTeX, or SVG>", "caption": "<optional short caption for add_diagram>" }
  ]
}`;

      const contextLines = [
        body.topic ? `Topic: ${body.topic}` : '',
        body.problem ? `Assigned problem: ${body.problem}` : '',
        body.sceneContext ? `Lesson context: ${body.sceneContext.slice(0, 1500)}` : '',
        body.whiteboardSteps?.length
          ? `Current whiteboard items:\n- ${body.whiteboardSteps.slice(-8).join('\n- ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      const messages: ModelMessage[] = [];
      const historyItems = Array.isArray(body.history) ? body.history.slice(-8) : [];
      for (const h of historyItems) {
        if (!h || typeof h !== 'object' || typeof h.text !== 'string' || !h.text.trim()) continue;
        messages.push({
          role: h.role === 'assistant' ? 'assistant' : 'user',
          content: h.text.trim(),
        });
      }

      const userPromptText = [
        contextLines,
        body.message?.trim() || 'Please check my notebook work and guide my next step.',
      ]
        .filter(Boolean)
        .join('\n\n');

      if (hasImage) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: userPromptText },
            { type: 'image', image: body.imageDataUrl! },
          ],
        });
      } else {
        messages.push({
          role: 'user',
          content: userPromptText,
        });
      }

      const result = await callLLM(
        {
          model: languageModel,
          system: systemPrompt,
          messages,
          abortSignal: req.signal,
        },
        'chat-adapter',
        undefined,
        thinkingConfig,
        { serverManaged, enabled: !hasImage, preserveAbortSignal: true },
      );

      const parsed = extractJsonObject(result.text);
      const reply =
        typeof parsed?.reply === 'string' && parsed.reply.trim()
          ? parsed.reply.trim()
          : result.text.trim();

      const rawOps = Array.isArray(parsed?.whiteboardOps) ? parsed.whiteboardOps : [];
      const whiteboardOps: WhiteboardOp[] = [];
      for (const candidate of rawOps) {
        if (!candidate || typeof candidate !== 'object') continue;
        const opObj = candidate as { op?: string; content?: string; caption?: string };
        if (opObj.op === 'clear') {
          whiteboardOps.push({ op: 'clear' });
        } else if (
          (opObj.op === 'add_heading' ||
            opObj.op === 'add_step' ||
            opObj.op === 'add_formula' ||
            opObj.op === 'add_diagram') &&
          typeof opObj.content === 'string' &&
          opObj.content.trim()
        ) {
          whiteboardOps.push({
            op: opObj.op,
            content: opObj.content.trim(),
            ...(typeof opObj.caption === 'string' && opObj.caption.trim()
              ? { caption: opObj.caption.trim() }
              : {}),
          });
        }
      }

      return apiSuccess({ reply, whiteboardOps });
    }

    return apiError('INVALID_REQUEST', 400, 'Unsupported action');
  } catch (error) {
    const authorization = modelAuthorizationResponse(error);
    if (authorization) return authorization;
    log.error('Live tutor turn failed:', error);
    return apiError('INTERNAL_ERROR', 500, 'Live tutor request failed');
  }
}
