import 'server-only';
import { projectSchema, type ProjectDefinition } from '@/lib/pbl/v3/domain/project/project-schema';
import type { PBLV3Reference } from '@/lib/pbl/v3/types';
import { SandboxError } from '@/lib/sandbox/errors';

export interface InstalledProject {
  ref: PBLV3Reference;
  definition: ProjectDefinition;
  files: Record<string, string>;
  /** Optional trusted relative directories (without trailing slashes), never browser input. */
  sourceRoots?: readonly string[];
  /** Trusted deployment-owned commands, never read from browser scene content. */
  testCommand: string;
  previewPorts?: readonly number[];
}
const agent = (role: string) => ({
  systemPrompt: `You are the ${role} in a programming learning project. Help the learner understand and do the work. Context: {{seed}}`,
  tools: [],
  skillPaths: [],
});
const greeting: InstalledProject = {
  ref: { id: 'greeting-python', version: '1.0.0' },
  sourceRoots: ['src'],
  files: {
    'PLAN.md': '',
    'greeting.py': 'def greet(name):\n    # Implement a friendly greeting.\n    return ""\n',
  },
  testCommand: `python3 -c 'from greeting import greet; assert greet("Ada") == "Hello, Ada!"; assert greet("Lin") == "Hello, Lin!"; print("2 checks passed")'`,
  definition: projectSchema.parse({
    id: 'greeting-python',
    title: 'A friendly greeting',
    language: 'Python',
    providerRef: 'host',
    paths: {
      requirements: 'requirements',
      pedagogy: 'pedagogy',
      skeleton: 'skeleton',
      tests: 'tests',
      rubric: 'rubric',
    },
    protectedPaths: [],
    testing: { runCmd: 'host', reportPath: 'report', reportFormat: 'exit-code' },
    agents: {
      commonRules:
        '\nUse only the supplied tools. Never claim a test passed without an observed result. Do not advance stages yourself.',
      mentor: agent('mentor'),
      discussion: agent('discussion'),
      planner: agent('planner'),
      coder: agent('coder'),
    },
    intro: {
      kind: 'mentor_say',
      agent: 'mentor',
      say: 'Introduce the goal: implement greet(name), returning Hello, <name>!. Ask the learner to continue when ready.',
    },
    visibility: {
      roleViews: { discussion: [], planner: [], coder: [] },
      answerKeys: [],
      testSupport: [],
    },
    decisions: [
      {
        id: 'format',
        desc: 'Choose a string formatting method.',
        decisionPrompt: 'How will you insert the name into the greeting?',
        options: [
          { id: 'format', label: 'Formatted string', summary: 'Use a formatted string.' },
          { id: 'concat', label: 'Concatenation', summary: 'Join strings.' },
        ],
        rubricAnchor: 'readability',
        gatesGlobs: ['greeting.py'],
      },
    ],
    milestones: [
      {
        id: 'greeting',
        type: 'task',
        title: 'Implement and explain a greeting',
        contract: 'greet(name) returns Hello, <name>! for any name.',
        decisions: ['format'],
        quiz: [
          {
            q: 'What does return do?',
            options: ['Sends a value to the caller', 'Prints a value automatically'],
            answer: 0,
            explain: 'return gives the value to the caller.',
          },
        ],
        stages: [
          {
            kind: 'mentor_say',
            agent: 'discussion',
            say: 'Explain function parameters and return values. Ask the learner to explain the difference before confirming teaching completion.',
            studentActions: ['chat', 'next'],
          },
          {
            kind: 'dialogue',
            agent: 'discussion',
            reads: ['contract', 'decisions'],
            collects: 'decisions',
            studentActions: ['chat', 'decide', 'next'],
          },
          {
            kind: 'produce',
            agent: 'planner',
            reads: ['contract', 'decisions.chosen'],
            writes: 'plan',
            reviewRequired: true,
            studentActions: ['chat', 'edit', 'next'],
          },
          {
            kind: 'produce',
            agent: 'coder',
            reads: ['contract', 'decisions.chosen', 'plan'],
            writes: 'code',
            reviewRequired: true,
            studentActions: ['chat', 'edit', 'next'],
          },
          { kind: 'check', checker: 'tests' },
          { kind: 'check', checker: 'quiz' },
          {
            kind: 'mentor_say',
            agent: 'mentor',
            say: 'Review the learner’s choices, implementation and test evidence. Ask what they learned.',
            skill: 'recap',
            reads: ['decisions.chosen', 'plan', 'code'],
            studentActions: ['chat', 'next'],
          },
        ],
      },
    ],
  }),
};
const projects = new Map([[`${greeting.ref.id}@${greeting.ref.version}`, greeting]]);
export function installedProject(ref: PBLV3Reference): InstalledProject {
  const project = projects.get(`${ref.id}@${ref.version}`);
  if (!project)
    throw new SandboxError(
      'PBL_PROJECT_UNAVAILABLE',
      404,
      'This project version is not installed.',
    );
  return project;
}
