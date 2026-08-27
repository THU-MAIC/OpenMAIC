/**
 * Pi-native skill discovery/resume and the outline-constraint checker.
 *
 * Adapted from the reference product's suite: tests that pinned the deferred
 * course-toolset prompt (`COURSE_SYSTEM_PROMPT` / `DSL_TOOLS_PROMPT` /
 * `buildRunnerCoursePrompt`) and the deferred `checkScenesAgainstSkill` are
 * intentionally not ported in this slice.
 */
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';

import {
  availableSkillsPromptBlock,
  checkOutlineAgainstSkill,
  createNativeSkillReadTool,
  findSkill,
  listSkills,
  skillInvocationPrompt,
  skillReadFromTranscript,
  type LoadedSkill,
} from '@/lib/server/agent-runtime/skills';

const skill = (id: string): LoadedSkill => ({
  id,
  name: id,
  description: `${id} courses`,
  content: `# ${id}`,
  filePath: `/skills/${id}/SKILL.md`,
  constraints: null,
  source: 'builtin',
});

/**
 * Collapse whitespace before matching a SENTENCE.
 *
 * Prose assertions must survive reflowing: a SKILL.md paragraph is hard-wrapped
 * at 80 columns and the system prompt is an array of fragments joined with
 * spaces, so where a line happens to break is a formatting detail. Asserting on
 * the raw text makes an editor's re-wrap look like a deleted rule.
 */
const flat = (text: string) => text.replace(/\s+/g, ' ');

describe('pi-native skills', () => {
  it('lists metadata without preloading skill content', () => {
    const block = availableSkillsPromptBlock([skill('deep-interactive')]);
    expect(block).toContain('<available_skills>');
    expect(block).toContain('<name>deep-interactive</name>');
    expect(block).toContain('/skills/deep-interactive/SKILL.md');
    expect(block).not.toContain('# deep-interactive');
  });

  it('uses pi invocation format for an explicit user choice', () => {
    const prompt = skillInvocationPrompt(skill('deep-interactive'), 'teach gravity');
    expect(prompt).toContain('<skill name="deep-interactive"');
    expect(prompt).toContain('# deep-interactive');
    expect(prompt).toContain('teach gravity');
  });

  it('restores the latest successfully-read SKILL.md from transcript', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'read-1',
            name: 'read',
            arguments: { path: '/skills/deep-interactive/SKILL.md' },
          },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'read-1',
        toolName: 'read',
        content: [{ type: 'text', text: '# deep-interactive' }],
        isError: false,
      },
    ] as unknown as AgentMessage[];
    expect(skillReadFromTranscript(messages, [skill('deep-interactive')])?.id).toBe(
      'deep-interactive',
    );
  });

  it('does not activate a failed read', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'read-1',
            name: 'read',
            arguments: { path: '/skills/deep-interactive/SKILL.md' },
          },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'read-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'denied' }],
        isError: true,
      },
    ] as unknown as AgentMessage[];
    expect(skillReadFromTranscript(messages, [skill('deep-interactive')])).toBeNull();
  });

  it('activates a skill only after its SKILL.md is read successfully', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openmaic-native-skill-'));
    try {
      const skillDir = join(root, 'deep-interactive');
      const skillFile = join(skillDir, 'SKILL.md');
      mkdirSync(skillDir);
      writeFileSync(skillFile, '# Native skill\n\nDo the thing.\n');
      const installed = { ...skill('deep-interactive'), filePath: skillFile };
      let activatedId: string | undefined;
      const tool = createNativeSkillReadTool([installed], (selected) => {
        activatedId = selected.id;
      });

      const result = await tool.execute('read-1', { path: skillFile });

      expect(result.content).toEqual([{ type: 'text', text: '# Native skill\n\nDo the thing.\n' }]);
      expect(activatedId).toBe('deep-interactive');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not let the skill read tool escape installed skill directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openmaic-native-skill-'));
    try {
      const skillDir = join(root, 'deep-interactive');
      const skillFile = join(skillDir, 'SKILL.md');
      const outsideFile = join(root, 'outside.txt');
      mkdirSync(skillDir);
      writeFileSync(skillFile, '# Native skill\n');
      writeFileSync(outsideFile, 'secret\n');
      const tool = createNativeSkillReadTool(
        [{ ...skill('deep-interactive'), filePath: skillFile }],
        () => undefined,
      );

      await expect(tool.execute('read-1', { path: outsideFile })).rejects.toThrow(
        'limited to installed skill resources',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('checkOutlineAgainstSkill', () => {
  const outline = (type: string, order: number, widgetType?: string) => ({
    type,
    order,
    title: `page ${order}`,
    ...(widgetType ? { widgetType } : {}),
  });

  it('passes a conforming plan', () => {
    const violations = checkOutlineAgainstSkill(
      [
        outline('slide', 1),
        outline('interactive', 2, 'simulation'),
        outline('interactive', 3, 'diagram'),
        outline('quiz', 4),
      ],
      {
        sceneCount: { min: 3, max: 5 },
        firstSceneType: 'slide',
        typeMix: [{ type: 'interactive', minRatio: 0.5 }],
        noConsecutiveSameWidgetType: true,
      },
    );
    expect(violations).toEqual([]);
  });

  it('flags count, first-type, ratio and consecutive-widget violations', () => {
    const violations = checkOutlineAgainstSkill(
      [
        outline('quiz', 1),
        outline('interactive', 2, 'simulation'),
        outline('interactive', 3, 'simulation'),
      ],
      {
        sceneCount: { min: 5 },
        firstSceneType: 'slide',
        typeMix: [{ type: 'interactive', minRatio: 0.8 }],
        noConsecutiveSameWidgetType: true,
      },
    );
    expect(violations.some((v) => v.includes('at least 5'))).toBe(true);
    expect(violations.some((v) => v.includes('scene 1'))).toBe(true);
    expect(violations.some((v) => v.includes('80%'))).toBe(true);
    expect(violations.some((v) => v.includes('consecutive'))).toBe(true);
  });

  it('flags disallowed scene and widget types', () => {
    const violations = checkOutlineAgainstSkill([outline('pbl', 1)], {
      allowedTypes: ['slide'],
    });
    expect(violations).toEqual(['scene types not allowed by the skill: pbl']);
  });
});

describe('shipped skill constraints', () => {
  it('every shipped skill directory actually loads', async () => {
    const root = join(process.cwd(), 'skills/agent-runtime');
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    // A skill whose frontmatter fails to parse — an unquoted ": " in the
    // description is enough — is DROPPED with a log warning and nothing else:
    // it vanishes from discovery and from the picker while its file sits there
    // looking correct. Compare the directory listing against what loaded.
    expect([...(await listSkills()).map((s) => s.id)].sort()).toEqual([...dirs].sort());
  });

  it('every shipped skill carries a display name', async () => {
    // The picker and the composer chip show display name + English id. The id
    // is the contract and stays English, so the display half is `title:` in the
    // frontmatter — and a skill that loses it silently degrades to a bare id.
    const loaded = await listSkills();
    expect(loaded.length).toBeGreaterThan(0);
    for (const skill of loaded) {
      expect(skill.title?.trim(), `${skill.id} needs a title: in its frontmatter`).toBeTruthy();
      // The shipped skills' display names are Chinese; assert the title is not
      // just an English restatement of the id.
      expect(skill.title, skill.id).toMatch(/[一-鿿]/);
    }
  });

  it('ships the K-12 core-literacy skill as an OpenMAIC-native classroom flow', async () => {
    const root = join(process.cwd(), 'skills/agent-runtime/k12-core-literacy-planning');
    const md = readFileSync(join(root, 'SKILL.md'), 'utf8');
    const skill = (await listSkills()).find(
      (candidate) => candidate.id === 'k12-core-literacy-planning',
    );

    expect(skill).toMatchObject({
      name: 'k12-core-literacy-planning',
      title: '核心素养教学设计',
      source: 'builtin',
      constraints: null,
    });
    expect(md).toContain('create_stage');
    expect(md).toContain('set_roster');
    expect(md).toContain('generate_scene');
    expect(md).toContain('list_scenes');
    expect(md).toContain('generate_tts');
    expect(md).toContain('read_stage');
    expect(md).toContain('patch_stage');
    expect(md).toContain('references/core-literacy.md');
    expect(md).toContain('references/subjects/languages.md');
    expect(md).toContain('references/subjects/mathematics.md');
    expect(md).toContain('references/subjects/science.md');
    expect(md).toContain('references/subjects/humanities.md');
    expect(md).toContain('Do not produce a Word lesson plan');

    const grounding = readFileSync(join(root, 'references/core-literacy.md'), 'utf8');
    expect(grounding).toContain('文化自信、语言运用、思维能力、审美创造');
    expect(grounding).toContain('数学抽象、逻辑推理、数学建模');
    expect(grounding).toContain('宏观辨识与微观探析');
    expect(grounding).toContain('信息意识、计算思维');
  });

  it('ships the promoted teaching methods as official skills', async () => {
    const loaded = await listSkills();
    const ubd = loaded.find((skill) => skill.id === 'understanding-by-design');
    const sel = loaded.find((skill) => skill.id === 'social-emotional-learning');
    const learning = loaded.find((skill) => skill.id === 'learning-to-learn');
    const feynman = loaded.find((skill) => skill.id === 'feynman-learning');
    const spiral = loaded.find((skill) => skill.id === 'spiral-curriculum');

    expect(ubd).toMatchObject({
      title: '理解本位设计（UbD）',
      source: 'builtin',
    });
    expect(ubd?.content).toContain('GRASPS');
    expect(ubd?.content).toContain('WHERETO');

    expect(sel).toMatchObject({
      title: '社会情感学习（SEL）',
      source: 'builtin',
    });
    expect(sel?.content).toContain('/understanding-by-design');

    expect(learning).toMatchObject({
      title: '学会学习（Learning to Learn）',
      source: 'builtin',
    });
    expect(learning?.content).toContain('/understanding-by-design');
    expect(learning?.content).toContain('/social-emotional-learning');

    expect(feynman).toMatchObject({
      title: '费曼学习法',
      source: 'builtin',
    });
    expect(feynman?.content).toContain('学习者先讲，AI 后介入');
    expect(feynman?.content).toContain('/learning-to-learn');

    expect(spiral).toMatchObject({
      title: '螺旋式课程设计',
      source: 'builtin',
    });
    expect(spiral?.content).toContain('Revisit 不等于 Review');
    expect(spiral?.content).toContain('/feynman-learning');
    expect(spiral?.content).toContain('/curriculum-planner');
  });

  it('exposes the title only through frontmatter the loader actually reads', async () => {
    // The title comes from the file, not from a table in the loader: renaming a
    // skill's display name is an edit to its SKILL.md and nothing else.
    const stageDesign = (await listSkills()).find((skill) => skill.id === 'stage-design');
    const md = readFileSync(
      join(process.cwd(), 'skills/agent-runtime/stage-design/SKILL.md'),
      'utf8',
    );
    expect(md).toContain('title: "课堂设计"');
    expect(stageDesign?.title).toBe('课堂设计');
    // And it stays out of the model's view: pi strips the frontmatter, so the
    // body the agent reads never carries it.
    expect(stageDesign?.content).not.toContain('课堂设计');
  });

  it('do not cap total page count', () => {
    const root = join(process.cwd(), 'skills/agent-runtime');
    // The constraint file is optional (see skills.ts): a skill that shapes the
    // process rather than the outline ships without one.
    const files = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, 'outline-constraints.json'))
      .filter((file) => existsSync(file));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const constraints = JSON.parse(readFileSync(file, 'utf8')) as { sceneCount?: unknown };
      expect(constraints.sceneCount, file).toBeUndefined();
    }
  });

  it('pptx-import skill inspects and repairs before writing actions, and does not replan', () => {
    const root = join(process.cwd(), 'skills/agent-runtime/pptx-import');
    const md = readFileSync(join(root, 'SKILL.md'), 'utf8');
    expect(md).toContain('name: pptx-import');
    expect(md).toContain('import_pptx');
    expect(md).toContain('render_scene_preview');
    expect(md).toContain('patch_stage');
    expect(md).toContain('generate_tts');
    expect(md).toContain('edit_deck');
    expect(md).toMatch(/Do not patch `\/actions` yet/);
    expect(md).toMatch(/understand the course/);
    expect(md).toContain('pro-editing');
    expect(md).toMatch(/Load `pro-editing`/);
    expect(md).toMatch(/quiz/);
    expect(md).toMatch(/interactive/);
    expect(md).toMatch(/Do \*\*not\*\* replan the imported deck/);
    expect(md).toContain('Do **not** call `generate_scene` to "generate actions"');
    expect(md).toContain('create_stage');
    expect(md).toMatch(/import_pptx` with that source `mat_` id and the `stageId`/);
    expect(md).toContain('atOrder');
    expect(md).toMatch(/appended pages/);
    expect(md).toMatch(/the PPT is content, not the classroom's identity/);
    expect(md).not.toMatch(/replace: true/);
    const constraints = JSON.parse(
      readFileSync(join(root, 'outline-constraints.json'), 'utf8'),
    ) as {
      allowedTypes?: string[];
      firstSceneType?: string;
    };
    expect(constraints.firstSceneType).toBe('slide');
    expect(constraints.allowedTypes).toEqual(['slide', 'quiz', 'interactive']);
  });
});

describe('shipped course-design skills', () => {
  it('loads stage-dsl as a valid builtin map with its reference chapters', async () => {
    const all = await listSkills();
    const courseDsl = all.find((skill) => skill.id === 'stage-dsl');
    expect(courseDsl).toMatchObject({
      name: 'stage-dsl',
      title: '课堂文档结构',
      source: 'builtin',
    });
    expect(courseDsl?.description.length).toBeLessThanOrEqual(1024);
    expect(courseDsl?.description).toContain('before patching a structure');
    expect(courseDsl?.description).toContain('rejects');
    expect(courseDsl?.description).toContain('path');
    expect(courseDsl?.content).toContain('references/quiz.md');
    expect(courseDsl?.content).toContain('references/widget.md');
    expect(courseDsl?.content).toContain('references/actions.md');
    expect(courseDsl?.content).toContain('references/pbl.md');
    expect(courseDsl?.content).toContain('slide-dsl');
    expect(availableSkillsPromptBlock(all)).toContain('<name>stage-dsl</name>');
  });

  it('teaches only the terminal DSL tool vocabulary in stage-dsl', async () => {
    const content = (await findSkill('stage-dsl'))!.content;
    expect(content).toContain('## Tool vocabulary');
    for (const tool of [
      'read_stage',
      'patch_stage',
      'grep_stage',
      'list_folder_stages',
      'edit_deck',
      'create_stage',
      'generate_scene',
      'set_roster',
    ]) {
      expect(content, tool).toContain(tool);
    }
    for (const legacy of ['read_scene', 'edit_slide', 'edit_quiz', 'edit_widget', 'edit_actions']) {
      expect(content, legacy).not.toContain(legacy);
    }
  });

  it('keeps every shipped agent skill and reference chapter on the terminal vocabulary', () => {
    // The retired tool names must not surface in anything a model can read
    // under skills/agent-runtime/: every SKILL.md, plus every reference
    // chapter under a skill's references/ directory. If a skill ever needs to
    // mention a legacy name for explanatory purposes, it must be listed
    // explicitly here with the reason, not by loosening the regex.
    const legacyNames = [
      'read_scene',
      'edit_slide',
      'edit_quiz',
      'edit_widget',
      'edit_actions',
      'edit_pbl',
      'read_course',
      'patch_course',
      'grep_course',
      'list_folder_courses',
      'generate_outline',
      'generate_roster',
    ];
    const root = join(process.cwd(), 'skills/agent-runtime');
    const mdFiles: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillRoot = join(root, entry.name);
      const skillFile = join(skillRoot, 'SKILL.md');
      if (existsSync(skillFile)) mdFiles.push(join(entry.name, 'SKILL.md'));
      const referencesDir = join(skillRoot, 'references');
      if (!existsSync(referencesDir)) continue;
      for (const ref of readdirSync(referencesDir)) {
        if (ref.endsWith('.md')) mdFiles.push(join(entry.name, 'references', ref));
      }
    }
    expect(mdFiles.length).toBeGreaterThanOrEqual(16);
    for (const relative of mdFiles) {
      const content = readFileSync(join(root, relative), 'utf8');
      for (const legacy of legacyNames) {
        expect(content, `${relative}: ${legacy}`).not.toContain(legacy);
      }
    }
    // quiz.md is covered by the sweep above; these two pins hold its
    // append-unsupported contract, which is the trickiest whole-array rule.
    const quiz = readFileSync(join(root, 'stage-dsl/references/quiz.md'), 'utf8');
    expect(quiz).toContain('`/-` append token is **not supported**');
    expect(quiz).toContain('`set` the array field to the complete result');
  });

  it('ships stage-design as an ordinary discoverable skill', async () => {
    const all = await listSkills();
    const stageDesign = all.find((s) => s.id === 'stage-design');
    expect(stageDesign).toBeTruthy();
    expect(availableSkillsPromptBlock(all)).toContain('<name>stage-design</name>');
    expect((await findSkill('stage-design'))?.id).toBe('stage-design');
  });

  it('carries the build methodology in stage-design', async () => {
    const stageDesign = (await listSkills()).find((s) => s.id === 'stage-design');
    expect(stageDesign).toBeTruthy();
    for (const kept of [
      'set_roster',
      'exactly one teacher',
      'at least two agents',
      'ascending order',
      'list_scenes',
      'generate_tts',
      'audioId',
    ]) {
      expect(stageDesign!.content, kept).toContain(kept);
    }
    // The retired planning tools are gone from the build sequence: planning is
    // conversation + create_stage + explicit briefs, and the roster is written
    // with set_roster.
    for (const retired of ['generate_outline', 'generate_roster']) {
      expect(stageDesign!.content, retired).not.toContain(retired);
    }
  });

  it('says where a turn may end, so a prepared stage is not a finished one', async () => {
    const stageDesign = flat((await listSkills()).find((s) => s.id === 'stage-design')!.content);
    expect(stageDesign).toContain('is a place to stop');
    expect(stageDesign).toContain('a turn ends when a page actually landed');
    expect(stageDesign).toContain('holding an empty deck');
    expect(stageDesign).toContain('a stage is done when the deck is complete');
    expect(stageDesign).toContain('narration that talks about material this stage does not teach');
  });

  it('does not teach a single removed slide op in any shipped agent skill', async () => {
    const removed = [
      'set_text',
      'set_style',
      'patch_element',
      'patch_table_cell',
      'patch_code_lines',
      'set_box',
      'set_media',
    ];
    // `delete`, `duplicate`, `reorder` and `align` still name real ops on OTHER
    // tools and real DSL fields, so they are banned only where they claim to be
    // slide ops.
    const removedSlideOps = ['duplicate', 'reorder', 'align', 'delete'];
    for (const skill of await listSkills()) {
      for (const op of removed) {
        expect(skill.content, `${skill.id}: ${op}`).not.toContain(op);
      }
      const flatContent = flat(skill.content);
      for (const op of removedSlideOps) {
        expect(flatContent, `${skill.id}: edit_slide ${op}`).not.toContain(`edit_slide ${op}`);
        expect(flatContent, `${skill.id}: edit_slide \`${op}\``).not.toContain(
          `edit_slide \`${op}\``,
        );
      }
    }
  });

  it('teaches the generic slide ops that exist, wherever slides are edited', async () => {
    for (const id of ['style-clone', 'page-clone', 'pro-editing', 'slide-dsl']) {
      const content = flat((await findSkill(id))!.content);
      for (const op of ['`set`', 'add_element', 'delete_element']) {
        expect(content, `${id}: ${op}`).toContain(op);
      }
      expect(content, `${id}: pointer`).toContain('/content/canvas/elements/');
    }
  });

  it('ships curriculum-planner as a discoverable series skill', async () => {
    const all = await listSkills();
    const planner = all.find((s) => s.id === 'curriculum-planner');
    expect(planner).toBeTruthy();
    expect(planner!.description.toLowerCase()).toContain('series');
    expect(availableSkillsPromptBlock(all)).toContain('<name>curriculum-planner</name>');
    for (const tool of [
      'ask_user',
      'create_folder',
      'move_to_folder',
      'list_folder_stages',
      'create_stage',
      'read_stage_outline',
    ]) {
      expect(planner!.content, tool).toContain(tool);
    }
    for (const retired of ['create_course', 'switch_course', 'read_course_outline']) {
      expect(planner!.content, retired).not.toContain(retired);
    }
  });

  it('ships build-personal-skill with evidence, paging, calibration, and creation workflow', async () => {
    const all = await listSkills();
    const personal = all.find((skill) => skill.id === 'build-personal-skill');
    expect(personal).toBeTruthy();
    expect(personal!.title).toBe('创建专属 Skill');
    expect(personal!.description).toContain('总结我的做课记录');
    expect(availableSkillsPromptBlock(all)).toContain('<name>build-personal-skill</name>');
    for (const tool of [
      'search_classrooms',
      'read_classroom',
      'search_chats',
      'read_chat',
      'ask_user',
      'create_skill',
    ]) {
      expect(personal!.content, tool).toContain(`\`${tool}\``);
    }
    expect(personal!.content).toContain('empty query');
    expect(personal!.content).toContain('confirming and disconfirming');
    expect(personal!.content).toContain('at least once unless the user explicitly says not');

    const read = createNativeSkillReadTool(all, () => undefined);
    const loaded = await read.execute('read-personal', { path: personal!.filePath });
    expect(loaded.content[0]).toMatchObject({ type: 'text' });
    expect((loaded.content[0] as { text: string }).text).toContain('search_classrooms');
  });

  it('teaches one-step archiving: create_stage files via folderId, move_to_folder is the fallback', async () => {
    const planner = (await listSkills()).find((s) => s.id === 'curriculum-planner');
    const content = flat(planner!.content);
    expect(content).toContain("`create_stage` passing the series folder's `folderId`");
    expect(content).toContain('filed into the folder in the same call');
    expect(content).toContain('`list_folder_stages` and check the stage is in');
    expect(content).toContain('`move_to_folder` to file it right away');
    expect(content).toContain(
      'never let the whole series run to the end before noticing an ungrouped stage',
    );
  });

  it('bans prose questions at BOTH curriculum-planner gates', async () => {
    const planner = (await listSkills()).find((s) => s.id === 'curriculum-planner');
    const content = flat(planner!.content);
    expect(content).toContain('**The question IS the tool call, never the text.**');
    expect(content).toContain('Writing the questions into chat prose is not asking');
    expect(content).toContain('The list above belongs in the chat');
    expect(content).toContain('**The ask does not.**');
    expect(content).toContain('it must not contain a question mark');
    expect(content).toContain('no preview of the question you are about to ask');
    for (const gate of planner!.content.split('## Gate ').slice(1, 3)) {
      expect(gate).toContain('`ask_user`');
    }
  });
});

/**
 * `lecture-style` and `workshop-style` exist to be swapped: the same request
 * regenerated under the other one has to come out visibly different. That
 * promise is only worth as much as the constraint files behind it, so it is
 * tested as a contrast rather than one skill at a time — a plan shaped like one
 * style must be REJECTED by the other's constraints.
 */
describe('pedagogy style skills', () => {
  const page = (
    type: string,
    order: number,
    widgetType?: string,
  ): {
    type: string;
    order: number;
    title: string;
    widgetType?: string;
    widgetOutline?: object;
  } => ({
    type,
    order,
    title: `page ${order}`,
    ...(widgetType ? { widgetType, widgetOutline: { concept: `concept ${order}` } } : {}),
  });

  /** Slide-carried, one checkpoint, one interactive — a masterclass. */
  const lectureShaped = [
    page('slide', 1),
    page('slide', 2),
    page('slide', 3),
    page('slide', 4),
    page('quiz', 5),
    page('slide', 6),
    page('slide', 7),
    page('interactive', 8, 'simulation'),
    page('slide', 9),
    page('slide', 10),
  ];

  /** Hands-on every other page, slides only as task briefs — a workshop. */
  const workshopShaped = [
    page('slide', 1),
    page('interactive', 2, 'code'),
    page('quiz', 3),
    page('slide', 4),
    page('interactive', 5, 'simulation'),
    page('interactive', 6, 'diagram'),
    page('quiz', 7),
    page('slide', 8),
    page('interactive', 9, 'game'),
    page('interactive', 10, 'visualization3d'),
  ];

  it('ships both styles as discoverable alternatives', async () => {
    const all = await listSkills();
    const block = availableSkillsPromptBlock(all);
    for (const id of ['lecture-style', 'workshop-style']) {
      expect(
        all.find((s) => s.id === id),
        id,
      ).toBeTruthy();
      expect(block).toContain(`<name>${id}</name>`);
    }
    const lecture = (await findSkill('lecture-style'))!.description;
    const workshop = (await findSkill('workshop-style'))!.description;
    expect(lecture.toLowerCase()).toContain('masterclass');
    expect(lecture).toContain('大师课');
    expect(workshop.toLowerCase()).toContain('workshop');
    expect(workshop).toContain('动手');
    expect(lecture).toContain('workshop-style');
    expect(workshop).toContain('lecture-style');
  });

  it('accepts its own page mix', async () => {
    expect(
      checkOutlineAgainstSkill(lectureShaped, (await findSkill('lecture-style'))!.constraints),
    ).toEqual([]);
    expect(
      checkOutlineAgainstSkill(workshopShaped, (await findSkill('workshop-style'))!.constraints),
    ).toEqual([]);
  });

  it('rejects the other style page mix', async () => {
    const asLecture = checkOutlineAgainstSkill(
      workshopShaped,
      (await findSkill('lecture-style'))!.constraints,
    );
    expect(asLecture.some((v) => v.includes('`slide`') && v.includes('65%'))).toBe(true);
    expect(asLecture.some((v) => v.includes('`interactive`') && v.includes('at most'))).toBe(true);

    const asWorkshop = checkOutlineAgainstSkill(
      lectureShaped,
      (await findSkill('workshop-style'))!.constraints,
    );
    expect(asWorkshop.some((v) => v.includes('`interactive`') && v.includes('at least 3'))).toBe(
      true,
    );
    expect(asWorkshop.some((v) => v.includes('`quiz`') && v.includes('at least 2'))).toBe(true);
  });

  it('carries the narration style through the fields the generators actually read', async () => {
    for (const id of ['lecture-style', 'workshop-style']) {
      const skill = (await findSkill(id))!;
      for (const field of ['materialFacts', 'brief', 'set_roster', 'voiceDesign']) {
        expect(skill.content, `${id}/${field}`).toContain(field);
      }
      expect(skill.content, `${id}/one teacher`).toContain('exactly one teacher');
    }
  });
});

describe('style-clone', () => {
  it('is discoverable and distinct from teacher-style-clone', async () => {
    const all = await listSkills();
    const clone = all.find((s) => s.id === 'style-clone');
    expect(clone).toBeTruthy();
    expect(availableSkillsPromptBlock(all)).toContain('<name>style-clone</name>');
    expect(clone!.description).toContain('teacher-style-clone');
    expect(clone!.description.toLowerCase()).toContain('pptx');
    expect(clone!.description).toContain('pptx-import');
  });

  it('drives copy-then-refine over the full-fidelity edit seam', async () => {
    const clone = flat((await findSkill('style-clone'))!.content);
    for (const token of ['duplicate_scene', 'templateSceneId', 'detail:"source"', 'page-clone']) {
      expect(clone, token).toContain(token);
    }
    expect(clone).toContain('one atomic patch is the entry point for every content rewrite');
    expect(clone).toContain('one scene-root JSON Pointer path');
    expect(clone).toContain('op:"set"');
    expect(clone).toContain('/content/canvas/elements/5/data/0/0/text');
    expect(clone).toContain('slide-dsl');
    expect(clone).toContain('a rejected patch changes nothing');
    expect(clone).toContain('nothing is normalised');
    for (const tool of [
      'list_scenes',
      'import_pptx',
      'create_stage',
      'set_roster',
      'generate_actions',
      'styleDirective',
      'stage-design',
    ]) {
      expect(clone, tool).toContain(tool);
    }
    expect(clone).toContain('New content in the old style is the goal');
  });

  it('generates a typed page when the source deck has no cloneable form', async () => {
    const clone = flat((await findSkill('style-clone'))!.content);
    expect(clone).toContain('source deck has a cloneable layout for this page type');
    expect(clone).toContain('quiz, interactive page');
    expect(clone).toContain('call `generate_scene` directly for this page');
    expect(clone).toContain('explicit `order`, `title`, `type`, and `brief`');
    expect(clone).toContain('Only the copied-page branch below forbids `generate_scene`');
  });

  it('retires the StyleProfile restyle route and says why it failed', async () => {
    const clone = flat((await findSkill('style-clone'))!.content);
    expect(clone).toContain('**zero** times');
    expect(clone).toContain('Describing a style to a generator does not transfer it');
    expect(clone).toContain('Copy the design; never regenerate a copied page');
    expect(clone).not.toContain('StyleProfile');
    expect(clone).not.toContain('never by reference');
    expect(clone).not.toContain('pixel-level escape hatch');
    expect(clone).not.toContain('exception now, not the main path');
  });

  it('treats the imported deck as a layout library, catalogued by capacity', async () => {
    const clone = flat((await findSkill('style-clone'))!.content);
    expect(clone).toContain('material, not deliverables');
    expect(clone).toContain('Never rewrite a source page in place');
    expect(clone).toContain('Source pages are the library');
    expect(clone).toContain('its template scene id');
    expect(clone).toContain('its capacity');
    expect(clone).toContain('cut the wording to what the layout holds');
  });

  it('protects the skeleton and sweeps the page for source-text residue', async () => {
    const clone = flat((await findSkill('style-clone'))!.content);
    expect(clone).toContain('skeleton is not touched');
    expect(clone).toContain('Skeleton is untouchable');
    expect(clone).toContain('detail:"text"');
    expect(clone).toContain('combinedText');
    expect(clone).toContain('No source text survives by accident');
    for (const spot of ['table cells', 'shape labels', 'code blocks and formulas', 'small type']) {
      expect(clone, spot).toContain(spot);
    }
  });

  it('names the three legal ways a turn can end, so preparation is not one', async () => {
    const clone = flat((await findSkill('style-clone'))!.content);
    expect(clone).toContain('preparation is not a result');
    expect(clone).toContain('the new course moved a real step');
    expect(clone).toContain('`ask_user` is waiting');
    expect(clone).toContain('every planned page is in the deck');
    expect(clone).toContain('continue into Step 2 in the same turn');
    expect(clone).toContain('Preparation is not a stopping point');
  });

  it('sweeps the narration for source-course residue, not just the page text', async () => {
    const clone = flat((await findSkill('style-clone'))!.content);
    expect(clone).toContain('check **what the narration says**');
    expect(clone).toContain('The narration has to be about **the new course**');
    expect(clone).toContain('`patch_stage` on the exact `/actions/N/text` pointer');
    expect(clone).toContain('generate_tts');
    expect(clone).toContain('The narration is swept too');
    expect(clone).toContain('This pass covers what the page *shows*');
  });

  it('places real pictures and repairs broken pages inside a budget', async () => {
    const clone = flat((await findSkill('style-clone'))!.content);
    for (const token of ['generate_image', 'styleHint', 'aspectRatio']) {
      expect(clone, token).toContain(token);
    }
    expect(clone).toContain('never invent a `src`');
    expect(clone).toContain('render_scene_preview');
    expect(clone).toContain('first page copied');
    expect(clone).toContain('pro-editing');
    expect(clone).toContain('two preview rounds');
  });

  it('leaves the page mix to the source deck', async () => {
    const clone = (await findSkill('style-clone'))!;
    expect(clone.constraints).toBeTruthy();
    expect(clone.constraints!.typeMix).toBeUndefined();
    expect(clone.constraints!.firstSceneType).toBe('slide');
  });
});

describe('page-clone', () => {
  it('is discoverable and routes away from the two skills next to it', async () => {
    const all = await listSkills();
    const pageClone = all.find((s) => s.id === 'page-clone');
    expect(pageClone).toBeTruthy();
    expect(availableSkillsPromptBlock(all)).toContain('<name>page-clone</name>');
    expect(pageClone!.description).toContain('style-clone');
    expect(pageClone!.description).toContain('pro-editing');
  });

  it('describes copy-then-edit with the ops the edit tools really have', async () => {
    const pageClone = (await findSkill('page-clone'))!;
    for (const token of [
      'duplicate_scene',
      'read_stage',
      'patch_stage',
      'detail:"source"',
      'generate_actions',
      'render_scene_preview',
    ]) {
      expect(pageClone.content, token).toContain(token);
    }
    const flatPageClone = flat(pageClone.content);
    expect(flatPageClone).toContain('`patch_stage` once per content slot');
    expect(flatPageClone).toContain('One leaf per call');
    expect(flatPageClone).toContain('only the path you name changes');
    expect(flatPageClone).toContain('identity is not patchable');
    expect(flatPageClone).toContain('a rejected patch changes nothing');
    expect(pageClone.content).toMatch(/Never `generate_scene` on a copied page/);
    expect(pageClone.content).not.toContain('set_text');
    expect(pageClone.content).not.toContain('set_style');
  });

  it('carries the per-page mechanics without restating the course-level job', async () => {
    const pageClone = (await findSkill('page-clone'))!.content;
    for (const token of [
      '/content/canvas/elements/N/content',
      '/content/canvas/elements/N/text/content',
      '/content/canvas/elements/N/data/0/0/text',
      '/content/canvas/elements/N/lines/1/content',
      'detail:"text"',
      '`slide-dsl`',
    ]) {
      expect(pageClone, token).toContain(token);
    }
    expect(pageClone).toContain('generate_image');
    expect(pageClone).toContain('`style-clone`');
    for (const courseLevel of ['import_pptx', 'generate_outline', 'generate_roster']) {
      expect(pageClone, courseLevel).not.toContain(courseLevel);
    }
  });

  it('checks the narration it just generated, not only its audio', async () => {
    const pageClone = flat((await findSkill('page-clone'))!.content);
    expect(pageClone).toContain("about **this** page's subject");
    expect(pageClone).toContain('is residue exactly as template words on the slide are');
    expect(pageClone).toContain("that action's `/actions/N/text`");
    expect(pageClone).toContain('generate_tts');
  });

  it('defers the design law to slide-craft', async () => {
    const pageClone = (await findSkill('page-clone'))!;
    expect(pageClone.content).toContain('`slide-craft`');
    expect(pageClone.content).not.toContain('<ul><li>');
  });
});

/**
 * `slide-dsl` is the FULL DSL manual — the agent's reference for the slide
 * structure the write path checks and the renderer paints.
 */
describe('slide-dsl', () => {
  it('is discoverable as a reference and routes away from the procedures', async () => {
    const all = await listSkills();
    const dsl = all.find((s) => s.id === 'slide-dsl');
    expect(dsl).toBeTruthy();
    expect(availableSkillsPromptBlock(all)).toContain('<name>slide-dsl</name>');
    const description = flat(dsl!.description);
    expect(description).toContain('field reference and not a procedure');
    for (const neighbour of ['page-clone', 'pro-editing', 'slide-craft']) {
      expect(description, neighbour).toContain(neighbour);
    }
  });

  it('is a reference layer, so it ships no outline constraints', async () => {
    const dsl = (await findSkill('slide-dsl'))!;
    expect(dsl.constraints).toBeNull();
    expect(
      existsSync(join(process.cwd(), 'skills/agent-runtime/slide-dsl', 'outline-constraints.json')),
    ).toBe(false);
  });

  it('opens by stating that nothing filters or normalises a write', async () => {
    const dsl = flat((await findSkill('slide-dsl'))!.content);
    expect(dsl).toContain('There is no markup allow-list, no sanitizer');
    expect(dsl).toContain('persists your value byte for byte');
    expect(dsl).toContain('structure** schema');
  });

  it('describes the canvas wrapper, its background precedence and its dead fields', async () => {
    const dsl = flat((await findSkill('slide-dsl'))!.content);
    expect(dsl).toContain('viewportSize');
    expect(dsl).toContain('viewportRatio');
    expect(dsl).toContain('1000 × 562.5');
    expect(dsl).toContain('in paint order');
    expect(dsl).toContain('**All of them are patchable.**');
    expect(dsl).toContain('/canvas/background/color');
    expect(dsl).toContain('/canvas/theme/fontColor');
    expect(dsl).toContain('The `type` field is the selector');
    expect(dsl).toContain('Nothing plays them in playback');
    expect(dsl).toContain('only `fontColor` and `fontName` are');
  });

  it('names all ten element types and where each one keeps its words', async () => {
    const dsl = flat((await findSkill('slide-dsl'))!.content);
    for (const type of [
      'text',
      'shape',
      'image',
      'line',
      'chart',
      'table',
      'latex',
      'video',
      'audio',
      'code',
    ]) {
      expect(dsl, type).toContain(`### ${type}`);
    }
    for (const field of [
      '`content`',
      '`text.content`',
      '`data[row][col].text`',
      '`lines[].content`',
      '`data.labels[]`',
    ]) {
      expect(dsl, field).toContain(field);
    }
  });

  it('states every precedence rule that makes a patch look like a no-op', async () => {
    const dsl = flat((await findSkill('slide-dsl'))!.content);
    expect(dsl).toContain('**`html` beats `latex`.**');
    expect(dsl).toContain('`pattern` beats `gradient` beats `fill`');
    expect(dsl).toContain('any inline `color` / `font-family` inside `content` wins');
    expect(dsl).toContain('the first one present wins');
    expect(dsl).toContain('The precedence rules, in one place');
  });

  it('writes the JSON Pointer contract out, not a paraphrase of it', async () => {
    const dsl = flat((await findSkill('slide-dsl'))!.content);
    expect(dsl).toContain('`set`');
    expect(dsl).toContain('`remove`');
    expect(dsl).toContain('`str_replace`');
    expect(dsl).toContain('add_element');
    expect(dsl).toContain('delete_element');
    expect(dsl).toContain('begins `/content/canvas/`');
    expect(dsl).toContain('Address the leaf, not the branch');
    expect(dsl).toContain('Array indices are canonical and bounded');
    expect(dsl).toContain('Every segment before the last must already exist');
    expect(dsl).toContain('adds that optional field');
    expect(dsl).toContain('splices');
    for (const path of [
      '/content/canvas/elements/0/content',
      '/content/canvas/elements/5/data/0/0/text',
      '/content/canvas/elements/9/lines/1/content',
      '/content/canvas/elements/3/text/content',
    ]) {
      expect(dsl, path).toContain(path);
    }
    expect(dsl).toContain('paint order **is** array position');
    expect(dsl).toContain('id set and every id→type pairing has to come back');
  });

  it('enumerates what the structure schema refuses, as the only hard boundary', async () => {
    const dsl = flat((await findSkill('slide-dsl'))!.content);
    expect(dsl).toContain('a rejected write changes nothing');
    expect(dsl).toContain('unknown field**');
    expect(dsl).toContain('additionalProperties: false');
    expect(dsl).toContain('wrong type**');
    expect(dsl).toContain('closed union**');
    expect(dsl).toContain('required field removed**');
    expect(dsl).toContain('Changing `/content/canvas/id`');
    expect(dsl).toContain("Changing an existing id's `type`");
    expect(dsl).toContain('no tag check, no CSS check');
    expect(dsl).toContain("re-renders that element's `html` snapshot");
  });

  it('separates the three read depths and says which one patch paths come from', async () => {
    const dsl = flat((await findSkill('slide-dsl'))!.content);
    expect(dsl).toContain('**Never** as a patch source');
    expect(dsl).toContain('There is no per-element');
    expect(dsl).toContain('detail:"text"');
    expect(dsl).toContain('combinedText');
    expect(dsl).toContain('always returns the whole page');
  });

  it('replaces the removed allow-list with the renderer truth, tag by tag', async () => {
    const dsl = flat((await findSkill('slide-dsl'))!.content);
    expect(dsl).toContain('injected into the page as raw HTML');
    expect(dsl).toContain('The write is byte-exact');
    expect(dsl).toContain('There is no tag allow-list and no CSS property allow-list');
    expect(dsl).toContain('no stylesheet for this HTML at all');
    expect(dsl).toContain('an inline style always wins');
    expect(dsl).toContain('`<h1>`–`<h6>`');
    expect(dsl).toContain('**Inert.**');
    expect(dsl).toContain('**no marker, no indent**');
    expect(dsl).toContain('stacked paragraphs touch');
    expect(dsl).toContain('looks exactly like body text**');
    for (const kept of ['`<sub>` / `<sup>`', '`<mark>`', '`<code>` / `<pre>`']) {
      expect(dsl, kept).toContain(kept);
    }
    expect(dsl).toContain('it forces black text');
    expect(dsl).toContain('preserves whitespace and newlines');
    expect(dsl).toContain('there is no property list, only a cascade');
    expect(dsl).toContain('only** horizontal alignment control');
    expect(dsl).toContain('kept in the DOM and ignored');
    expect(dsl).toContain('silently repaired by the HTML parser');
    expect(dsl).toContain('The PPTX export reads a much shorter list');
    expect(dsl).toContain('`font-weight` becomes bold **only for the literal string `bold`**');
    expect(dsl).toContain('Write `font-size` in px');
    expect(dsl).toContain('Write-is-what-you-store');
    expect(dsl).toContain('There is no filter to catch a mistake');
  });

  it('states the per-renderer divergences instead of a single false renderer', async () => {
    const dsl = flat((await findSkill('slide-dsl'))!.content);
    expect(dsl).toContain('Two renderers paint your page');
    expect(dsl).toContain('write for the intersection');
    expect(dsl).toContain('**not rendered at all** in playback');
    expect(dsl).toContain('inert in playback');
    expect(dsl).toContain('every space becomes `&nbsp;`');
    expect(dsl).toContain('Inline `style` attributes inside a cell do not work');
    expect(dsl).toContain('`bar` is the vertical one and `column` is the');
    expect(dsl).toContain('renders as unhighlighted plain');
  });

  it('ships a per-type quick reference with the paths, not just prose', async () => {
    const dsl = flat((await findSkill('slide-dsl'))!.content);
    expect(dsl).toContain('## Quick reference');
    for (const row of [
      '| `text`',
      '| `shape`',
      '| `image`',
      '| `line`',
      '| `chart`',
      '| `table`',
      '| `latex`',
      '| `code`',
      '| `video`',
      '| `audio`',
    ]) {
      expect(dsl, row).toContain(row);
    }
  });

  it('stays a reference and leaves the procedure to the skills that own it', async () => {
    const dsl = (await findSkill('slide-dsl'))!.content;
    for (const procedural of [
      'duplicate_scene',
      'generate_actions',
      'generate_scene',
      'list_scenes',
      'render_scene_preview',
    ]) {
      expect(dsl, procedural).not.toContain(procedural);
    }
    expect(flat(dsl)).toContain('the procedures that call the edit tools');
  });
});

/**
 * `slide-craft` is the design-law layer: no procedure of its own, no outline
 * constraints, just the rules a patched page still has to satisfy.
 */
describe('slide-craft', () => {
  it('is discoverable and routes as the design layer under the two edit skills', async () => {
    const all = await listSkills();
    const craft = all.find((s) => s.id === 'slide-craft');
    expect(craft).toBeTruthy();
    expect(availableSkillsPromptBlock(all)).toContain('<name>slide-craft</name>');
    expect(craft!.description).toContain('page-clone');
    expect(craft!.description).toContain('pro-editing');
    expect(flat(craft!.description)).toContain('not a procedure of its own');
    const description = craft!.description.toLowerCase();
    for (const trigger of ['contrast', 'patching slide elements', 'crowded']) {
      expect(description, trigger).toContain(trigger);
    }
  });

  it('is a page-craft skill, so it ships no outline constraints', async () => {
    const craft = (await findSkill('slide-craft'))!;
    expect(craft.constraints).toBeNull();
    expect(
      existsSync(
        join(process.cwd(), 'skills/agent-runtime/slide-craft', 'outline-constraints.json'),
      ),
    ).toBe(false);
  });

  it('carries the geometry and sizing numbers from the generation prompt', async () => {
    const craft = flat((await findSkill('slide-craft'))!.content);
    expect(craft).toContain('1000 × 562.5');
    expect(craft).toContain('**50px margin**');
    expect(craft).toContain('| 14px | 43 | 64 | 85 | 106 | 127 |');
    expect(craft).toContain('| 36px | 76 | 130 | 184 | 238 | 292 |');
    expect(craft).toContain('characters_per_line = (width - 20) / font_size');
    expect(craft).toContain('≤ 75%');
    expect(craft).toContain('text.left = shape.left + (shape.width - text.width) / 2');
    expect(craft).toContain('20px padding each side');
  });

  it('states the four renderer truths the generation prompt gets wrong for editors', async () => {
    const craft = flat((await findSkill('slide-craft'))!.content);
    expect(craft).toContain('render without markers');
    expect(craft).toContain('one `<p>` per item with the marker in the text');
    expect(craft).toContain('**`<h1>`–`<h6>` are inert.**');
    expect(craft).toContain('Stacked `<p>` tags have no gap between them');
    expect(craft).toContain('A newline in plain text is not a line break');
  });

  it('routes colour edits to the field the renderer actually reads', async () => {
    const craft = flat((await findSkill('slide-craft'))!.content);
    expect(craft).toContain('one write to the field the renderer actually reads');
    expect(craft).toContain('`defaultColor`');
    expect(craft).toContain('`text.defaultColor`');
    expect(craft).toContain('≥ 4.5:1');
    expect(craft).toContain('pale tint fill with dark same-hue text');
    expect(craft).toContain('fades the glyphs *and* the fill');
  });

  it('says there is no alignment operation, only numbers you compute', async () => {
    const craft = flat((await findSkill('slide-craft'))!.content);
    expect(craft).toContain('**There is no alignment operation.**');
    expect(craft).toContain('one path per call');
    expect(craft).toContain('not asking the page to tidy itself');
  });

  it('keeps each content kind on the element type that can render it', async () => {
    const craft = flat((await findSkill('slide-craft'))!.content);
    expect(craft).toContain('**Any mathematics is a latex element.**');
    expect(craft).toContain('**Table cells are plain text.**');
    expect(craft).toContain('rendered form is cached');
    expect(craft).toContain('re-renders the cached `html`');
    expect(craft).toContain('is stroke thickness, not length');
    expect(craft).toContain('`width × 3`');
  });

  it('gives density a diagnosis from the inventory, and a fix order', async () => {
    const craft = flat((await findSkill('slide-craft'))!.content);
    expect(craft).toContain('Diagnosing density from the inventory');
    expect(craft).toContain('Cut words before you grow boxes');
    expect(craft).toContain('shorten the words, then step to the next table row');
  });

  it('does not restate the procedures it serves', async () => {
    const craft = (await findSkill('slide-craft'))!;
    for (const procedural of [
      'duplicate_scene',
      'generate_actions',
      'generate_tts',
      'list_scenes',
    ]) {
      expect(craft.content, procedural).not.toContain(procedural);
    }
  });

  it('is referenced by both edit procedures', async () => {
    const all = await listSkills();
    for (const id of ['page-clone', 'pro-editing']) {
      expect(all.find((s) => s.id === id)!.content, id).toContain('slide-craft');
    }
  });

  it('points down to the field reference instead of restating it', async () => {
    const craft = flat((await findSkill('slide-craft'))!.content);
    expect(craft).toContain('`slide-dsl`');
    expect(craft).toContain('It says what you *may* write');
  });
});
