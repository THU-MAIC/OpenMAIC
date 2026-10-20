import { describe, expect, it } from 'vitest';
import { collectCourseIssues, type CourseIssueScene } from '../src/course-issues.js';
import type { Action } from '../src/action.js';
import type { Slide } from '../src/slides.js';
const scene = (actions: Action[], elements: Slide['elements'] = []): CourseIssueScene => ({
  id: 's',
  stageId: 'c',
  title: 'Scene',
  order: 0,
  content: { type: 'slide', canvas: { elements } as Slide },
  actions,
});
const speech = { id: 'a', type: 'speech', text: 'Hello' } as const;
const issues = (s: CourseIssueScene) => collectCourseIssues({ scenes: [s] });
describe('current course issues', () => {
  it('clears missing narration when audio is added without mutating the course', () => {
    const s = scene([speech]);
    const before = structuredClone(s);
    expect(issues(s)).toMatchObject([
      {
        kind: 'speech-without-audio',
        sceneId: 's',
        actionId: 'a',
        severity: 'warning',
        source: 'document',
      },
    ]);
    expect(s).toEqual(before);
    expect(issues(scene([{ ...speech, audioId: 'asset-1' }]))).toEqual([]);
  });
  it('keeps empty speech as lint only and preserves other lint kinds', () => {
    expect(issues(scene([])).map((i) => i.kind)).toEqual(['empty-actions']);
    const s = scene([
      { ...speech, text: '  ' },
      { id: 'b', type: 'laser', elementId: '' },
      { id: 'd', type: 'discussion', topic: '' } as Action,
    ]);
    expect(issues(s).map((i) => i.kind)).toEqual([
      'empty-speech',
      'unbound-cue',
      'empty-discussion',
    ]);
  });
  it('honors legacy audio evidence but not invalidated audio', () => {
    expect(
      issues(scene([{ ...speech, audioUrl: 'https://example.com/audio.mp3' } as Action])),
    ).toEqual([]);
    expect(
      collectCourseIssues({ scenes: [scene([speech])] }, { hasLegacyAudio: () => true }),
    ).toEqual([]);
    expect(
      collectCourseIssues(
        { scenes: [scene([{ ...speech, audioInvalidated: true }])] },
        { hasLegacyAudio: () => true },
      ),
    ).toMatchObject([{ kind: 'speech-without-audio' }]);
    expect(issues(scene([speech]))[0].evidence).toBe('local-audio-unchecked');
  });
  it('clears dangling cues after rebinding', () => {
    const cue = { id: 'cue', type: 'spotlight', elementId: 'gone' } as const;
    const elements = [{ id: 'present', type: 'text' }] as Slide['elements'];
    expect(issues(scene([cue], elements))).toMatchObject([
      { kind: 'dangling-cue', elementId: 'gone', actionId: 'cue' },
    ]);
    expect(issues(scene([{ ...cue, elementId: 'present' }], elements))).toEqual([]);
  });
  it('detects placeholder slots and whiteboards, deduplicates video pairs and clears repaired media', () => {
    const s = scene([{ ...speech, audioId: 'audio' }], [
      { id: 'v', type: 'video', src: 'gen_vid_1', mediaRef: 'gen_vid_1' },
    ] as Slide['elements']);
    s.whiteboards = [{ elements: [{ id: 'img', type: 'image', src: 'gen_img_1' }] } as Slide];
    expect(issues(s)).toMatchObject([
      { kind: 'media-not-generated', elementId: 'v', severity: 'warning' },
      { kind: 'media-not-generated', elementId: 'img' },
    ]);
    s.content = {
      type: 'slide',
      canvas: { elements: [{ id: 'v', type: 'video', src: 'real', mediaRef: 'real' }] } as Slide,
    };
    s.whiteboards = [];
    expect(issues(s)).toEqual([]);
  });
  it('does not mistake URLs containing placeholder text for placeholders', () => {
    expect(
      issues(
        scene([{ ...speech, audioId: 'audio' }], [
          { id: 'img', type: 'image', src: 'https://example.com/gen_img_1.png' },
        ] as Slide['elements']),
      ),
    ).toEqual([]);
  });
});

it('keeps scene identities separate and includes background placeholders', () => {
  const a = scene([{ ...speech, audioId: 'audio' }]);
  a.content = {
    type: 'slide',
    canvas: {
      elements: [],
      background: { type: 'image', image: { src: 'gen_img_bg' } },
    } as unknown as Slide,
  };
  const b = { ...scene([speech]), id: 'other' };
  expect(collectCourseIssues({ scenes: [a, b] })).toMatchObject([
    { sceneId: 's', kind: 'media-not-generated' },
    { sceneId: 'other', kind: 'speech-without-audio' },
  ]);
});

it('handles quiz and interactive scenes without assuming a canvas exists', () => {
  for (const type of ['quiz', 'interactive', 'pbl'] as const) {
    expect(issues({ ...scene([speech]), content: { type } })).toMatchObject([
      { kind: 'speech-without-audio' },
    ]);
  }
});

it('does not call browser evidence for valid or blank speech, and ignores stale legacy URLs', () => {
  expect(
    issues(
      scene([
        { ...speech, audioInvalidated: true, audioUrl: 'https://example.com/stale' } as Action,
      ]),
    ),
  ).toMatchObject([{ kind: 'speech-without-audio' }]);
  expect(
    collectCourseIssues(
      { scenes: [scene([{ ...speech, audioId: 'current' }])] },
      {
        hasLegacyAudio: () => {
          throw new Error('unexpected lookup');
        },
      },
    ),
  ).toEqual([]);
});

it('uses playable video source precedence rather than stale placeholder slots', () => {
  for (const video of [
    { src: 'https://example.com/video.mp4', mediaRef: 'gen_vid_old' },
    { src: 'gen_vid_old', mediaRef: 'allocated-video' },
  ]) {
    expect(
      issues(
        scene([{ ...speech, audioId: 'audio' }], [
          { id: 'v', type: 'video', ...video },
        ] as Slide['elements']),
      ),
    ).toEqual([]);
  }
});
it('reports a play_video cue bound to an element that is not a video', () => {
  expect(
    issues(
      scene([{ id: 'play', type: 'play_video', elementId: 'text' }], [
        { id: 'text', type: 'text' },
      ] as Slide['elements']),
    ),
  ).toMatchObject([{ kind: 'dangling-cue', actionId: 'play', elementId: 'text' }]);
});

it('omits missing narration when disabled without hiding content lint or pending media', () => {
  const s = scene([speech, { ...speech, id: 'empty', text: '' }], [
    { id: 'v', type: 'video', src: 'gen_vid_pending' },
  ] as Slide['elements']);
  expect(collectCourseIssues({ scenes: [s] }, { narrationEnabled: false })).toMatchObject([
    { kind: 'empty-speech' },
    { kind: 'media-not-generated', severity: 'warning' },
  ]);
  expect(
    collectCourseIssues({ scenes: [s] }, { narrationEnabled: true }).map((i) => i.kind),
  ).toContain('speech-without-audio');
});

it('only marks unchecked evidence for actions eligible for legacy audio', () => {
  for (const action of [
    { ...speech, audioInvalidated: true },
    { ...speech, id: '' },
  ]) {
    const [issue] = issues(scene([action]));
    expect(issue.kind).toBe('speech-without-audio');
    expect(issue).not.toHaveProperty('evidence');
    expect(issue).not.toHaveProperty('detail');
  }
  const [checked] = collectCourseIssues(
    { scenes: [scene([speech])] },
    { hasLegacyAudio: () => false },
  );
  expect(checked).not.toHaveProperty('evidence');
});

it('gives issues stable distinct IDs across text edits, repairs and scene/action reordering', () => {
  const a = scene([speech, { ...speech, id: 'b', text: '' }]);
  const b = { ...scene([speech]), id: 'other' };
  const before = collectCourseIssues({ scenes: [a, b] });
  const ids = before.map((i) => i.id);
  expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
  a.actions = [
    { ...speech, id: 'b', text: '' },
    { ...speech, text: 'Changed' },
  ];
  expect(
    collectCourseIssues({ scenes: [b, a] })
      .map((i) => i.id)
      .sort(),
  ).toEqual([...ids].sort());
  a.actions = [{ ...speech, audioId: 'fixed' }];
  expect(collectCourseIssues({ scenes: [a, b] }).map((i) => i.id)).toEqual([before[2].id]);
  expect(issues(scene([speech]))[0].id).toBe(before[1].id);
});

it('distinguishes media issues in different slides and keeps IDs through whiteboard reordering', () => {
  const a = {
    id: 'board-a',
    elements: [{ id: 'img', type: 'image', src: 'gen_img_1' }],
    background: { type: 'image', image: { src: 'gen_img_background' } },
  } as Slide;
  const b = { ...a, id: 'board-b' };
  const s = scene([{ ...speech, audioId: 'audio' }]);
  s.whiteboards = [a, b];
  const before = issues(s).map((i) => i.id);
  expect(new Set(before).size).toBe(4);
  s.whiteboards = [b, a];
  expect(
    issues(s)
      .map((i) => i.id)
      .sort(),
  ).toEqual([...before].sort());
});

it('keeps valid action content clear and reports lint once per offending action in order', () => {
  expect(issues(scene([{ ...speech, audioId: 'audio' }]))).toEqual([]);
  expect(
    issues(
      scene([
        { ...speech, text: '' },
        { ...speech, id: 'spaces', text: '   ' },
        { id: 'cue', type: 'spotlight', elementId: '' },
        { id: 'discussion', type: 'discussion', topic: '' } as Action,
      ]),
    ).map(({ kind, actionId }) => ({ kind, actionId })),
  ).toEqual([
    { kind: 'empty-speech', actionId: 'a' },
    { kind: 'empty-speech', actionId: 'spaces' },
    { kind: 'unbound-cue', actionId: 'cue' },
    { kind: 'empty-discussion', actionId: 'discussion' },
  ]);
});
