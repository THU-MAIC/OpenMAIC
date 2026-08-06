/**
 * PBL v2 — Planner Agent
 *
 * Designs a complete PBLProjectV2 from an outline-stage `pblConfig`
 * plus the wider course context. Replaces v1's `lib/pbl/generate-pbl.ts`
 * agentic loop (4 modes / 22 tools / role-selection model) with a
 * single-pass, single-mode agentic loop that emits the v2 schema
 * (milestones / microtasks / single Instructor role / structured
 * scripts).
 *
 * The Planner does not ask the user about intent and does not pause
 * for skeleton confirmation. By the time it runs, the outline stage
 * has already inferred the project topic into `outline.pblConfig` and
 * the student is not in the loop.
 *
 * Technology: Vercel AI SDK `generateText` + `tool` + `stopWhen` —
 * the same range v1 uses, kept identical so the upgrade path is
 * incremental.
 */

import type { LanguageModel, StepResult, StopCondition, ToolSet } from 'ai';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';

import { createLogger } from '@/lib/logger';
import { normalizeProjectRuntime, normalizeScenario } from '../operations/kernel/progress';
import type { ThinkingConfig } from '@/lib/types/provider';

import {
  SCENARIO_SCHEMA_VERSION,
  PlannerV2Error,
  emptyProject,
  buildPlannerSystemPrompt,
  newId,
  instructorProjectAnchor,
  applyPlannerProficiency,
  normalizeSynthesisChecks,
  plannerCompletionGaps,
  type PlannerV2Callbacks,
} from './planner-core';

import type {
  PBLProjectV2,
  PBLPlannerV2Input,
  PBLMilestone,
  PBLMicrotask,
  PBLRole,
  PBLScenarioConfig,
} from '../types';

const log = createLogger('PBL v2 Planner');

/** Narrow call seam used by the tool-calling planner. */
export type PlannerCallFn = (
  params: {
    model: LanguageModel;
    system: string;
    prompt: string;
    tools: ToolSet;
    stopWhen: StopCondition<ToolSet>[];
    onStepFinish: (step: Pick<StepResult<ToolSet>, 'toolCalls'>) => void;
  },
  source: 'pbl-v2-planner',
  retryOptions: undefined,
  thinkingConfig?: ThinkingConfig,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Loop budgets
// ---------------------------------------------------------------------------

/** Max tool-call steps in one Planner run. Generous so the LLM can
 *  emit set-info + role + ~4 milestones × (1 milestone + 4 microtasks)
 *  + done, with headroom for retries on validation
 *  errors. */
const MAX_PLANNER_STEPS = 80;

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Run the v2 Planner agentic loop and return a complete `PBLProjectV2`.
 *
 * Caller responsibility: pass a `LanguageModel` instance and (for
 * thinking-capable models) a `ThinkingConfig`. The Planner does not
 * choose models or providers — it inherits whatever the course
 * generation pipeline already resolved.
 *
 * Throws `PlannerV2Error` if the model finished without producing a
 * usable project (no Instructor role or no milestones with
 * microtasks). The caller should treat that as a fatal v2 failure and
 * fall back.
 */
export async function generatePBLV2Project(
  input: PBLPlannerV2Input,
  model: LanguageModel,
  callLLM: PlannerCallFn,
  callbacks?: PlannerV2Callbacks,
  thinkingConfig?: ThinkingConfig,
): Promise<PBLProjectV2> {
  // Pull all the fields the prompt needs out of the input bundle so the
  // template substitution is explicit rather than passing `input` as a
  // big object — the prompt is reviewed by humans, every variable name
  // matters.
  const pblConfig = input.outline.pblConfig;
  if (!pblConfig) {
    throw new PlannerV2Error(
      'Planner v2 invoked on an outline without pblConfig — this is a generation pipeline bug.',
      emptyProject(input),
    );
  }

  // Mutable shared state. Tools mutate this; we hand the final value
  // back at the end. Avoids the "tool returns partial JSON" pattern
  // which is harder to validate. `emptyProject` also computes the
  // initial proficiency assessment from static signals.
  const project = emptyProject(input);

  // SCENARIO ONLY opt-in. When the outline marks this PBL as a role-play
  // scenario (`pblConfig.scenarioRoleplay === true`), the Planner
  // additionally designs a cast (`set_scenario`), a scene milestone
  // (`add_milestone({ scene: true })`), and per-beat fields
  // (`add_microtask({ completionCriteria, successWhen, ... })`). When
  // absent / false this is an ordinary PBL project and every prompt /
  // tool surface below is byte-identical to before.
  const scenarioRoleplay = pblConfig.scenarioRoleplay === true;

  // Content language comes solely from `languageDirective` (the outline's
  // natural-language language policy). No code-side locale guessing or guard —
  // the prompt's Hard rule 1 carries it. Falls back to a neutral instruction
  // only when the outline gave no directive at all.
  const contentLanguage =
    project.languageDirective || 'Match the language of the outline content above.';
  const systemPrompt = await buildPlannerSystemPrompt(
    input,
    project.proficiency,
    contentLanguage,
    scenarioRoleplay,
  );

  // Tool implementations. Each one validates its inputs, mutates
  // `project`, fires a progress event, and returns a small result the
  // LLM uses to continue (the result is what's serialized into the
  // tool-call message that the LLM sees on the next turn).
  const tools = buildTools(project, input, scenarioRoleplay, callbacks);

  log.info(
    `Starting Planner v2: topic="${pblConfig.projectTopic}", proficiency="${input.outline.pblConfig?.issueCount ?? '?'} milestones suggested"`,
  );

  // The agentic loop. The Planner emits tool calls until
  // `mark_design_complete` is accepted by the completion gate, or
  // until the defensive step budget is hit.
  await callLLM(
    {
      model,
      system: systemPrompt,
      prompt:
        'Design the PBL project now. Call the tools in the documented order; do not write narrative text.',
      tools,
      stopWhen: [plannerDesignAccepted(), stepCountIs(MAX_PLANNER_STEPS)],
      onStepFinish: ({ toolCalls }) => {
        // Optional verbose log. Keep at debug-level so production
        // logs don't drown in tool noise.
        if (toolCalls?.length) {
          for (const tc of toolCalls) {
            log.debug(`tool call: ${tc.toolName}`);
          }
        }
      },
    },
    'pbl-v2-planner',
    undefined,
    thinkingConfig,
  );

  normalizeProjectRuntime(project);
  normalizeSynthesisChecks(project);
  // Scenario-aware validation: when scenario mode was requested, require
  // a coherent cast + scene milestone (throws → existing fallback). For
  // ordinary projects this is byte-identical to before.
  validateProject(project, scenarioRoleplay);
  // SCENARIO ONLY safety net. After validation the scenario is coherent,
  // so this only assigns any missing character ids / is a no-op; it's
  // kept here for idempotency with the load path.
  normalizeScenario(project);
  log.info(
    `Planner v2 done: ${project.milestones.length} milestones, ${project.milestones.reduce(
      (acc, m) => acc + m.microtasks.length,
      0,
    )} microtasks, ${project.roles.length} roles.`,
  );

  return project;
}

function buildTools(
  project: PBLProjectV2,
  input: PBLPlannerV2Input,
  scenarioRoleplay: boolean,
  callbacks?: PlannerV2Callbacks,
) {
  // Track whether `set_project_info` has fired so we can require it
  // before downstream tools. The LLM should call them in order
  // anyway (the prompt says so), but we enforce server-side for
  // robustness.
  let projectInfoSet = false;
  let instructorRoleAdded = false;
  let milestoneIndex = 0;
  // SCENARIO ONLY. Whether `set_scenario` has fired. Always false for
  // ordinary PBL projects (the tool isn't even registered).
  let scenarioSet = false;

  // SCENARIO ONLY schema extensions. For ordinary PBL projects the
  // milestone / microtask input schemas below are byte-identical to
  // before (none of these params are exposed to the model).
  const milestoneScenarioStageField = scenarioRoleplay
    ? {
        scenarioStage: z
          .enum(['prep', 'roleplay', 'wrapup'])
          .optional()
          .describe(
            "SCENARIO ONLY. The milestone's role in the fixed three-stage skeleton: 'prep' = FIRST milestone (Instructor introduces the premise + cast, no assessment); 'roleplay' = an immersive role-play stage (one or more, in the middle); 'wrapup' = LAST milestone (Instructor light feedback). Order MUST be prep → roleplay(s) → wrapup.",
          ),
      }
    : {};
  const microtaskSceneFields = scenarioRoleplay
    ? {
        completionCriteria: z
          .string()
          .optional()
          .describe(
            "SCENARIO ONLY (scene beats). A concrete, observable condition that advances this beat. Only for microtasks under a `scenarioStage:'roleplay'` milestone.",
          ),
        successWhen: z
          .string()
          .optional()
          .describe(
            'SCENARIO ONLY (scene beats). The CONCRETE, OBSERVABLE in-scene action the learner must SAY or DO for this beat to count as done — the scenario\'s "deliverable" (e.g. "下注、加注或弃牌" / "对对方的感受做出共情回应，并问一个跟进问题"). Plain scene terms, NOT a teaching goal. This is what the advance detector watches, so small-talk / off-topic turns do NOT advance. Author one for EVERY roleplay beat.',
          ),
        characterObjective: z
          .string()
          .optional()
          .describe(
            'SCENARIO ONLY (scene beats). What the character PRIVATELY wants this beat — their in-scene drive (e.g. "试探对方是否在虚张声势" / "想知道你是否真的在乎"). Gives the character a goal to pursue in character. NEVER narrated, evaluated, or coached. Recommended for every roleplay beat.',
          ),
        skillFocus: z
          .string()
          .optional()
          .describe(
            'SCENARIO ONLY (scene beats). The single skill this beat practises (e.g. "底池赔率判断" / "积极倾听"). Surfaced to the learner (current-task panel + end-of-project per-act review); never spoken by the character.',
          ),
        narration: z
          .string()
          .optional()
          .describe(
            'SCENARIO ONLY (scene beats). Neutral system narration shown when this beat opens (e.g. "you walk into a quiet café"). Not spoken by a character or the Instructor. Omit if no narration.',
          ),
      }
    : {};

  const baseTools = {
    /** Set the top-level project info. Must be called exactly once
     *  before any other tool. */
    set_project_info: tool({
      description:
        'Set the project title, description, learning objective, learner gains, and proficiency tier. Call this exactly once, before any other tool. ALL TEXT FIELDS must be written in the project language declared in the system prompt (Hard rule 1), and title/description/learningObjective/gains must derive directly from the outline\'s project topic — do NOT substitute a different "common teaching project" from your training data.',
      inputSchema: z.object({
        title: z
          .string()
          .min(1)
          .describe(
            'Concise, memorable project title — IN THE PROJECT LANGUAGE; must match the outline.pblConfig.projectTopic theme exactly (no topic substitution).',
          ),
        description: z
          .string()
          .min(1)
          .describe(
            '2-4 sentence description of what the student will build — IN THE PROJECT LANGUAGE; must be about the outline.pblConfig.projectTopic, not a different example project.',
          ),
        learningObjective: z
          .string()
          .describe(
            'The specific verb/skill the student will master, IN THE PROJECT LANGUAGE. Distinct from `description` (which is what they BUILD).',
          ),
        gains: z
          .array(z.string().min(1))
          .min(3)
          .max(5)
          .describe(
            'A SHORT list (3-5) of learner-facing "what you\'ll gain" statements shown on the project Hero, IN THE PROJECT LANGUAGE. Each names ONE ability, awareness, or piece of knowledge the learner BUILDS by working through the project — what they take away and can do afterwards — NOT the final deliverable/result the project produces (that is `description`). Write each as a readable competency phrase, typically by expanding one terse outline targetSkill into plain language (e.g. for 博弈论: "理解纳什均衡的含义并能在具体场景中求解", "学会用收益矩阵刻画双方策略与收益", "培养把现实冲突抽象成博弈模型的建模意识"). NOT a task title, NOT a single terse keyword, NOT the project\'s end product. They must match THIS project.',
          ),
        proficiency: z
          .enum(['beginner', 'intermediate', 'advanced'])
          .describe('Inferred from outline context: how much prior knowledge to assume.'),
      }),
      execute: async ({ title, description, learningObjective, gains, proficiency }) => {
        if (projectInfoSet) {
          return {
            ok: false,
            error: 'set_project_info was already called; it must only fire once.',
          };
        }
        project.title = title;
        project.description = description;
        project.learningObjective = learningObjective;
        project.gains = gains;
        // If the learner explicitly stated their level in the course
        // request/profile ("我是零基础", "I'm advanced", etc.), the
        // deterministic detector is authoritative. The Planner may
        // adapt project shape, but it cannot override that explicit
        // self-report.
        const explicitTierLocked =
          project.proficiencyAssessment?.signals[0]?.kind === 'user_level_explicit';
        if (explicitTierLocked && proficiency !== project.proficiencyAssessment!.tier) {
          return {
            ok: false,
            error: `The learner explicitly stated their level as ${project.proficiencyAssessment!.tier}. Call set_project_info again with proficiency="${project.proficiencyAssessment!.tier}".`,
          };
        }
        applyPlannerProficiency(project, proficiency);
        project.updatedAt = new Date().toISOString();
        projectInfoSet = true;
        callbacks?.onProgress?.({ kind: 'project_info', title });
        return { ok: true, title };
      },
    }),

    /** Add a role. The product currently ships a single Instructor.
     *  The tool refuses any other role type at the boundary so the v2
     *  project never gets half-populated with un-wired roles. */
    add_role: tool({
      description:
        'Add a role for the project. Call exactly once with type=instructor. Do not create any other role type.',
      inputSchema: z.object({
        type: z.enum(['instructor', 'user']),
        name: z.string().min(1),
        description: z
          .string()
          .optional()
          .describe(
            "SHORT learner-facing intro shown as a hover tooltip on the instructor's avatar. 2-3 short sentences MAX, in the project language, written TO the learner: who the guide is (use the name), that they accompany you through the whole project and each task, that you can ask them anything anytime, and that they give feedback / check your understanding along the way. Keep it warm and specific to THIS project. Do NOT expose internal mechanics (reading history, tool calls, evaluation / scoring, advancing tasks) — only what is meaningful and reassuring to a learner.",
          ),
        systemPrompt: z.string().optional(),
      }),
      execute: async ({ type, name, description, systemPrompt }) => {
        if (!projectInfoSet) {
          return {
            ok: false,
            error: 'Call set_project_info first.',
          };
        }
        if (type === 'instructor' && instructorRoleAdded) {
          return {
            ok: false,
            error: 'Instructor role already exists; only one Instructor allowed.',
          };
        }
        if (type !== 'instructor') {
          // Only the Instructor is wired. Refuse any other role type at
          // the boundary so the v2 project never gets a half-populated,
          // un-rendered role.
          return {
            ok: false,
            error: `Role type "${type}" is not supported. Only type=instructor is accepted.`,
          };
        }
        const anchoredSystemPrompt = [systemPrompt, instructorProjectAnchor(project)]
          .filter(Boolean)
          .join('\n\n');
        const role: PBLRole = {
          id: newId('role'),
          type,
          name,
          description,
          systemPrompt: anchoredSystemPrompt,
        };
        project.roles.push(role);
        project.updatedAt = new Date().toISOString();
        instructorRoleAdded = true;
        callbacks?.onProgress?.({ kind: 'role', roleType: type, name });
        return { ok: true, roleId: role.id };
      },
    }),

    /** Add a milestone. Returns its ID for use in add_microtask.
     *  The first milestone added becomes ACTIVE so the
     *  student lands in a runnable state. */
    add_milestone: tool({
      description:
        'Add a milestone (major phase). Provide a title, short description, and the three Instructor scripts: briefing, completionCriteria, debrief.',
      inputSchema: z.object({
        title: z.string().min(1),
        description: z.string().min(1),
        briefing: z
          .string()
          .min(1)
          .describe(
            'Written in Instructor voice, second person — what the Instructor will say at the start of this milestone.',
          ),
        completionCriteria: z
          .string()
          .min(1)
          .describe('How the Instructor will know the student is done with this milestone.'),
        debrief: z
          .string()
          .min(1)
          .describe(
            'Written in Instructor voice — what the Instructor will say at the end of this milestone.',
          ),
        coreConcept: z
          .string()
          .optional()
          .describe(
            'Set this ONLY for the 1-2 stages that carry the project\'s CORE knowledge point. A short description (in the project language) of the central concept this stage teaches — e.g. "为什么循环能避免重复代码". When set, the Instructor runs ONE integrative reverse-question about this concept at the end of the stage. Leave UNSET for ordinary / setup / polish stages so learners are not over-questioned. (For SCENARIO projects, never set this — see scenario mode.)',
          ),
        ...milestoneScenarioStageField,
      }),
      execute: async (args) => {
        if (!instructorRoleAdded) {
          return {
            ok: false,
            error: 'Call add_role for the Instructor before adding milestones.',
          };
        }
        const coreConcept = args.coreConcept?.trim();
        // SCENARIO ONLY. Only honour `scenarioStage` for scenario
        // projects; the field isn't even exposed to ordinary projects'
        // Planner.
        const scenarioStage = scenarioRoleplay
          ? (args as { scenarioStage?: 'prep' | 'roleplay' | 'wrapup' }).scenarioStage
          : undefined;
        const milestone: PBLMilestone = {
          id: newId('ms'),
          title: args.title,
          description: args.description,
          status: project.milestones.length === 0 ? 'active' : 'locked',
          order: milestoneIndex++,
          microtasks: [],
          briefing: args.briefing,
          completionCriteria: args.completionCriteria,
          debrief: args.debrief,
          ...(coreConcept ? { synthesisCheck: { coreConcept } } : {}),
          ...(scenarioStage ? { scenarioStage } : {}),
        };
        project.milestones.push(milestone);
        project.updatedAt = new Date().toISOString();
        callbacks?.onProgress?.({
          kind: 'milestone',
          title: args.title,
          index: milestone.order,
        });
        return { ok: true, milestoneId: milestone.id };
      },
    }),

    /** Add a microtask under a milestone. Order is auto-assigned
     *  unless `order` is given. */
    add_microtask: tool({
      description:
        'Add a microtask under a milestone. Each microtask must be specific and actionable.',
      inputSchema: z.object({
        milestoneId: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        hints: z
          .array(z.string())
          .max(5)
          .optional()
          .describe('1-3 concrete hints the Instructor can offer.'),
        order: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Position within the milestone. Auto-assigned if absent.'),
        ...microtaskSceneFields,
      }),
      execute: async (args) => {
        const milestone = project.milestones.find((m) => m.id === args.milestoneId);
        if (!milestone) {
          return {
            ok: false,
            error: `Milestone "${args.milestoneId}" not found. Call add_milestone first.`,
          };
        }
        const order = args.order ?? milestone.microtasks.length;
        // SCENARIO ONLY. Beat fields are only exposed/honoured for
        // scenario projects; ordinary microtasks never carry them.
        const sceneArgs = args as {
          completionCriteria?: string;
          successWhen?: string;
          characterObjective?: string;
          skillFocus?: string;
          narration?: string;
        };
        const beatCriteria = scenarioRoleplay ? sceneArgs.completionCriteria?.trim() : undefined;
        const beatSuccessWhen = scenarioRoleplay ? sceneArgs.successWhen?.trim() : undefined;
        const beatObjective = scenarioRoleplay ? sceneArgs.characterObjective?.trim() : undefined;
        const beatSkill = scenarioRoleplay ? sceneArgs.skillFocus?.trim() : undefined;
        const beatNarration = scenarioRoleplay ? sceneArgs.narration?.trim() : undefined;
        const microtask: PBLMicrotask = {
          id: newId('mt'),
          title: args.title,
          description: args.description,
          status: 'todo',
          // Collaborator was removed from the product — every microtask
          // is learner-owned.
          assignee: 'user',
          hints: args.hints ?? [],
          order,
          ...(beatCriteria ? { completionCriteria: beatCriteria } : {}),
          ...(beatSuccessWhen ? { successWhen: beatSuccessWhen } : {}),
          ...(beatObjective ? { characterObjective: beatObjective } : {}),
          ...(beatSkill ? { skillFocus: beatSkill } : {}),
          ...(beatNarration ? { narration: beatNarration } : {}),
        };
        milestone.microtasks.push(microtask);
        project.updatedAt = new Date().toISOString();
        callbacks?.onProgress?.({
          kind: 'microtask',
          milestoneTitle: milestone.title,
          title: args.title,
          index: order,
        });
        return { ok: true, microtaskId: microtask.id };
      },
    }),

    /** Signal that design is complete. The Planner *must* call this
     *  at the very end. We validate here before the SDK loop is
     *  allowed to stop, so an early / partial completion attempt is
     *  rejected and fed back to the model as concrete gaps instead of
     *  falling out to the v1 generator. */
    mark_design_complete: tool({
      description:
        'Call this exactly once at the very end, after every milestone, microtask, and role has been added. Signals the design is complete.',
      inputSchema: z.object({}),
      execute: async (): Promise<PlannerCompletionToolResult> => {
        const gaps = plannerCompletionGaps(project, { scenarioRoleplay });
        if (gaps.length > 0) {
          return {
            ok: false,
            gaps,
            nextAction: plannerCompletionNextAction(project, { scenarioRoleplay }),
          };
        }

        // Bootstrap a single Instructor thread so PR 4 (Workspace)
        // has a stable thread to render from. The Instructor's
        // opening message is added later, by /api/pbl/v2/open-task
        // GREETING — we just create the empty container here.
        const instructor = project.roles.find((r) => r.type === 'instructor');
        if (instructor && !project.threads.some((t) => t.agentId === instructor.id)) {
          project.threads.push({
            agentId: instructor.id,
            messages: [],
          });
        }
        project.status = 'active';
        project.uiPhase = 'hero';
        project.updatedAt = new Date().toISOString();

        const microtaskCount = project.milestones.reduce((acc, m) => acc + m.microtasks.length, 0);
        callbacks?.onProgress?.({
          kind: 'complete',
          milestoneCount: project.milestones.length,
          microtaskCount,
        });
        return { ok: true };
      },
    }),
  };

  // Ordinary PBL projects: tool surface is byte-identical to before.
  if (!scenarioRoleplay) return baseTools;

  // SCENARIO ONLY. Register the cast-authoring tool. Defines
  // `project.scenario` (the single gate) + stamps `schemaVersion`.
  const set_scenario = tool({
    description:
      'SCENARIO ONLY. Define the role-play scenario: the concrete premise (setting), optional learning goal, optional rules + learner role, and the cast. Call exactly once, right after set_project_info and before any add_milestone. Required for scenario projects.',
    inputSchema: z.object({
      setting: z
        .string()
        .min(1)
        .describe('The concrete overall premise / what is going on, in the project language.'),
      goal: z
        .string()
        .optional()
        .describe('What the learner is practising (used by wrapup / completion page).'),
      rules: z
        .string()
        .optional()
        .describe(
          'Rules / structure the learner must be told before the scene (games / interviews / debates). Omit for free emotional scenarios.',
        ),
      learnerRole: z
        .string()
        .optional()
        .describe(
          'The learner\'s OWN role / position (e.g. "you are their close friend" / "you are the 5th player, on the button").',
        ),
      characters: z
        .array(
          z.object({
            name: z.string().min(1).describe('Character name, in the project language.'),
            persona: z
              .string()
              .min(1)
              .describe(
                'Stable identity / relationship to the learner / personality / speaking style. In the project language.',
              ),
            situation: z
              .string()
              .min(1)
              .describe(
                'This character\'s CONCRETE current circumstance the learner faces (e.g. "just broke up, low mood, says they\'re fine but aren\'t"; game: "sits under-the-gun, plays tight"). In the project language. Required — it is the premise the Instructor introduces and is shown to the learner up front. Include ONLY what the learner knows/sees at the start; never put in here a fact a later roleplay beat is meant to make them discover (put that in that beat\'s characterObjective).',
              ),
            boundaries: z
              .string()
              .optional()
              .describe(
                'Hard safety rails: what the character must never say or do. Strongly recommended.',
              ),
            openingLine: z
              .string()
              .optional()
              .describe("The character's first line when the scene opens (optional)."),
          }),
        )
        .min(1)
        .describe(
          'The cast — EXACTLY ONE character (this version voices a single counterpart throughout).',
        ),
    }),
    execute: async (args) => {
      if (!projectInfoSet) {
        return { ok: false, error: 'Call set_project_info first.' };
      }
      if (scenarioSet) {
        return {
          ok: false,
          error: 'set_scenario was already called; it must only fire once.',
        };
      }
      const scenario: PBLScenarioConfig = {
        setting: args.setting,
        ...(args.goal?.trim() ? { goal: args.goal.trim() } : {}),
        ...(args.rules?.trim() ? { rules: args.rules.trim() } : {}),
        ...(args.learnerRole?.trim() ? { learnerRole: args.learnerRole.trim() } : {}),
        // HARD CONSTRAINT: single character only (runtime voices characters[0]).
        // Deterministically keep the first even if the model produced more.
        characters: args.characters.slice(0, 1).map((c) => ({
          id: newId('char'),
          name: c.name,
          persona: c.persona,
          ...(c.situation?.trim() ? { situation: c.situation.trim() } : {}),
          ...(c.boundaries?.trim() ? { boundaries: c.boundaries.trim() } : {}),
          ...(c.openingLine?.trim() ? { openingLine: c.openingLine.trim() } : {}),
        })),
      };
      project.scenario = scenario;
      // Stamp the packaged-format version so future migrations have a
      // marker (absent = baseline / non-scenario).
      project.schemaVersion = SCENARIO_SCHEMA_VERSION;
      project.updatedAt = new Date().toISOString();
      scenarioSet = true;
      return { ok: true, characterCount: scenario.characters.length };
    },
  });

  const set_scene_visual = tool({
    description:
      'SCENARIO ONLY. Define ONE project-wide scene VISUAL for the role-play entrance animation + banner. Call ONCE, AFTER you have authored every roleplay milestone/beat, basing it on an understanding of ALL of them so it fits the WHOLE project — a single shared place/atmosphere that suits every roleplay stage (never just one stage). Purely cosmetic.',
    inputSchema: z.object({
      caption: z
        .string()
        .min(1)
        .describe(
          'A short scene phrase IN THE PROJECT LANGUAGE that fits ALL roleplay stages — the shared place/atmosphere (e.g. "深夜，各自房间隔着手机聊到天亮" / "决赛辩论赛场" / "牌桌现金局"). Keep it under ~16 words. Derive it from the actual stages/tasks, not a guessed category.',
        ),
      bg1: z.string().describe('Background gradient TOP colour as a hex code (e.g. "#3a2740").'),
      bg2: z.string().describe('Background gradient BOTTOM colour as a hex code.'),
      accent: z
        .string()
        .describe('Accent colour (hex) for glows / motifs; must read clearly on the background.'),
      motifs: z
        .array(z.string())
        .min(1)
        .max(4)
        .describe(
          '2–4 EMOJI that evoke THIS exact scene (e.g. ["📱","🌙","🛏️"] for a late-night phone chat; ["🃏","♠️","🪙"] for poker; ["🎤","📣"] for a debate). Choose the ones that best fit this project, not a generic set.',
        ),
    }),
    execute: async (args) => {
      if (!project.scenario) {
        return { ok: false, error: 'Call set_scenario before set_scene_visual.' };
      }
      const hex = (s: string | undefined) =>
        s && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s.trim()) ? s.trim() : undefined;
      const motifs = (args.motifs ?? [])
        .map((m) => m.trim())
        .filter(Boolean)
        .slice(0, 4);
      project.scenario.sceneVisual = {
        ...(args.caption?.trim() ? { caption: args.caption.trim() } : {}),
        ...(hex(args.bg1) ? { bg1: hex(args.bg1) } : {}),
        ...(hex(args.bg2) ? { bg2: hex(args.bg2) } : {}),
        ...(hex(args.accent) ? { accent: hex(args.accent) } : {}),
        ...(motifs.length ? { motifs } : {}),
      };
      project.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  });

  return { ...baseTools, set_scenario, set_scene_visual };
}

// ---------------------------------------------------------------------------
// Post-loop validation
// ---------------------------------------------------------------------------

type PlannerCompletionToolResult = { ok: true } | { ok: false; gaps: string[]; nextAction: string };

function plannerCompletionNextAction(
  project: PBLProjectV2,
  opts?: { scenarioRoleplay?: boolean },
): string {
  if (!project.title || !project.description) {
    return 'Call set_project_info with the requested project topic, description, and learning objective.';
  }
  // SCENARIO ONLY. Steer the model to author the scenario before the
  // generic milestone gaps (set_scenario comes right after set_info).
  if (opts?.scenarioRoleplay && !project.scenario) {
    return 'Call set_scenario with the setting and at least one character (name + persona + situation) before adding milestones.';
  }
  if (!project.roles.some((r) => r.type === 'instructor')) {
    return 'Call add_role with type="instructor" before adding milestones.';
  }
  if (project.milestones.length === 0) {
    return 'Call add_milestone to create the first project phase.';
  }

  const milestoneWithoutTasks = project.milestones.find((m) => m.microtasks.length === 0);
  if (milestoneWithoutTasks) {
    return `Call add_microtask for milestoneId="${milestoneWithoutTasks.id}" before trying mark_design_complete again.`;
  }

  if (opts?.scenarioRoleplay) {
    const stages = project.milestones.map((m) => m.scenarioStage);
    if (stages[0] !== 'prep') {
      return 'Make the FIRST milestone scenarioStage:"prep" (Instructor introduces the premise + cast, one light microtask, no assessment).';
    }
    if (!stages.includes('roleplay')) {
      return 'Add at least one scenarioStage:"roleplay" milestone (the immersive role-play) before the wrapup.';
    }
    if (stages[stages.length - 1] !== 'wrapup') {
      return 'Make the LAST milestone scenarioStage:"wrapup" (Instructor light feedback, one light microtask).';
    }
  }

  return 'Fix the reported gaps, then call mark_design_complete again.';
}

function isAcceptedPlannerCompletion(output: unknown): output is { ok: true } {
  return (
    typeof output === 'object' &&
    output !== null &&
    'ok' in output &&
    (output as { ok?: unknown }).ok === true
  );
}

export function plannerStepHasAcceptedCompletion(step: StepResult<ToolSet>): boolean {
  return step.toolResults.some(
    (result) =>
      result.toolName === 'mark_design_complete' && isAcceptedPlannerCompletion(result.output),
  );
}

function plannerDesignAccepted(): StopCondition<ToolSet> {
  return ({ steps }) => steps.some(plannerStepHasAcceptedCompletion);
}

function validateProject(project: PBLProjectV2, scenarioRoleplay = false): void {
  const errors = plannerCompletionGaps(project, { scenarioRoleplay });
  if (errors.length > 0) {
    throw new PlannerV2Error(`Planner v2 output failed validation: ${errors.join('; ')}`, project);
  }
}
