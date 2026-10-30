import { z } from 'zod';

export const agentRoleSchema = z.enum(['mentor', 'discussion', 'planner', 'coder']);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const stageKindSchema = z.enum(['mentor_say', 'dialogue', 'produce', 'check', 'course']);
export const studentActionSchema = z.enum([
  'chat',
  'decide',
  'next',
  'edit',
  'create',
  'delete',
  'rename',
  'move',
  'restore',
  'evaluate',
  'quiz',
  'reset',
]);
export type StudentAction = z.infer<typeof studentActionSchema>;
export const artifactRefSchema = z.enum([
  'contract',
  'decisions',
  'decisions.chosen',
  'plan',
  'code',
]);
export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export const decisionKindSchema = z.enum(['architecture', 'implementation', 'product', 'quality']);

const nonEmptyString = z.string().trim().min(1);
const projectPath = nonEmptyString.refine(
  (value) => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'),
  {
    message: 'must be a project-relative path without parent traversal',
  },
);
const stageSkillId = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'must be a lowercase kebab-case skill id',
  });

export const projectServiceTypeSchema = z.enum(['preview-shell', 'jar-api', 'openmaic-classroom']);
export type ProjectServiceType = z.infer<typeof projectServiceTypeSchema>;

export const courseReleaseDescriptorSchema = z
  .object({
    courseId: nonEmptyString,
    releaseId: nonEmptyString,
    version: nonEmptyString,
    objectKey: projectPath,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().positive(),
    formatVersion: z.number().int().positive(),
  })
  .strict();
export type CourseReleaseDescriptor = z.infer<typeof courseReleaseDescriptorSchema>;

const projectServiceDefinitionSchema = z
  .object({
    serviceType: projectServiceTypeSchema,
    runtimeAdapter: nonEmptyString,
    activation: z
      .object({
        milestoneTypes: z.array(z.enum(['learn', 'task'])).min(1),
      })
      .strict(),
    publicShare: z.boolean().default(false),
    courseRelease: courseReleaseDescriptorSchema.optional(),
  })
  .strict()
  .superRefine((service, context) => {
    if (
      service.serviceType === 'openmaic-classroom' &&
      service.runtimeAdapter !== 'openmaic-sandbox'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'openmaic-classroom must use the openmaic-sandbox runtime adapter',
        path: ['runtimeAdapter'],
      });
    }
    if (service.serviceType === 'openmaic-classroom' && service.courseRelease === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'openmaic-classroom requires courseRelease',
        path: ['courseRelease'],
      });
    }
    if (service.serviceType !== 'openmaic-classroom' && service.courseRelease !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'courseRelease is only valid for openmaic-classroom',
        path: ['courseRelease'],
      });
    }
  });

export type ProjectServiceDefinition = z.infer<typeof projectServiceDefinitionSchema>;

const agentDefinitionSchema = z.object({
  systemPrompt: nonEmptyString,
  teachingSystemPrompt: nonEmptyString.optional(),
  tools: z.array(nonEmptyString),
  skillPaths: z.array(projectPath).default([]),
});

const evaluationMetadataSchema = z.object({
  capabilityIds: z.array(nonEmptyString).default([]),
  evaluatorRefs: z.array(nonEmptyString).default([]),
  rubricRefs: z.array(nonEmptyString).default([]),
});

const decisionDefinitionSchema = z.object({
  id: nonEmptyString,
  kind: decisionKindSchema.default('architecture'),
  desc: nonEmptyString,
  decisionPrompt: nonEmptyString,
  responseType: z.enum(['choice', 'text']).optional(),
  requiresRationale: z.boolean().optional(),
  options: z.array(
    z.object({ id: nonEmptyString, label: nonEmptyString, summary: nonEmptyString }),
  ),
  rubricAnchor: nonEmptyString,
  gatesGlobs: z.array(nonEmptyString),
  evaluation: evaluationMetadataSchema.optional(),
});
const quizQuestionSchema = z.object({
  q: nonEmptyString,
  options: z.array(nonEmptyString).min(2),
  answer: z.number().int().nonnegative(),
  explain: nonEmptyString,
  /** Public misconception hints indexed by the selected option; never disclose an alternative answer. */
  optionFeedback: z.array(nonEmptyString).optional(),
  retryHint: nonEmptyString.optional(),
});
const stagePolicySchema = z.object({
  workspaceAccessPolicyRef: nonEmptyString.optional(),
  evaluationPolicyRef: nonEmptyString.optional(),
});

const mentorSayStageSchema = z.object({
  kind: z.literal('mentor_say'),
  agent: z.enum(['mentor', 'discussion']),
  say: nonEmptyString,
  skill: stageSkillId.optional(),
  reviewScope: z.enum(['current_milestone', 'project']).optional(),
  reads: z.array(artifactRefSchema).default([]),
  studentActions: z.array(studentActionSchema).default(['chat', 'next']),
  policy: stagePolicySchema.optional(),
});

const dialogueStageSchema = z.object({
  kind: z.literal('dialogue'),
  agent: z.literal('discussion'),
  reads: z.array(artifactRefSchema),
  collects: z.literal('decisions'),
  studentActions: z.array(studentActionSchema),
  policy: stagePolicySchema.optional(),
});

const produceStageSchema = z
  .object({
    kind: z.literal('produce'),
    agent: z.enum(['planner', 'coder']),
    reads: z.array(artifactRefSchema),
    writes: z.enum(['plan', 'code']),
    reviewRequired: z.boolean().default(false),
    compileBeforeReview: z.boolean().optional(),
    planUpdateMode: z.literal('incremental').optional(),
    skill: stageSkillId.optional(),
    studentActions: z.array(studentActionSchema),
    policy: stagePolicySchema.optional(),
  })
  .strict();

const checkStageSchema = z.object({
  kind: z.literal('check'),
  checker: z.enum(['tests', 'quiz']),
  evaluation: evaluationMetadataSchema.optional(),
  policy: stagePolicySchema.optional(),
});

const courseStageSchema = z.object({
  kind: z.literal('course'),
  courseId: nonEmptyString,
  releaseId: nonEmptyString,
});

export const stageDefinitionSchema = z.discriminatedUnion('kind', [
  mentorSayStageSchema,
  dialogueStageSchema,
  produceStageSchema,
  checkStageSchema,
  courseStageSchema,
]);
export type StageDefinition = z.infer<typeof stageDefinitionSchema>;

const milestoneSchema = z
  .object({
    id: nonEmptyString,
    type: z.enum(['learn', 'task']),
    optional: z.literal(false).default(false),
    title: nonEmptyString,
    goal: nonEmptyString.optional(),
    teaching: z
      .object({
        projectContext: nonEmptyString.optional(),
        stageRole: nonEmptyString.optional(),
        targetOutcome: nonEmptyString.optional(),
        knowledgeBridge: nonEmptyString.optional(),
        purpose: nonEmptyString,
        concepts: z.array(nonEmptyString).min(1),
        boundaries: z.array(nonEmptyString).default([]),
      })
      .optional(),
    contract: nonEmptyString.optional(),
    deliverables: z.array(nonEmptyString).default([]),
    tests: z.array(nonEmptyString).default([]),
    testScope: z.enum(['current', 'cumulative']).default('current'),
    publicTestFeedback: z.record(nonEmptyString, z.string().trim().min(1).max(300)).default({}),
    decisions: z.array(nonEmptyString).default([]),
    quiz: z.array(quizQuestionSchema).default([]),
    stages: z.array(stageDefinitionSchema).min(1),
  })
  .passthrough();
export type MilestoneDefinition = z.infer<typeof milestoneSchema>;

export const workspaceAccessPolicySchema = z.object({
  id: nonEmptyString,
  actor: z.enum(['student', 'agent', 'system', 'evaluator']),
  agentRole: agentRoleSchema.optional(),
  milestoneIds: z.array(nonEmptyString).default([]),
  stageKinds: z.array(stageKindSchema).default([]),
  operations: z.array(z.enum(['read', 'write', 'list', 'evaluate'])).min(1),
  include: z.array(nonEmptyString).default([]),
  exclude: z.array(nonEmptyString).default([]),
});
export type WorkspaceAccessPolicy = z.infer<typeof workspaceAccessPolicySchema>;

export const evaluationFailureKindSchema = z.enum([
  'compile',
  'assertion',
  'build',
  'timeout',
  'infrastructure',
  'contract',
  'decision',
  'plan',
  'unknown',
]);

export const projectSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    id: nonEmptyString,
    title: nonEmptyString,
    language: nonEmptyString,
    presentation: z
      .object({
        hero: z
          .object({
            description: z.string().trim().min(1).max(2000),
            gains: z.array(z.string().trim().min(1).max(240)).min(1).max(8).optional(),
            instructorName: z.string().trim().min(1).max(100).optional(),
          })
          .strict(),
      })
      .strict()
      .optional(),
    providerRef: nonEmptyString,
    entry: z
      .object({ mode: z.enum(['intro', 'course-first']) })
      .strict()
      .default({ mode: 'intro' }),
    services: z
      .array(projectServiceDefinitionSchema)
      .default([])
      .superRefine((services, context) => {
        const types = services.map((service) => service.serviceType);
        if (new Set(types).size !== types.length) {
          context.addIssue({ code: 'custom', message: 'project service types must be unique' });
        }
        for (const [index, service] of services.entries()) {
          if (service.publicShare && service.serviceType !== 'preview-shell') {
            context.addIssue({
              code: 'custom',
              message: 'only preview-shell can be publicly shared',
              path: [index, 'publicShare'],
            });
          }
        }
      }),
    paths: z.object({
      requirements: projectPath,
      pedagogy: projectPath,
      skeleton: projectPath,
      tests: projectPath,
      rubric: projectPath,
    }),
    protectedPaths: z.array(nonEmptyString),
    testing: z.object({
      runCmd: nonEmptyString,
      reportPath: projectPath,
      reportFormat: nonEmptyString,
    }),
    agents: z.object({
      commonRules: nonEmptyString,
      mentor: agentDefinitionSchema,
      discussion: agentDefinitionSchema,
      planner: agentDefinitionSchema,
      coder: agentDefinitionSchema,
    }),
    intro: z.object({ say: nonEmptyString }).strict(),
    visibility: z
      .object({
        roleViews: z.object({
          discussion: z.array(nonEmptyString),
          planner: z.array(nonEmptyString),
          coder: z.array(nonEmptyString),
        }),
        answerKeys: z.array(nonEmptyString),
        testSupport: z.array(nonEmptyString),
      })
      .passthrough(),
    decisions: z.array(decisionDefinitionSchema),
    milestones: z.array(milestoneSchema).min(1),
    workspaceAccessPolicies: z.array(workspaceAccessPolicySchema).default([]),
    workspaceRevisionPolicy: z
      .object({
        strategy: z.enum(['snapshot', 'git-checkpoint', 'provider-defined']),
        evaluatorUsesImmutableRevision: z.boolean(),
      })
      .default({ strategy: 'snapshot', evaluatorUsesImmutableRevision: true }),
  })
  .strict()
  .superRefine((project, context) => {
    const openmaicService = project.services.find(
      (service) => service.serviceType === 'openmaic-classroom',
    );
    const courseStages = project.milestones.flatMap((milestone, milestoneIndex) =>
      milestone.stages.flatMap((stage, stageIndex) =>
        stage.kind === 'course' ? [{ milestoneIndex, stageIndex, stage }] : [],
      ),
    );

    for (const { milestoneIndex, stageIndex, stage } of courseStages) {
      if (!openmaicService?.courseRelease) {
        context.addIssue({
          code: 'custom',
          message: `course stage ${stage.courseId} requires an OpenMAIC course release`,
          path: ['milestones', milestoneIndex, 'stages', stageIndex],
        });
        continue;
      }
      if (
        openmaicService.courseRelease.courseId !== stage.courseId ||
        openmaicService.courseRelease.releaseId !== stage.releaseId
      ) {
        context.addIssue({
          code: 'custom',
          message: `course stage ${stage.courseId} is not pinned to the OpenMAIC service release`,
          path: ['milestones', milestoneIndex, 'stages', stageIndex],
        });
      }
    }

    if (
      project.entry.mode === 'course-first' &&
      project.milestones[0]?.stages[0]?.kind !== 'course'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'course-first entry requires the first stage to be a course',
        path: ['entry', 'mode'],
      });
    }

    for (const [milestoneIndex, milestone] of project.milestones.entries()) {
      const stages = milestone.stages;
      if (
        !(
          stages.length === 7 &&
          stages[0]?.kind === 'mentor_say' &&
          stages[0].agent === 'discussion' &&
          stages[1]?.kind === 'dialogue' &&
          stages[2]?.kind === 'produce' &&
          stages[2].agent === 'planner' &&
          stages[2].writes === 'plan' &&
          stages[3]?.kind === 'produce' &&
          stages[3].agent === 'coder' &&
          stages[3].writes === 'code' &&
          stages[4]?.kind === 'check' &&
          stages[4].checker === 'tests' &&
          stages[5]?.kind === 'check' &&
          stages[5].checker === 'quiz' &&
          stages[6]?.kind === 'mentor_say' &&
          stages[6].agent === 'mentor' &&
          stages[6].skill === 'recap'
        )
      )
        context.addIssue({
          code: 'custom',
          message:
            'Each milestone must use the seven teaching, decision, plan, code, test, quiz and recap steps.',
          path: ['milestones', milestoneIndex, 'stages'],
        });

      for (const [stageIndex, stage] of milestone.stages.entries()) {
        if (
          stage.kind === 'produce' &&
          stage.planUpdateMode === 'incremental' &&
          (stage.agent !== 'planner' ||
            stage.writes !== 'plan' ||
            !stage.reviewRequired ||
            !stage.skill)
        ) {
          context.addIssue({
            code: 'custom',
            message: 'incremental plan updates require a guided planner review stage',
            path: ['milestones', milestoneIndex, 'stages', stageIndex, 'planUpdateMode'],
          });
        }
        if (
          stage.kind === 'produce' &&
          stage.compileBeforeReview === true &&
          (stage.agent !== 'coder' || !stage.reviewRequired || !stage.skill)
        ) {
          context.addIssue({
            code: 'custom',
            message: 'compileBeforeReview requires a guided coder review stage',
            path: ['milestones', milestoneIndex, 'stages', stageIndex, 'compileBeforeReview'],
          });
        }
        if (stage.kind === 'produce' && stage.skill !== undefined && !stage.reviewRequired) {
          context.addIssue({
            code: 'custom',
            message: 'a produce-stage skill requires reviewRequired=true',
            path: ['milestones', milestoneIndex, 'stages', stageIndex, 'skill'],
          });
        }
      }
    }
  });

/** Authoring checks run only on new admission; installed resources keep their read schema. */
export const projectAdmissionSchema = projectSchema.superRefine((project, context) => {
  for (const [index, decision] of project.decisions.entries()) {
    if (decision.responseType !== 'text' && decision.options.length === 0)
      context.addIssue({
        code: 'custom',
        message: 'A choice decision requires at least one option.',
        path: ['decisions', index, 'options'],
      });
  }
  for (const [milestoneIndex, milestone] of project.milestones.entries()) {
    for (const [index, question] of milestone.quiz.entries()) {
      const path = ['milestones', milestoneIndex, 'quiz', index];
      if (question.answer >= question.options.length)
        context.addIssue({
          code: 'custom',
          message: 'Quiz answer must reference an existing option.',
          path: [...path, 'answer'],
        });
      if (question.optionFeedback && question.optionFeedback.length !== question.options.length)
        context.addIssue({
          code: 'custom',
          message: 'Provide one feedback entry per quiz option.',
          path: [...path, 'optionFeedback'],
        });
    }
  }
});

export type ProjectDefinition = z.infer<typeof projectSchema>;
