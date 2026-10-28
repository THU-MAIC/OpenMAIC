import 'server-only';
import { projectSchema, type ProjectDefinition } from '@/lib/pbl/v3/domain/project/project-schema';
import type { PBLV3Reference } from '@/lib/pbl/v3/types';
import type { ProjectEvaluation } from './evaluation';
import { SandboxError } from '@/lib/sandbox/errors';

export interface InstalledProject {
  ref: PBLV3Reference;
  definition: ProjectDefinition;
  files: Record<string, string>;
  /** Optional trusted relative directories (without trailing slashes), never browser input. */
  sourceRoots?: readonly string[];
  /** Trusted deployment-owned commands, never read from browser scene content. */
  evaluations: Record<string, ProjectEvaluation>;
  buildCommand?: string;
  coursePackage?: {
    bundle: import('@openmaic/dsl').PBLProjectPackage;
    descriptor: import('./project-package').ProjectDescriptor;
  };
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
  evaluations: {
    greeting: {
      cases: ['Ada', 'Lin'].map((name) => ({
        id: name,
        argv: [
          'python3',
          '-c',
          `from greeting import greet; print(greet(${JSON.stringify(name)}))`,
        ],
        stdout: `Hello, ${name}!\n`,
      })),
    },
  },
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
          {
            id: 'format',
            label: 'f-string (formatted string literal)',
            summary:
              'Use a Python f-string, for example f"Hello, {name}!"; do not substitute str.format().',
          },
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
          {
            q: 'When greet is called with Ada, what does the name parameter hold?',
            options: ['The function name', 'The value Ada', 'The returned greeting'],
            answer: 1,
            explain: 'A parameter receives the argument supplied by the caller.',
          },
          {
            q: 'The approved plan uses your chosen formatting method. What should implementation do?',
            options: [
              'Use any method with similar output without mentioning the change',
              'Skip checking the saved decision',
              'Follow that method, or discuss a necessary change before replacing it',
            ],
            answer: 2,
            explain:
              'A chosen implementation technique is part of the approved plan, even when another technique could produce the same output.',
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
function extendedProject(language: 'Python' | 'Java'): InstalledProject {
  const java = language === 'Java';
  const ref = { id: java ? 'greeting-java' : 'greeting-python-lab', version: '1.2.0' };
  const file = java ? 'src/Greeting.java' : 'src/greeting.py';
  const definition = structuredClone(greeting.definition);
  definition.id = ref.id;
  definition.title = java ? 'A Java greeting application' : 'A Python greeting application';
  definition.language = language;
  definition.intro.say =
    'Introduce the project: implement a greeting, then add safe whitespace handling. Explain that earlier code and one evolving PLAN.md carry into the next milestone. Complete both milestones and their reflections to open the project report.';
  const first = definition.milestones[0]!;
  first.teaching = {
    purpose: 'Connect a function input to its returned output.',
    concepts: ['parameters', 'return values'],
    boundaries: ['Do not teach later input-normalization requirements yet.'],
  };
  if (java) {
    definition.decisions[0]!.options = [
      {
        id: 'format',
        label: 'String.format',
        summary: 'Use Java String.format; Python f-strings are not Java syntax.',
      },
      { id: 'concat', label: 'Concatenation', summary: 'Join strings with +.' },
    ];
    first.contract =
      'Greeting.greet(name) returns Hello, <name>!. The main method prints the result for its first argument.';
  }
  const stages = structuredClone(first.stages);
  for (const stage of stages) {
    if (stage.kind === 'produce' && stage.writes === 'plan') {
      stage.planUpdateMode = 'incremental';
      stage.skill = 'planner-plan-review';
    }
    if (stage.kind === 'produce' && stage.writes === 'code') {
      stage.compileBeforeReview = true;
      stage.skill = 'coder-implementation-review';
    }
  }
  first.stages = structuredClone(stages);
  definition.decisions[0]!.gatesGlobs = [file];
  definition.milestones.push({
    ...structuredClone(first),
    id: 'normalize',
    title: 'Handle surrounding whitespace',
    contract: java
      ? 'Keep Greeting.greet behavior, trimming surrounding whitespace from the name. main prints the returned greeting.'
      : 'Keep greet behavior, trimming surrounding whitespace from the name.',
    teaching: {
      purpose: 'Extend an existing contract without losing earlier behavior.',
      concepts: ['input normalization', 'regression checks'],
      boundaries: [],
    },
    decisions: [],
    stages: structuredClone(stages),
    quiz: [
      {
        q: 'Why run the earlier checks after changing input handling?',
        options: ['To preserve existing behavior', 'To replace the new checks'],
        answer: 0,
        explain: 'New behavior must preserve earlier requirements.',
      },
      {
        q: 'Which input exercises the new surrounding-whitespace requirement?',
        options: ['  Ada  ', 'Ada', 'Lin'],
        answer: 0,
        explain:
          'Leading and trailing spaces exercise normalization; ordinary names remain useful regression cases.',
      },
      {
        q: 'The syntax/build check succeeds. What does this prove?',
        options: [
          'All required behavior passed',
          'The code passed that syntax/build check; formal behavior tests still matter',
          'Every earlier requirement was tested',
        ],
        answer: 1,
        explain: 'Building and checking observable behavior supply different evidence.',
      },
    ],
  });
  const check = (id: string, name: string, expected: string) => ({
    id,
    argv: java
      ? ['java', '-cp', '{build}', 'Greeting', name]
      : [
          'python3',
          '-c',
          `import sys; sys.path.insert(0, "src"); from greeting import greet; print(greet(${JSON.stringify(name)}))`,
        ],
    stdout: expected + '\n',
  });
  const prepare = java ? ['javac', '-d', '{build}', file] : undefined;
  const baseline = [check('Ada', 'Ada', 'Hello, Ada!'), check('Lin', 'Lin', 'Hello, Lin!')];
  return {
    ref,
    definition: projectSchema.parse(definition),
    sourceRoots: ['src'],
    files: {
      'PLAN.md': '',
      [file]: java
        ? 'public class Greeting {\n  public static String greet(String name) { return ""; }\n  public static void main(String[] args) { System.out.println(greet(args[0])); }\n}\n'
        : 'def greet(name):\n    return ""\n',
    },
    buildCommand: java
      ? 'javac -d /tmp/pbl-greeting-build src/Greeting.java'
      : 'python3 -c \'import ast,pathlib; ast.parse(pathlib.Path("src/greeting.py").read_text())\'',
    evaluations: {
      greeting: { prepare, cases: baseline },
      normalize: { prepare, cases: [...baseline, check('whitespace', '  Ada  ', 'Hello, Ada!')] },
    },
  };
}
const pythonLab = extendedProject('Python');
const javaLab = extendedProject('Java');
// Keep existing study references and quiz attempts pinned to their original content.
function legacySample(project: InstalledProject, version: string): InstalledProject {
  const legacy = structuredClone(project);
  legacy.ref.version = version;
  for (const milestone of legacy.definition.milestones)
    milestone.quiz = milestone.quiz?.slice(0, 1);
  legacy.definition.decisions[0]!.options[0] = {
    id: 'format',
    label: 'Formatted string',
    summary:
      legacy.definition.language === 'Java' ? 'Use String.format.' : 'Use a formatted string.',
  };
  return legacy;
}
const currentGreeting = { ...greeting, ref: { ...greeting.ref, version: '1.1.0' } };
const projects = new Map(
  [
    legacySample(greeting, '1.0.0'),
    legacySample(pythonLab, '1.1.0'),
    legacySample(javaLab, '1.1.0'),
    currentGreeting,
    pythonLab,
    javaLab,
  ].map((p) => [`${p.ref.id}@${p.ref.version}`, p]),
);
export function publicProjects() {
  return [pythonLab, javaLab, currentGreeting].map(({ ref, definition }) => ({
    ref,
    title: definition.title,
    language: definition.language,
  }));
}
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
