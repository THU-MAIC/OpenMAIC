import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  isSlideContent,
  isQuizContent,
  type Scene,
  type SceneContent,
  type SceneType,
  type SlideContent,
  type QuizContent,
  type Whiteboard,
  type Action,
} from '@openmaic/dsl';

/**
 * Contract tests for the promoted stage / scene types.
 *
 * These pin the contract shape that the app (and future @openmaic/* consumers)
 * code against: the generic Scene defaults, the app-instantiation pattern,
 * the discriminant guards, and the Whiteboard Omit shape.
 */

const slideContent: SlideContent = {
  type: 'slide',
  canvas: {
    id: 's1',
    viewportSize: 1920,
    viewportRatio: 0.5625,
    theme: { themeColors: [], fontColor: '#000', fontName: 'Arial', backgroundColor: '#fff' },
    elements: [],
  },
};

const quizContent: QuizContent = {
  type: 'quiz',
  questions: [
    {
      id: 'q1',
      type: 'single',
      question: '2 + 2?',
      options: [
        { label: '3', value: 'A' },
        { label: '4', value: 'B' },
      ],
      answer: ['B'],
    },
  ],
};

describe('SceneContent (contract layer)', () => {
  it('is the universal two-way union (slide | quiz)', () => {
    const c: SceneContent = slideContent;
    const c2: SceneContent = quizContent;
    expect(c.type).toBe('slide');
    expect(c2.type).toBe('quiz');
  });
});

describe('discriminant guards', () => {
  it('isSlideContent narrows to SlideContent', () => {
    expect(isSlideContent(slideContent)).toBe(true);
    expect(isSlideContent(quizContent)).toBe(false);
  });

  it('isQuizContent narrows to QuizContent', () => {
    expect(isQuizContent(quizContent)).toBe(true);
    expect(isQuizContent(slideContent)).toBe(false);
  });

  it('narrows within a switch so the canvas is reachable', () => {
    const c: SceneContent = slideContent;
    if (isSlideContent(c)) {
      expect(c.canvas.id).toBe('s1');
    } else {
      expect.fail('expected slide content');
    }
  });

  it('accepts an app-widened content union (interactive / pbl kinds)', () => {
    // Regression: the generic Scene lets apps widen TContent beyond the
    // contract's slide|quiz, so the guards must accept that widened union too
    // (not just the narrow SceneContent).
    type InteractiveContent = { type: 'interactive'; url: string };
    type Widened = SceneContent | InteractiveContent;
    const c: Widened = { type: 'interactive', url: 'https://example.com' };
    expect(isSlideContent(c)).toBe(false);
    expect(isQuizContent(c)).toBe(false);
  });
});

describe('Scene<TAction, TContent> generic', () => {
  it('default Scene: optional actions (standard Action union), slide/quiz content', () => {
    // No type args: actions default to the standard `Action` union and stay
    // optional; content defaults to slide | quiz.
    const s: Scene = {
      id: 'sc1',
      stageId: 'stg1',
      type: 'slide',
      title: 'Intro',
      order: 0,
      content: slideContent,
    };
    expect(s.id).toBe('sc1');
    // actions is optional and, when absent, undefined.
    expect(s.actions).toBeUndefined();
  });

  it('app-instantiation pattern: inject an action set and a wider content union', () => {
    // Simulates the app's `type AppScene = Scene<Action, AppSceneContent>`.
    type AppAction = { id: string; kind: 'speech'; text: string };
    type InteractiveContent = { type: 'interactive'; url: string };
    type AppContent = SlideContent | QuizContent | InteractiveContent;

    const appScene: Scene<AppAction, AppContent> = {
      id: 'sc2',
      stageId: 'stg1',
      type: 'interactive',
      title: 'Widget',
      order: 1,
      content: { type: 'interactive', url: 'https://example.com' },
      actions: [{ id: 'a1', kind: 'speech', text: 'hello' }],
    };

    expect(appScene.content.type).toBe('interactive');
    expect(appScene.actions?.[0].kind).toBe('speech');
  });

  it('TAction defaults to the standard Action union so the default Scene carries playback actions', () => {
    // The default `Scene` exposes the contract's standard `Action` union on
    // `actions`. Pin the exact type so the default can't silently drift away
    // from the promoted action set.
    type DefaultScene = Scene;
    expectTypeOf<DefaultScene['actions']>().toEqualTypeOf<Action[] | undefined>();
  });

  it('skeleton-only consumers can still opt out of actions with Scene<never>', () => {
    // Renderers / importers that only care about the lesson skeleton reject
    // concrete actions by pinning `never`.
    type SkeletonScene = Scene<never>;
    expectTypeOf<SkeletonScene['actions']>().toEqualTypeOf<never[] | undefined>();
  });
});

describe('Whiteboard', () => {
  it('is Slide minus theme/turningMode/sectionTag/type', () => {
    // A full slide assigned to a Whiteboard slot must lose those four keys at
    // the type level (Omit). Constructing a Whiteboard without them works.
    const wb: Whiteboard = {
      id: 'wb1',
      viewportSize: 1920,
      viewportRatio: 0.5625,
      elements: [],
      // theme/turningMode/sectionTag/type intentionally absent — and rejected
      // by the Omit at the type level (not asserted here at runtime).
    };
    expect(wb.id).toBe('wb1');
  });
});

describe('SceneType', () => {
  it('covers all four scene kinds even though the contract content is only slide|quiz', () => {
    // The app relies on 'interactive' / 'pbl' being valid Scene.type values;
    // the contract keeps all four in SceneType even though their content
    // shapes are app-side.
    const types: SceneType[] = ['slide', 'quiz', 'interactive', 'pbl'];
    expect(types).toHaveLength(4);
  });
});
