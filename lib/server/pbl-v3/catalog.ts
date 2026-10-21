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
  testCommand?: string;
  evaluations: Record<string, ProjectEvaluation>;
  buildCommand?: string;
  previewPorts?: readonly number[];
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
  testCommand: `python3 -c 'from greeting import greet; assert greet("Ada") == "Hello, Ada!"; assert greet("Lin") == "Hello, Lin!"; print("2 checks passed")'`,
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
/** Public package examples use only the existing milestone and teaching state machine. */
function extendedProject(language: 'Python' | 'Java'): InstalledProject {
  const java = language === 'Java';
  const ref = { id: java ? 'greeting-java' : 'greeting-python-lab', version: '1.0.0' };
  const source = java ? 'src/Greeting.java' : 'src/greeting.py';
  const definition = structuredClone(greeting.definition);
  definition.id = ref.id;
  definition.title = java ? 'A Java greeting application' : 'A Python greeting application';
  definition.language = language;
  definition.intro.say =
    'Introduce the greeting project. Explain that the second milestone adds whitespace handling to the same code and plan.';
  const first = definition.milestones[0]!;
  if (java)
    first.contract =
      'Greeting.greet(name) returns Hello, <name>!. main prints the result for its first argument.';
  definition.decisions[0]!.gatesGlobs = [source];
  for (const stage of first.stages)
    if (stage.kind === 'produce' && stage.writes === 'code') {
      stage.skill = 'coder-implementation-review';
      stage.compileBeforeReview = true;
    }
  definition.milestones.push({
    ...structuredClone(first),
    id: 'normalize',
    title: 'Handle surrounding whitespace',
    contract: java
      ? 'Keep Greeting.greet behavior, trimming surrounding whitespace from the name. main prints the greeting.'
      : 'Keep greet behavior, trimming surrounding whitespace from the name.',
    decisions: [],
    stages: structuredClone(first.stages.filter((stage) => stage.kind !== 'dialogue')),
    quiz: [
      {
        q: 'Why run earlier checks after changing input handling?',
        options: ['To preserve existing behavior', 'To replace the new checks'],
        answer: 0,
        explain: 'An extension must preserve earlier behavior.',
      },
    ],
  });
  const check = (id: string, name: string) => ({
    id,
    argv: java
      ? ['java', '-cp', '{build}', 'Greeting', name]
      : [
          'python3',
          '-c',
          `import sys; sys.path.insert(0, "src"); from greeting import greet; print(greet(${JSON.stringify(name)}))`,
        ],
    stdout: `Hello, ${name.trim()}!\n`,
  });
  const prepare = java ? ['javac', '-d', '{build}', source] : undefined;
  const cases = [check('Ada', 'Ada'), check('Lin', 'Lin')];
  return {
    ref,
    definition: projectSchema.parse(definition),
    sourceRoots: ['src'],
    files: {
      'PLAN.md': '',
      [source]: java
        ? 'public class Greeting {\n  public static String greet(String name) { return ""; }\n  public static void main(String[] args) { System.out.println(greet(args[0])); }\n}\n'
        : 'def greet(name):\n    return ""\n',
    },
    buildCommand: java
      ? 'javac -d /tmp/pbl-greeting-build src/Greeting.java'
      : 'python3 -c \'import ast,pathlib; ast.parse(pathlib.Path("src/greeting.py").read_text())\'',
    evaluations: {
      greeting: { prepare, cases },
      normalize: { prepare, cases: [...cases, check('whitespace', '  Ada  ')] },
    },
  };
}
const pythonLab = extendedProject('Python');
const javaLab = extendedProject('Java');
const projects = new Map(
  [greeting, pythonLab, javaLab].map((project) => [
    `${project.ref.id}@${project.ref.version}`,
    project,
  ]),
);
export function publicProjects() {
  return [pythonLab, javaLab, greeting].map(({ ref, definition }) => ({
    ref,
    title: definition.title,
    language: definition.language,
  }));
}
export function installedProject(ref: PBLV3Reference): InstalledProject {
  if (ref.assetId || ref.checksum || ref.packageId)
    throw new SandboxError(
      'PBL_PROJECT_UNAVAILABLE',
      404,
      'A packaged project requires the owner-scoped resolver.',
    );
  const project = projects.get(`${ref.id}@${ref.version}`);
  if (!project)
    throw new SandboxError(
      'PBL_PROJECT_UNAVAILABLE',
      404,
      'This project version is not installed.',
    );
  return project;
}
