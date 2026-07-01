/**
 * POST /api/pbl/v2/task/update
 *
 * Pure state-mutation endpoint for the workspace UI. Operates on the
 * `PBLProjectV2` the client sends and returns the mutated project so
 * the client can persist it locally.
 *
 * Actions:
 *   - `start`             — mark a microtask in_progress (used when the
 *                            learner clicks a sidebar microtask).
 *   - `continue_handover` — after a milestone wrap, click Continue to
 *                            activate the next milestone's first task.
 *   - `complete_pending_task`
 *                         — learner clicks the sidebar Done button after the
 *                            current task reached the manual completion point.
 *
 * No LLM involvement. Stateless.
 */

export const maxDuration = 60;

import type { NextRequest } from 'next/server';

import { apiError, apiSuccess } from '@/lib/server/api-response';

import {
  startMicrotask,
  continueAfterHandover,
  currentMicrotask,
  advanceMicrotask,
  completeRoleplayAct,
  appendTaskDividerMessage,
} from '@/lib/pbl/v2/operations/progress';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import { currentPendingTaskCompletion } from '@/lib/pbl/v2/operations/task-completion';

interface UpdateRequest {
  project: PBLProjectV2;
  action:
    | 'start'
    | 'continue_handover'
    | 'enter_scenario'
    | 'complete_act'
    | 'complete_pending_task';
  microtaskId?: string;
}

export async function POST(req: NextRequest) {
  let body: UpdateRequest;
  try {
    body = (await req.json()) as UpdateRequest;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Request body must be valid JSON.');
  }
  if (!body?.project) {
    return apiError('MISSING_REQUIRED_FIELD', 400, '`project` is required.');
  }

  const project = body.project;

  switch (body.action) {
    case 'start': {
      if (!body.microtaskId) {
        return apiError('MISSING_REQUIRED_FIELD', 400, '`microtaskId` is required for start.');
      }
      startMicrotask(project, body.microtaskId);
      return apiSuccess({ project });
    }
    case 'continue_handover': {
      const r = continueAfterHandover(project);
      if (!r.ok) {
        return apiError('INVALID_REQUEST', 400, 'No pending handover to consume.');
      }
      return apiSuccess({ project, activatedMicrotaskId: r.activatedMicrotaskId });
    }
    case 'complete_pending_task': {
      const current = currentMicrotask(project);
      if (!current) {
        return apiError('INVALID_REQUEST', 400, 'No active microtask to complete.');
      }
      const pending = currentPendingTaskCompletion(project, current.microtask.id);
      if (!pending) {
        return apiError('INVALID_REQUEST', 400, 'No pending task completion to confirm.');
      }
      const adv = advanceMicrotask(
        project,
        current.microtask.id,
        pending.reason,
        pending.assessment ?? {},
      );
      if (!adv.ok) {
        return apiError('INVALID_REQUEST', 400, `Could not complete task: ${adv.error}`);
      }
      const nextTask = adv.nextMicrotaskId
        ? current.milestone.microtasks.find((task) => task.id === adv.nextMicrotaskId)
        : undefined;
      appendTaskDividerMessage(project, {
        completedMicrotaskId: current.microtask.id,
        nextMicrotaskId: adv.nextMicrotaskId,
        completedTitle: current.microtask.title,
        nextTitle: nextTask?.title,
      });
      return apiSuccess({
        project,
        completedMicrotaskId: current.microtask.id,
        milestoneId: current.milestone.id,
        milestoneCompleted: adv.milestoneCompleted,
        projectCompleted: adv.projectCompleted,
        nextMicrotaskId: adv.nextMicrotaskId,
      });
    }
    // SCENARIO ONLY. The learner clicked "enter scenario" under the prep
    // stage in the sidebar. Deterministically complete the prep stage and
    // cross into the (first) scene stage: this completes the prep
    // microtask → seals the prep milestone + stages the handover →
    // consumes the handover to activate the scene stage and emit the
    // stage divider. No LLM, no milestone eval (prep is a pure intro).
    // Strictly gated to a scenario prep stage; otherwise rejected so it
    // can never affect ordinary projects.
    case 'enter_scenario': {
      if (!project.scenario) {
        return apiError('INVALID_REQUEST', 400, 'Not a scenario project.');
      }
      const current = currentMicrotask(project);
      if (!current || current.milestone.scenarioStage !== 'prep') {
        return apiError('INVALID_REQUEST', 400, 'No active scenario prep stage to advance.');
      }
      const adv = advanceMicrotask(project, current.microtask.id, 'entered_scenario', {});
      if (!adv.ok) {
        return apiError('INVALID_REQUEST', 400, `Could not complete prep stage: ${adv.error}`);
      }
      // If the prep stage was the last milestone (no scene after it), there
      // is no handover to consume — but that is an incoherent scenario the
      // generator/validator already prevents. Consume the handover into the
      // scene stage when present.
      const cont = continueAfterHandover(project);
      return apiSuccess({
        project,
        activatedMicrotaskId: cont.ok ? cont.activatedMicrotaskId : undefined,
      });
    }
    // SCENARIO ONLY (act model). The learner clicked "finish this act" in the
    // sidebar. Deterministically completes the ENTIRE active roleplay
    // milestone (all its checkpoint beats at once) and stages the handover for
    // the "next stage" button. No LLM, no per-beat judgement — checkpoint
    // achievement is scored later by the final evaluator. Strictly gated to a
    // scenario roleplay stage; rejected otherwise so ordinary projects and
    // prep/wrapup are never affected.
    case 'complete_act': {
      if (!project.scenario) {
        return apiError('INVALID_REQUEST', 400, 'Not a scenario project.');
      }
      const r = completeRoleplayAct(project, 'act_completed_by_learner');
      if (!r.ok) {
        return apiError('INVALID_REQUEST', 400, `Could not finish act: ${r.error}`);
      }
      return apiSuccess({ project });
    }
    default:
      return apiError('INVALID_REQUEST', 400, `Unknown action: ${String(body.action)}`);
  }
}
