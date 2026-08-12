import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import {
  ELEMENT_DEFAULTS,
  normalizeElement,
  normalizeSlide,
  normalizeSlideWith,
  normalizeScene,
  normalizeStage,
  normalizePBLProject,
  isPBLProject,
  validateScene,
} from '@openmaic/dsl';
import type {
  PPTElement,
  Slide,
  Scene,
  Stage,
  SlideContent,
  Action,
  PBLProject,
  PBLContent,
} from '@openmaic/dsl';
// JS codegen helper (build-only); vitest/esbuild resolves it at runtime.
import { generateSchema } from '../scripts/gen-schema.mjs';

// A minimal, well-formed slide box shared by the element cases.
const box = { id: 'e1', left: 10, top: 20, width: 30, height: 40, rotate: 0 };

describe('normalizeElement — static defaults', () => {
  it('fills missing text defaults with the canonical values', () => {
    const out = normalizeElement({ ...box, type: 'text' }) as Extract<PPTElement, { type: 'text' }>;
    expect(out.defaultFontName).toBe(ELEMENT_DEFAULTS.text.defaultFontName);
    expect(out.defaultColor).toBe(ELEMENT_DEFAULTS.text.defaultColor);
    expect(out.content).toBe(ELEMENT_DEFAULTS.text.content);
  });

  it('fills missing image / shape / line static defaults', () => {
    const img = normalizeElement({ ...box, type: 'image', src: 's' }) as Extract<
      PPTElement,
      { type: 'image' }
    >;
    expect(img.fixedRatio).toBe(ELEMENT_DEFAULTS.image.fixedRatio);

    const shape = normalizeElement({ ...box, type: 'shape' }) as Extract<
      PPTElement,
      { type: 'shape' }
    >;
    expect(shape.fill).toBe(ELEMENT_DEFAULTS.shape.fill);
    expect(shape.fixedRatio).toBe(ELEMENT_DEFAULTS.shape.fixedRatio);

    const line = normalizeElement({ ...box, type: 'line' }) as Extract<
      PPTElement,
      { type: 'line' }
    >;
    expect(line.style).toBe(ELEMENT_DEFAULTS.line.style);
    expect(line.color).toBe(ELEMENT_DEFAULTS.line.color);
    expect(line.points).toEqual(ELEMENT_DEFAULTS.line.points);
  });

  it('does not clobber explicitly-set values', () => {
    const out = normalizeElement({
      ...box,
      type: 'text',
      content: '<p>hi</p>',
      defaultFontName: 'Inter',
      defaultColor: '#111827',
    }) as Extract<PPTElement, { type: 'text' }>;
    expect(out.content).toBe('<p>hi</p>');
    expect(out.defaultFontName).toBe('Inter');
    expect(out.defaultColor).toBe('#111827');
  });

  it('treats an empty opinionated string as absent and defaults it', () => {
    const out = normalizeElement({ ...box, type: 'text', defaultFontName: '' }) as Extract<
      PPTElement,
      { type: 'text' }
    >;
    expect(out.defaultFontName).toBe(ELEMENT_DEFAULTS.text.defaultFontName);
  });

  it('keeps a `false` boolean (only `undefined` is absent)', () => {
    const out = normalizeElement({ ...box, type: 'image', src: 's', fixedRatio: false }) as Extract<
      PPTElement,
      { type: 'image' }
    >;
    expect(out.fixedRatio).toBe(false);
  });

  it("keeps a shape's explicit empty fill — '' means no solid fill, not absent", () => {
    // Producers emit `fill: ''` deliberately (the importer for gradient /
    // image-filled / unfilled shapes); the renderer maps it to `none`.
    // Defaulting it would paint transparent shapes with the canonical color.
    const shape = normalizeElement({ ...box, type: 'shape', fill: '' }) as Extract<
      PPTElement,
      { type: 'shape' }
    >;
    expect(shape.fill).toBe('');
  });

  it('fills a present-but-empty shape text overlay (consumers read text.content unguarded)', () => {
    const out = normalizeElement({ ...box, type: 'shape', text: {} }) as Extract<
      PPTElement,
      { type: 'shape' }
    >;
    expect(out.text).toEqual(ELEMENT_DEFAULTS.shapeText);
  });

  it('keeps explicit shape text values and leaves an absent overlay absent', () => {
    const filled = normalizeElement({
      ...box,
      type: 'shape',
      text: { content: '<p>hi</p>', defaultFontName: 'Inter', defaultColor: '#111', align: 'top' },
    }) as Extract<PPTElement, { type: 'shape' }>;
    expect(filled.text).toMatchObject({
      content: '<p>hi</p>',
      defaultFontName: 'Inter',
      defaultColor: '#111',
      align: 'top',
    });

    const absent = normalizeElement({ ...box, type: 'shape' }) as Extract<
      PPTElement,
      { type: 'shape' }
    >;
    expect(absent.text).toBeUndefined();
  });

  it('throws on a malformed shape text overlay', () => {
    expect(() => normalizeElement({ ...box, type: 'shape', text: 'hello' })).toThrow(/text/);
    expect(() => normalizeElement({ ...box, type: 'shape', text: { content: 42 } })).toThrow(
      /text\.content/,
    );
    expect(() => normalizeElement({ ...box, type: 'shape', text: { align: 'center' } })).toThrow(
      /text\.align/,
    );
  });
});

describe('normalizeElement — derived geometry', () => {
  it('derives a line start/end in the local frame (origin + a box-spanning segment, NOT absolute left/top)', () => {
    const line = normalizeElement({ ...box, type: 'line' }) as Extract<
      PPTElement,
      { type: 'line' }
    >;
    // Local to the element's (left, top) origin: start at the origin, end spans
    // the box. Absolute [left, top] / [left+width, top] would double-offset it.
    expect(line.start).toEqual([0, 0]);
    expect(line.end).toEqual([30, 40]);
  });

  it('derives a shape viewBox (as a number pair) and a rectangle path from the box', () => {
    const shape = normalizeElement({ ...box, type: 'shape', width: 100, height: 50 }) as Extract<
      PPTElement,
      { type: 'shape' }
    >;
    expect(shape.viewBox).toEqual([100, 50]);
    expect(shape.path).toBe('M0 0 L100 0 L100 50 L0 50 Z');
  });

  it('falls back to 0 for missing box geometry rather than throwing', () => {
    const line = normalizeElement({ id: 'e', type: 'line' }) as Extract<
      PPTElement,
      { type: 'line' }
    >;
    expect(line.start).toEqual([0, 0]);
    expect(line.end).toEqual([0, 0]);
  });

  it('does not double-offset a line by its slide position (regression: absolute vs local)', () => {
    const line = normalizeElement({
      id: 'e',
      type: 'line',
      left: 500,
      top: 300,
      width: 80,
    }) as Extract<PPTElement, { type: 'line' }>;
    // The container is positioned at (left, top); start/end must stay local.
    expect(line.start).toEqual([0, 0]);
    expect(line.end).toEqual([80, 0]);
  });
});

describe('normalizeElement — fail loud on malformed input', () => {
  it('throws on a present-but-malformed line.points', () => {
    expect(() => normalizeElement({ ...box, type: 'line', points: ['x', 'y'] })).toThrow(/points/);
    expect(() => normalizeElement({ ...box, type: 'line', points: ['', '', ''] })).toThrow(
      /points/,
    );
  });

  it('throws on a string viewBox (the legacy `"0 0 w h"` shape the contract forbids)', () => {
    expect(() => normalizeElement({ ...box, type: 'shape', viewBox: '0 0 30 40' })).toThrow(
      /viewBox/,
    );
  });

  it('throws on a wrong-typed static field', () => {
    expect(() => normalizeElement({ ...box, type: 'image', src: 's', fixedRatio: 'yes' })).toThrow(
      /fixedRatio/,
    );
    expect(() => normalizeElement({ ...box, type: 'text', defaultColor: 123 })).toThrow(
      /defaultColor/,
    );
    expect(() => normalizeElement({ ...box, type: 'line', style: 'wavy' })).toThrow(/style/);
  });

  it('throws on a non-object or an unknown element type', () => {
    expect(() => normalizeElement(null)).toThrow();
    expect(() => normalizeElement({ id: 'e', type: 'bogus' })).toThrow(/unknown element type/);
  });

  it('passes non-defaulted element kinds through unchanged', () => {
    const code = { ...box, type: 'code', language: 'py', lines: [] };
    expect(normalizeElement(code)).toBe(code);
  });
});

describe('normalizeElement — purity', () => {
  it('never mutates its input', () => {
    const input = Object.freeze({ ...box, type: 'text' });
    expect(() => normalizeElement(input)).not.toThrow();
    expect(input).not.toHaveProperty('defaultFontName');
  });

  it('is idempotent', () => {
    const once = normalizeElement({ ...box, type: 'shape' });
    const twice = normalizeElement(once);
    expect(twice).toEqual(once);
  });
});

// The Ajv-compiled scene schema DOES check element required fields (the pure
// validators are structural only), so it is the sharpest proof that a
// normalized element actually satisfies the published contract.
describe('normalized elements satisfy the JSON Schema contract', () => {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(
    generateSchema('SerializedScene'),
  );
  const sceneWith = (elements: unknown[]) => ({
    id: 'sc',
    stageId: 'st',
    type: 'slide',
    title: 't',
    order: 0,
    content: {
      type: 'slide',
      canvas: {
        id: 'c',
        viewportSize: 1920,
        viewportRatio: 0.5625,
        theme: { themeColors: [], fontColor: '#000', fontName: 'Arial', backgroundColor: '#fff' },
        elements,
      },
    },
  });

  it('rejects an under-specified element but accepts it once normalized', () => {
    const bare = { ...box, type: 'text' }; // missing defaultFontName / defaultColor / content
    expect(validate(sceneWith([bare]))).toBe(false);
    expect(validate(sceneWith([normalizeElement(bare)]))).toBe(true);
  });

  it('accepts a bare line/shape once normalized (derived + static fields filled)', () => {
    // A line omits `height` / `rotate` (see PPTLineElement), so build it from a
    // line-shaped box rather than the full base box.
    const els = [
      { id: 'l', left: 10, top: 20, width: 30, type: 'line' },
      { ...box, id: 's', type: 'shape' },
    ].map(normalizeElement);
    expect(validate(sceneWith(els))).toBe(true);
  });
});

describe('document-level walkers', () => {
  const bareText = { ...box, type: 'text' } as unknown as PPTElement;
  const slide = (elements: PPTElement[]): Slide => ({
    id: 'c',
    viewportSize: 1920,
    viewportRatio: 0.5625,
    theme: { themeColors: [], fontColor: '#000', fontName: 'Arial', backgroundColor: '#fff' },
    elements,
  });

  it('normalizeSlide normalizes every element', () => {
    const out = normalizeSlide(slide([bareText]));
    expect((out.elements[0] as Extract<PPTElement, { type: 'text' }>).defaultFontName).toBe(
      ELEMENT_DEFAULTS.text.defaultFontName,
    );
  });

  it('normalizeSlide throws on a malformed element (use normalizeSlideWith to degrade)', () => {
    const bad = { ...box, type: 'text', defaultColor: 123 } as unknown as PPTElement;
    expect(() => normalizeSlide(slide([bad]))).toThrow(/defaultColor/);
  });

  it('normalizeSlide stays unary: point-free `slides.map(normalizeSlide)` type-checks and works', () => {
    // Regression for the API-ergonomics contract: an options parameter on
    // normalizeSlide itself would collide with map's index argument.
    const out = [slide([bareText]), slide([bareText])].map(normalizeSlide);
    expect(out).toHaveLength(2);
    expect((out[1].elements[0] as Extract<PPTElement, { type: 'text' }>).defaultFontName).toBe(
      ELEMENT_DEFAULTS.text.defaultFontName,
    );
  });

  it("normalizeSlideWith onInvalid: 'drop' drops the malformed element, keeps the rest, and reports it", () => {
    const bad = { ...box, id: 'bad', type: 'text', defaultColor: 123 } as unknown as PPTElement;
    const dropped: Array<{ element: unknown; error: unknown }> = [];
    const out = normalizeSlideWith({
      onInvalid: 'drop',
      onDropped: (element, error) => dropped.push({ element, error }),
    })(slide([bareText, bad]));
    expect(out.elements).toHaveLength(1);
    expect(out.elements[0].id).toBe(box.id);
    expect(dropped).toHaveLength(1);
    expect((dropped[0].element as { id: string }).id).toBe('bad');
    expect(String(dropped[0].error)).toMatch(/defaultColor/);
  });

  it("normalizeSlideWith onInvalid: 'drop' without onDropped drops without throwing", () => {
    const bad = { ...box, type: 'text', defaultColor: 123 } as unknown as PPTElement;
    const normalize = normalizeSlideWith({ onInvalid: 'drop' });
    expect(() => normalize(slide([bad]))).not.toThrow();
    expect(normalize(slide([bad])).elements).toHaveLength(0);
  });

  it('normalizeSlideWith without a drop policy is plain normalizeSlide (map-safe)', () => {
    expect(normalizeSlideWith({})).toBe(normalizeSlide);
    const bad = { ...box, type: 'text', defaultColor: 123 } as unknown as PPTElement;
    expect(() => [slide([bad])].map(normalizeSlideWith({}))).toThrow(/defaultColor/);
  });

  it('normalizeScene normalizes a slide scene canvas + whiteboards', () => {
    const scene: Scene = {
      id: 'sc',
      stageId: 'st',
      title: 't',
      order: 0,
      type: 'slide',
      content: { type: 'slide', canvas: slide([bareText]) },
      whiteboards: [slide([bareText])],
    };
    const out = normalizeScene(scene);
    const canvasEl = (out as Extract<Scene, { type: 'slide' }>).content.canvas
      .elements[0] as Extract<PPTElement, { type: 'text' }>;
    const wbEl = out.whiteboards![0].elements[0] as Extract<PPTElement, { type: 'text' }>;
    expect(canvasEl.defaultFontName).toBe(ELEMENT_DEFAULTS.text.defaultFontName);
    expect(wbEl.defaultFontName).toBe(ELEMENT_DEFAULTS.text.defaultFontName);
  });

  it('normalizeScene is callable on app-widened scenes and passes non-slide content through', () => {
    // App widens Scene's content with its own kinds (interactive / pbl). The
    // generic signature must accept them; non-slide content has no canvas to
    // normalize and passes through untouched.
    type AppContent = SlideContent | { type: 'interactive'; widget: string };
    const scene = {
      id: 'sc',
      stageId: 'st',
      title: 't',
      order: 0,
      type: 'interactive',
      content: { type: 'interactive', widget: 'w' },
      whiteboards: [slide([bareText])],
    } as unknown as Scene<Action, AppContent>;
    const out = normalizeScene(scene);
    expect((out.content as { widget: string }).widget).toBe('w');
    // whiteboards still get normalized even on a non-slide scene.
    expect(
      (out.whiteboards![0].elements[0] as Extract<PPTElement, { type: 'text' }>).defaultFontName,
    ).toBe(ELEMENT_DEFAULTS.text.defaultFontName);
  });

  it('normalizeStage normalizes every whiteboard', () => {
    const stage: Stage = {
      id: 'st',
      name: 'n',
      createdAt: 1,
      updatedAt: 2,
      whiteboard: [slide([bareText])],
    };
    const out = normalizeStage(stage);
    expect(
      (out.whiteboard![0].elements[0] as Extract<PPTElement, { type: 'text' }>).defaultFontName,
    ).toBe(ELEMENT_DEFAULTS.text.defaultFontName);
  });
});

describe('normalizePBLProject', () => {
  const unseeded = {
    title: 'Build a weather station',
    description: 'Create a small weather station.',
    learningObjective: 'Understand how sensors capture weather data.',
    gains: ['Connect a sensor', 'Interpret readings'],
    tags: ['science'],
    language: 'en-US',
    proficiency: 'beginner',
    roles: [{ id: 'instructor', type: 'instructor', name: 'Instructor' }],
    milestones: [
      {
        id: 'milestone-1',
        title: 'Assembly',
        order: 0,
        microtasks: [
          {
            id: 'task-1',
            title: 'Connect the sensor',
            hints: [],
            order: 0,
          },
        ],
      },
      {
        id: 'milestone-2',
        title: 'Analysis',
        order: 1,
        microtasks: [],
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('fills every missing canonical seed, including thread seats', () => {
    const out = normalizePBLProject(unseeded as unknown as PBLProject);
    expect(out.uiPhase).toBe('hero');
    expect(out.status).toBe('active');
    expect(out.milestones.map((milestone) => milestone.status)).toEqual(['active', 'locked']);
    expect(out.milestones[0].microtasks[0]).toMatchObject({ status: 'todo', assignee: 'user' });
    expect(out.submissions).toEqual([]);
    expect(out.evaluations).toEqual([]);
    expect(out.engagementEvents).toEqual([]);
    expect(out.threads).toEqual([{ agentId: 'instructor', messages: [] }]);
  });

  it('is pure and idempotent', () => {
    const once = normalizePBLProject(unseeded as unknown as PBLProject);
    const twice = normalizePBLProject(once);
    expect(twice).toEqual(once);
    expect(unseeded).not.toHaveProperty('uiPhase');
  });

  it('throws when design-authored fields are absent or status presence is mixed', () => {
    const { roles: _roles, ...withoutRoles } = unseeded;
    expect(() => normalizePBLProject(withoutRoles)).toThrow(/roles/);

    // Optional design fields normalize cleanly when absent and stay absent.
    const { learningObjective: _learningObjective, ...withoutObjective } = unseeded;
    const normalizedWithoutObjective = normalizePBLProject(withoutObjective);
    expect(normalizedWithoutObjective).not.toHaveProperty('learningObjective');
    expect(isPBLProject(normalizedWithoutObjective)).toBe(true);
    expect(() => normalizePBLProject({ ...unseeded, learningObjective: 42 })).toThrow(
      /learningObjective/,
    );

    expect(() =>
      normalizePBLProject({
        ...unseeded,
        milestones: [{ ...unseeded.milestones[0], status: 'active' }, unseeded.milestones[1]],
      }),
    ).toThrow(/milestones\[\]\.status/);

    expect(() =>
      normalizePBLProject({
        ...unseeded,
        milestones: [
          {
            ...unseeded.milestones[0],
            microtasks: [
              { ...unseeded.milestones[0].microtasks[0], status: 'todo' },
              { ...unseeded.milestones[0].microtasks[0], id: 'task-2' },
            ],
          },
          unseeded.milestones[1],
        ],
      }),
    ).toThrow(/microtasks\[\]\.status/);
  });

  it('produces projects accepted by both the runtime guard and scene validator', () => {
    const fullySeeded = {
      ...unseeded,
      uiPhase: 'workspace',
      status: 'review',
      milestones: unseeded.milestones.map((milestone, index) => ({
        ...milestone,
        status: index === 0 ? 'completed' : 'active',
        microtasks: milestone.microtasks.map((microtask) => ({
          ...microtask,
          status: 'completed',
          assignee: 'user',
        })),
      })),
      submissions: [],
      evaluations: [],
      threads: [{ agentId: 'instructor', messages: [] }],
      engagementEvents: [],
    };

    for (const input of [unseeded, fullySeeded]) {
      const project = normalizePBLProject(input);
      const scene = {
        id: 'pbl-scene',
        stageId: 'stage',
        title: project.title,
        order: 0,
        type: 'pbl',
        content: { type: 'pbl', projectV2: project },
      };
      expect(isPBLProject(project)).toBe(true);
      expect(validateScene(scene)).toEqual({ valid: true });
    }
  });

  it('throws on present-but-wrong-typed seeded fields', () => {
    expect(() => normalizePBLProject({ ...unseeded, status: 42 } as unknown as PBLProject)).toThrow(
      /status/,
    );
    expect(() =>
      normalizePBLProject({ ...unseeded, submissions: {} } as unknown as PBLProject),
    ).toThrow(/submissions/);
    expect(() =>
      normalizePBLProject({
        ...unseeded,
        threads: [{ agentId: 'instructor', messages: 'bad' }],
      } as unknown as PBLProject),
    ).toThrow(/messages/);
  });

  it('is wired into normalizeScene for PBL project payloads', () => {
    const scene = {
      id: 'pbl-scene',
      stageId: 'stage',
      title: 'Project',
      order: 0,
      type: 'pbl',
      content: { type: 'pbl', projectV2: unseeded },
    } as unknown as Scene<Action, PBLContent>;
    const out = normalizeScene(scene);
    if (out.content.type !== 'pbl') throw new Error('unreachable');
    expect(out.content.projectV2?.uiPhase).toBe('hero');
    expect(out.content.projectV2?.threads[0].messages).toEqual([]);
  });
});

// Pin the runtime defaults (ELEMENT_DEFAULTS, consumed by normalize) to the
// `@default` annotations the schema ships (consumed by non-TS validators). The
// two are separate sources — a JSDoc literal and a TS constant — so without this
// they could silently drift. The schema, derived from the annotated types, is
// the published side; ELEMENT_DEFAULTS must match it field for field.
describe('ELEMENT_DEFAULTS stays in lockstep with the schema `default` annotations', () => {
  const scene = generateSchema('SerializedScene') as {
    definitions: Record<string, { properties?: Record<string, { default?: unknown }> }>;
  };
  const defaultsOf = (typeName: string): Record<string, unknown> => {
    const props = scene.definitions[typeName]?.properties ?? {};
    const out: Record<string, unknown> = {};
    for (const [field, spec] of Object.entries(props)) {
      if ('default' in spec) out[field] = spec.default;
    }
    return out;
  };

  it('text', () => expect(defaultsOf('PPTTextElement')).toEqual(ELEMENT_DEFAULTS.text));
  it('image', () => expect(defaultsOf('PPTImageElement')).toEqual(ELEMENT_DEFAULTS.image));
  it('shape', () => expect(defaultsOf('PPTShapeElement')).toEqual(ELEMENT_DEFAULTS.shape));
  it('line', () => expect(defaultsOf('PPTLineElement')).toEqual(ELEMENT_DEFAULTS.line));
  it('shape text overlay', () =>
    expect(defaultsOf('ShapeText')).toEqual(ELEMENT_DEFAULTS.shapeText));
});
