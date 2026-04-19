# Regenerate Slide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to edit a slide's indication, audio text, and media type in a dialog, then regenerate only that slide incrementally (content → audio → media) with a backup/review/accept flow.

**Architecture:** New synchronous endpoint `scene-content-only` generates raw slide layout without persisting; a client hook `useSceneRegenerator` orchestrates 4 pipeline steps updating Zustand state after each one; Stage manages an idle/dialog/regenerating/review state machine with backup/restore logic.

**Tech Stack:** Next.js App Router API routes, Zustand 5, Vercel AI SDK (`callLLM`), shadcn Dialog + RadioGroup + Textarea, existing `generateAndStoreTTS`, `generateSingleMedia` (newly exported from media-orchestrator).

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `app/api/generate/scene-content-only/route.ts` | **Create** | Synchronous slide content generation without persisting a scene |
| `app/api/generate/media-prompt/route.ts` | **Create** | Auto-generate a media prompt from an indication text |
| `lib/media/media-orchestrator.ts` | **Modify** | Export `generateSingleMedia` as `generateAndStoreMedia` |
| `lib/hooks/use-scene-regenerator.ts` | **Create** | 4-step client pipeline: content → actions → audio → media |
| `components/classroom/regenerate-slide-dialog.tsx` | **Create** | Edit dialog (indication, audio text, media selector + prompt) |
| `components/stage/scene-sidebar.tsx` | **Modify** | Add ↺ Regen. button below active slide thumbnail |
| `components/stage.tsx` | **Modify** | State machine, backup management, review bar, confirm modal |
| `tests/hooks/use-scene-regenerator.test.ts` | **Create** | Unit tests for pre-step outline building and audio split logic |

---

## Task 1: API endpoint `POST /api/generate/scene-content-only`

**Files:**
- Create: `app/api/generate/scene-content-only/route.ts`
- Test: `tests/api/scene-content-only.test.ts`

This synchronous endpoint wraps `generateSceneContentFromInput` and returns raw slide elements without creating or persisting a scene. It loads stage metadata and outlines from server storage, so the client only needs to send the edited outline.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/api/scene-content-only.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock storage backend
vi.mock('@/lib/server/storage', () => ({
  getStorageBackend: () => ({
    loadStage: vi.fn().mockResolvedValue({
      stage: { id: 'stage1', name: 'Test Stage', language: 'en-US' },
    }),
    loadOutlines: vi.fn().mockResolvedValue([
      { id: 'o1', type: 'slide', title: 'Slide 1', description: 'Desc', keyPoints: [], order: 1 },
    ]),
  }),
}));

// Mock generateSceneContentFromInput
vi.mock('@/lib/server/scene-content-generation', () => ({
  generateSceneContentFromInput: vi.fn().mockResolvedValue({
    content: { elements: [{ id: 'el1', type: 'text' }], background: undefined },
    effectiveOutline: { id: 'o1', type: 'slide', title: 'Slide 1', description: 'Desc', keyPoints: [], order: 1 },
    slideTheme: undefined,
  }),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromHeaders: vi.fn().mockResolvedValue({
    model: {},
    modelInfo: {},
    modelString: 'test-model',
  }),
}));

describe('POST /api/generate/scene-content-only', () => {
  it('returns elements and background for a valid outline', async () => {
    const { POST } = await import('@/app/api/generate/scene-content-only/route');
    const req = new Request('http://localhost/api/generate/scene-content-only', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-model': 'test-model' },
      body: JSON.stringify({
        outline: { id: 'o1', type: 'slide', title: 'Slide 1', description: 'Desc', keyPoints: [], order: 1 },
        stageId: 'stage1',
      }),
    });
    const res = await POST(req as never);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.elements).toBeDefined();
  });

  it('returns 400 when outline is missing', async () => {
    const { POST } = await import('@/app/api/generate/scene-content-only/route');
    const req = new Request('http://localhost/api/generate/scene-content-only', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stageId: 'stage1' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /home/ubuntu/dev/OpenMAIC && pnpm test -- tests/api/scene-content-only.test.ts --reporter=verbose
```

Expected: FAIL with "Cannot find module '@/app/api/generate/scene-content-only/route'"

- [ ] **Step 3: Create the endpoint**

```typescript
// app/api/generate/scene-content-only/route.ts
/**
 * Synchronous slide content generation — returns raw PPTElements without persisting a scene.
 * Used by the per-slide regeneration flow.
 */
import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { generateSceneContentFromInput } from '@/lib/server/scene-content-generation';
import { getStorageBackend } from '@/lib/server/storage';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import type { SceneOutline } from '@/lib/types/generation';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';

const log = createLogger('SceneContentOnly API');

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { outline, stageId, agents, themeId } = body as {
      outline: SceneOutline;
      stageId: string;
      agents?: AgentInfo[];
      themeId?: string;
    };

    if (!outline) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'outline is required');
    }
    if (!stageId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
    }

    // Load stage metadata and outlines from server storage
    const backend = getStorageBackend();
    const [stageData, savedOutlines] = await Promise.all([
      backend.loadStage(stageId),
      backend.loadOutlines(stageId),
    ]);

    const allOutlines = savedOutlines ?? [outline];
    const stageInfo = {
      name: stageData?.stage.name ?? '',
      description: stageData?.stage.description,
      language: stageData?.stage.language,
      style: stageData?.stage.style,
      themeId: themeId,
    };

    const { modelString, apiKey, baseUrl, providerType } = {
      modelString: req.headers.get('x-model') || undefined,
      apiKey: req.headers.get('x-api-key') || undefined,
      baseUrl: req.headers.get('x-base-url') || undefined,
      providerType: req.headers.get('x-provider-type') || undefined,
    };

    const result = await generateSceneContentFromInput({
      outline,
      allOutlines,
      stageId,
      stageInfo,
      agents,
      modelConfig: { modelString, apiKey, baseUrl, providerType },
    });

    // Return only the slide content fields (elements + background)
    const content = result.content as { elements?: unknown[]; background?: unknown };
    return apiSuccess({
      elements: content.elements ?? [],
      background: content.background,
    });
  } catch (error) {
    log.error('scene-content-only failed:', error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
cd /home/ubuntu/dev/OpenMAIC && pnpm test -- tests/api/scene-content-only.test.ts --reporter=verbose
```

Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/generate/scene-content-only/route.ts tests/api/scene-content-only.test.ts
git commit -m "feat: add scene-content-only endpoint for per-slide regeneration"
```

---

## Task 2: API endpoint `POST /api/generate/media-prompt`

**Files:**
- Create: `app/api/generate/media-prompt/route.ts`
- Test: `tests/api/media-prompt.test.ts`

This lightweight endpoint uses a brief LLM call to generate a media generation prompt from a slide's indication text. Used by the dialog when the user switches to a media type not present in the original slide.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/api/media-prompt.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/ai/llm', () => ({
  callLLM: vi.fn().mockResolvedValue({ text: 'A diagram showing React components' }),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromHeaders: vi.fn().mockResolvedValue({
    model: {},
    modelInfo: {},
    modelString: 'test-model',
  }),
}));

describe('POST /api/generate/media-prompt', () => {
  it('returns a generated prompt string', async () => {
    const { POST } = await import('@/app/api/generate/media-prompt/route');
    const req = new Request('http://localhost/api/generate/media-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-model': 'test-model' },
      body: JSON.stringify({
        indicationText: 'React components: props, state, re-render',
        mediaType: 'image',
        language: 'en-US',
      }),
    });
    const res = await POST(req as never);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(typeof data.data.prompt).toBe('string');
    expect(data.data.prompt.length).toBeGreaterThan(0);
  });

  it('returns 400 when indicationText is missing', async () => {
    const { POST } = await import('@/app/api/generate/media-prompt/route');
    const req = new Request('http://localhost/api/generate/media-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaType: 'image' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /home/ubuntu/dev/OpenMAIC && pnpm test -- tests/api/media-prompt.test.ts --reporter=verbose
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Create the endpoint**

```typescript
// app/api/generate/media-prompt/route.ts
/**
 * Auto-generates a media generation prompt from a slide indication text.
 * Used when the user picks a media type not present in the original slide.
 */
import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { callLLM } from '@/lib/ai/llm';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';

const log = createLogger('MediaPrompt API');

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { indicationText, mediaType, language } = body as {
      indicationText: string;
      mediaType: 'image' | 'video';
      language?: string;
    };

    if (!indicationText) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'indicationText is required');
    }
    if (!mediaType || (mediaType !== 'image' && mediaType !== 'video')) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'mediaType must be "image" or "video"');
    }

    const { model: languageModel } = await resolveModelFromHeaders(req);

    const mediaLabel = mediaType === 'image' ? 'image' : 'short video loop';
    const langHint = language ? ` The course language is ${language}.` : '';

    const result = await callLLM(
      {
        model: languageModel,
        system: `You are a visual media prompt writer. Given a slide description, write a concise prompt (1–2 sentences, max 30 words) for generating a ${mediaLabel} that visually represents the slide content. Respond with ONLY the prompt text — no quotes, no explanation.${langHint}`,
        prompt: indicationText,
        maxOutputTokens: 150,
      },
      'media-prompt',
    );

    const prompt = result.text.trim();
    log.info(`Generated media prompt for ${mediaType}: "${prompt.slice(0, 60)}..."`);

    return apiSuccess({ prompt });
  } catch (error) {
    log.error('media-prompt generation failed:', error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
cd /home/ubuntu/dev/OpenMAIC && pnpm test -- tests/api/media-prompt.test.ts --reporter=verbose
```

Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/generate/media-prompt/route.ts tests/api/media-prompt.test.ts
git commit -m "feat: add media-prompt endpoint for auto-generating media prompts"
```

---

## Task 3: Export `generateAndStoreMedia` from media-orchestrator

**Files:**
- Modify: `lib/media/media-orchestrator.ts`

The `generateSingleMedia` function already does everything needed for the hook (calls API, fetches blob, uploads to server, calls `markDone`). It just needs to be exported so the hook can call it directly.

- [ ] **Step 1: Export the function**

In `lib/media/media-orchestrator.ts`, change the internal function declaration from:

```typescript
async function generateSingleMedia(
  req: MediaGenerationRequest,
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
```

to:

```typescript
export async function generateAndStoreMedia(
  req: MediaGenerationRequest,
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
```

Then update the two internal callers in the same file (`generateMediaForOutlines` and `retryMediaTask`) to use the new name:

In `generateMediaForOutlines`, change:
```typescript
    await generateSingleMedia(req, stageId, abortSignal);
```
to:
```typescript
    await generateAndStoreMedia(req, stageId, abortSignal);
```

In `retryMediaTask`, change:
```typescript
  await generateSingleMedia(
```
to:
```typescript
  await generateAndStoreMedia(
```

- [ ] **Step 2: Verify no TypeScript errors**

```bash
cd /home/ubuntu/dev/OpenMAIC && pnpm exec tsc --noEmit 2>&1 | grep "media-orchestrator" | head -10
```

Expected: No errors for this file.

- [ ] **Step 3: Commit**

```bash
git add lib/media/media-orchestrator.ts
git commit -m "refactor: export generateAndStoreMedia from media-orchestrator"
```

---

## Task 4: `useSceneRegenerator` hook

**Files:**
- Create: `lib/hooks/use-scene-regenerator.ts`
- Test: `tests/hooks/use-scene-regenerator.test.ts`

This hook orchestrates the 4-step regeneration pipeline. Each step calls `store.updateScene()` so the user sees incremental progress.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/hooks/use-scene-regenerator.test.ts
import { describe, it, expect } from 'vitest';

// Pure helper functions extracted for unit testing

/** Serialise outline to indication textarea string */
function outlineToIndication(description: string, keyPoints: string[]): string {
  const bulletLines = keyPoints.map((k) => `• ${k}`).join('\n');
  return keyPoints.length > 0 ? `${description}\n${bulletLines}` : description;
}

/** Parse indication textarea string back to description + keyPoints */
function indicationToOutline(indication: string): { description: string; keyPoints: string[] } {
  const lines = indication.split('\n');
  const keyPoints: string[] = [];
  const descLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('• ')) {
      keyPoints.push(line.slice(2).trim());
    } else {
      descLines.push(line);
    }
  }
  return { description: descLines.join('\n').trim(), keyPoints };
}

/** Build outline.mediaGenerations from hook params */
function buildMediaGenerations(
  mediaType: 'none' | 'image' | 'video',
  mediaPrompt?: string,
) {
  if (mediaType === 'none') return [];
  const elementId = mediaType === 'image' ? 'gen_img_1' : 'gen_vid_1';
  return [{ elementId, type: mediaType, prompt: mediaPrompt ?? '' }];
}

/** Split audio override text by \n\n and map to speech action texts */
function applyAudioOverride(
  actions: Array<{ type: string; text?: string; id: string }>,
  audioOverride: string,
): Array<{ type: string; text?: string; id: string }> {
  const segments = audioOverride
    .split('\n\n')
    .map((s) => s.trim())
    .filter(Boolean);
  let segIdx = 0;
  return actions.map((a) => {
    if (a.type === 'speech' && a.text !== undefined && segIdx < segments.length) {
      return { ...a, text: segments[segIdx++] };
    }
    return a;
  });
}

describe('outlineToIndication', () => {
  it('joins description and key points with bullets', () => {
    const result = outlineToIndication('Intro to React', ['components', 'props']);
    expect(result).toBe('Intro to React\n• components\n• props');
  });

  it('returns only description when no key points', () => {
    expect(outlineToIndication('Just a description', [])).toBe('Just a description');
  });
});

describe('indicationToOutline', () => {
  it('parses bullets as keyPoints and plain lines as description', () => {
    const result = indicationToOutline('Intro to React\n• components\n• props');
    expect(result.description).toBe('Intro to React');
    expect(result.keyPoints).toEqual(['components', 'props']);
  });
});

describe('buildMediaGenerations', () => {
  it('returns empty array for none', () => {
    expect(buildMediaGenerations('none')).toEqual([]);
  });

  it('returns image entry with gen_img_1 elementId', () => {
    const result = buildMediaGenerations('image', 'A React diagram');
    expect(result[0].elementId).toBe('gen_img_1');
    expect(result[0].type).toBe('image');
    expect(result[0].prompt).toBe('A React diagram');
  });

  it('returns video entry with gen_vid_1 elementId', () => {
    const result = buildMediaGenerations('video', 'Animation showing React');
    expect(result[0].elementId).toBe('gen_vid_1');
    expect(result[0].type).toBe('video');
  });
});

describe('applyAudioOverride', () => {
  it('maps segments to speech actions by index', () => {
    const actions = [
      { type: 'spotlight', id: 's1' },
      { type: 'speech', text: 'original 1', id: 'sp1' },
      { type: 'speech', text: 'original 2', id: 'sp2' },
    ];
    const result = applyAudioOverride(actions, 'new segment 1\n\nnew segment 2');
    expect(result[1].text).toBe('new segment 1');
    expect(result[2].text).toBe('new segment 2');
  });

  it('keeps AI text when user provides fewer segments than actions', () => {
    const actions = [
      { type: 'speech', text: 'original 1', id: 'sp1' },
      { type: 'speech', text: 'original 2', id: 'sp2' },
    ];
    const result = applyAudioOverride(actions, 'only one segment');
    expect(result[0].text).toBe('only one segment');
    expect(result[1].text).toBe('original 2');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/ubuntu/dev/OpenMAIC && pnpm test -- tests/hooks/use-scene-regenerator.test.ts --reporter=verbose
```

Expected: FAIL — functions not defined yet.

- [ ] **Step 3: Create the hook (includes the tested pure helpers as exported utilities)**

```typescript
// lib/hooks/use-scene-regenerator.ts
'use client';

import { useRef, useState, useCallback } from 'react';
import { useStageStore } from '@/lib/store/stage';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useSettingsStore } from '@/lib/store/settings';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { generateAndStoreMedia } from '@/lib/media/media-orchestrator';
import { generateAndStoreTTS } from '@/lib/audio/generate-and-store-tts';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { createLogger } from '@/lib/logger';
import type { SceneOutline } from '@/lib/types/generation';
import type { Action, SpeechAction } from '@/lib/types/action';

const log = createLogger('SceneRegenerator');

// ── Pure helpers (also used by RegenerateSlideDialog) ──

/** Serialise an outline's indication into the dialog textarea format */
export function outlineToIndication(description: string, keyPoints: string[]): string {
  const bulletLines = keyPoints.map((k) => `• ${k}`).join('\n');
  return keyPoints.length > 0 ? `${description}\n${bulletLines}` : description;
}

/** Parse a textarea indication string back to description + keyPoints */
export function indicationToOutline(indication: string): {
  description: string;
  keyPoints: string[];
} {
  const lines = indication.split('\n');
  const keyPoints: string[] = [];
  const descLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('• ')) {
      keyPoints.push(line.slice(2).trim());
    } else {
      descLines.push(line);
    }
  }
  return { description: descLines.join('\n').trim(), keyPoints };
}

/** Build outline.mediaGenerations from the user's media selection */
export function buildMediaGenerations(
  mediaType: 'none' | 'image' | 'video',
  mediaPrompt?: string,
): SceneOutline['mediaGenerations'] {
  if (mediaType === 'none') return [];
  const elementId = mediaType === 'image' ? 'gen_img_1' : 'gen_vid_1';
  return [{ elementId, type: mediaType, prompt: mediaPrompt ?? '' }];
}

/** Override speech action texts with user-edited segments (split by \n\n, 1:1 by index) */
export function applyAudioOverride(actions: Action[], audioOverride: string): Action[] {
  const segments = audioOverride
    .split('\n\n')
    .map((s) => s.trim())
    .filter(Boolean);
  let segIdx = 0;
  return actions.map((a) => {
    if (a.type === 'speech' && segIdx < segments.length) {
      return { ...a, text: segments[segIdx++] } as SpeechAction;
    }
    return a;
  });
}

// ── Hook types ──

export interface RegenerateParams {
  outline: SceneOutline;
  audioTextOverride: string;
  mediaType: 'none' | 'image' | 'video';
  mediaPrompt?: string;
}

export type RegenerateProgress = 'idle' | 'content' | 'audio' | 'media' | 'done' | 'error';

export interface UseSceneRegeneratorReturn {
  regenerate: (sceneId: string, params: RegenerateParams) => Promise<void>;
  progress: RegenerateProgress;
  errorStep?: 'content' | 'audio' | 'media';
  cancel: () => void;
}

// ── Hook ──

function getApiHeaders(): HeadersInit {
  const config = getCurrentModelConfig();
  return {
    'Content-Type': 'application/json',
    'x-model': config.modelString || '',
    'x-provider-type': config.providerType || '',
  };
}

export function useSceneRegenerator(): UseSceneRegeneratorReturn {
  const abortRef = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<RegenerateProgress>('idle');
  const [errorStep, setErrorStep] = useState<'content' | 'audio' | 'media' | undefined>();

  const regenerate = useCallback(async (sceneId: string, params: RegenerateParams) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const signal = ctrl.signal;

    setProgress('content');
    setErrorStep(undefined);

    const store = useStageStore.getState();
    const stageId = store.stage?.id;
    const allOutlines = store.outlines;

    if (!stageId) {
      log.error('Cannot regenerate: no active stage');
      setProgress('error');
      setErrorStep('content');
      return;
    }

    // Pre-step: set outline.mediaGenerations based on user's media selection
    const outline: SceneOutline = {
      ...params.outline,
      mediaGenerations: buildMediaGenerations(params.mediaType, params.mediaPrompt),
    };

    // ── Step 1a: Generate slide content ──
    let contentData: { elements: unknown[]; background?: unknown };
    try {
      const contentRes = await fetch('/api/generate/scene-content-only', {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify({ outline, stageId }),
        signal,
      });
      const json = await contentRes.json();
      if (!contentRes.ok || !json.success) {
        throw new Error(json.error || `HTTP ${contentRes.status}`);
      }
      contentData = json.data;
    } catch (err) {
      if (signal.aborted) return;
      log.error('Step 1 (content) failed:', err);
      setProgress('error');
      setErrorStep('content');
      return;
    }

    if (signal.aborted) return;

    // ── Step 1b: Generate scene actions ──
    let newActions: Action[];
    let newContent: unknown;
    try {
      const actionsRes = await fetch('/api/generate/scene-actions', {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify({
          outline,
          allOutlines,
          content: contentData,
          stageId,
        }),
        signal,
      });
      const json = await actionsRes.json();
      if (!actionsRes.ok || !json.success || !json.scene) {
        throw new Error(json.error || `HTTP ${actionsRes.status}`);
      }
      newActions = json.scene.actions ?? [];
      newContent = json.scene.content;
    } catch (err) {
      if (signal.aborted) return;
      log.error('Step 1 (actions) failed:', err);
      setProgress('error');
      setErrorStep('content');
      return;
    }

    if (signal.aborted) return;

    // Immediately show new slide (without audio)
    store.updateScene(sceneId, { content: newContent as never, actions: newActions });

    // ── Step 2: Audio ──
    setProgress('audio');

    // Apply user audio text override and split long actions
    const overriddenActions = applyAudioOverride(newActions, params.audioTextOverride);
    const providerId = useSettingsStore.getState().ttsProviderId;
    const splitActions = splitLongSpeechActions(overriddenActions, providerId);

    for (const action of splitActions) {
      if (signal.aborted) return;
      if (action.type !== 'speech' || !(action as SpeechAction).text) continue;
      const speechAction = action as SpeechAction;
      const audioId = `tts_${speechAction.id}`;
      speechAction.audioId = audioId;
      try {
        const url = await generateAndStoreTTS(audioId, speechAction.text, signal);
        if (url) speechAction.audioUrl = url;
      } catch (err) {
        if (signal.aborted) return;
        log.warn('TTS failed for action', speechAction.id, ':', err);
        // Non-fatal: continue with remaining actions, slide is still visible
      }
      store.updateScene(sceneId, { actions: [...splitActions] });
    }

    // ── Step 3: Media ──
    if (params.mediaType !== 'none' && params.mediaPrompt) {
      if (signal.aborted) return;
      setProgress('media');
      const elementId = params.mediaType === 'image' ? 'gen_img_1' : 'gen_vid_1';
      const req = {
        elementId,
        type: params.mediaType as 'image' | 'video',
        prompt: params.mediaPrompt,
      };
      useMediaGenerationStore.getState().enqueueTasks(stageId, [req]);
      try {
        await generateAndStoreMedia(req, stageId, signal);
      } catch (err) {
        if (signal.aborted) return;
        log.warn('Media generation failed:', err);
        // Non-fatal: useMediaGenerationStore shows error state with retry option
      }
    }

    if (signal.aborted) return;

    // ── Step 4: Outline sync ──
    const updatedOutlines = allOutlines.map((o) => (o.order === outline.order ? outline : o));
    store.setOutlines(updatedOutlines);

    setProgress('done');
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setProgress('idle');
    setErrorStep(undefined);
  }, []);

  return { regenerate, progress, errorStep, cancel };
}
```

- [ ] **Step 4: Update the test to import from the hook**

Update `tests/hooks/use-scene-regenerator.test.ts` — replace the inline function declarations with imports:

```typescript
// tests/hooks/use-scene-regenerator.test.ts
import { describe, it, expect } from 'vitest';
import {
  outlineToIndication,
  indicationToOutline,
  buildMediaGenerations,
  applyAudioOverride,
} from '@/lib/hooks/use-scene-regenerator';

// ... (keep all the describe blocks exactly as written in Step 1, remove the inline function declarations)
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd /home/ubuntu/dev/OpenMAIC && pnpm test -- tests/hooks/use-scene-regenerator.test.ts --reporter=verbose
```

Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add lib/hooks/use-scene-regenerator.ts tests/hooks/use-scene-regenerator.test.ts
git commit -m "feat: add useSceneRegenerator hook with 4-step incremental pipeline"
```

---

## Task 5: `RegenerateSlideDialog` component

**Files:**
- Create: `components/classroom/regenerate-slide-dialog.tsx`

This dialog pre-loads the indication, audio text, and media type from the current outline and scene. When the user selects a media type not in the original slide, it calls `POST /api/generate/media-prompt` to auto-generate a prompt.

- [ ] **Step 1: Create the component**

```typescript
// components/classroom/regenerate-slide-dialog.tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useI18n } from '@/lib/hooks/use-i18n';
import { outlineToIndication, indicationToOutline } from '@/lib/hooks/use-scene-regenerator';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import type { Scene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';
import type { SpeechAction } from '@/lib/types/action';
import type { RegenerateParams } from '@/lib/hooks/use-scene-regenerator';

export interface RegenerateFormValues {
  indication: string;
  audioText: string;
  mediaType: 'none' | 'image' | 'video';
  mediaPrompt: string;
}

interface RegenerateSlideDialogProps {
  open: boolean;
  scene: Scene;
  outline: SceneOutline;
  initialValues?: RegenerateFormValues;
  onRegenerate: (params: RegenerateParams) => void;
  onClose: () => void;
}

function sceneToAudioText(scene: Scene): string {
  return (scene.actions ?? [])
    .filter((a): a is SpeechAction => a.type === 'speech' && !!a.text)
    .map((a) => a.text)
    .join('\n\n');
}

function outlineToMediaType(outline: SceneOutline): 'none' | 'image' | 'video' {
  const generations = outline.mediaGenerations ?? [];
  if (generations.some((g) => g.type === 'video')) return 'video';
  if (generations.some((g) => g.type === 'image')) return 'image';
  return 'none';
}

function outlineToMediaPrompt(outline: SceneOutline, mediaType: 'none' | 'image' | 'video'): string {
  if (mediaType === 'none') return '';
  const entry = (outline.mediaGenerations ?? []).find((g) => g.type === mediaType);
  return entry?.prompt ?? '';
}

export function RegenerateSlideDialog({
  open,
  scene,
  outline,
  initialValues,
  onRegenerate,
  onClose,
}: RegenerateSlideDialogProps) {
  const { t } = useI18n();

  const [indication, setIndication] = useState('');
  const [audioText, setAudioText] = useState('');
  const [mediaType, setMediaType] = useState<'none' | 'image' | 'video'>('none');
  const [mediaPrompt, setMediaPrompt] = useState('');
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);

  // Initialise form values on open
  useEffect(() => {
    if (!open) return;
    if (initialValues) {
      setIndication(initialValues.indication);
      setAudioText(initialValues.audioText);
      setMediaType(initialValues.mediaType);
      setMediaPrompt(initialValues.mediaPrompt);
    } else {
      setIndication(outlineToIndication(outline.description, outline.keyPoints));
      setAudioText(sceneToAudioText(scene));
      const mt = outlineToMediaType(outline);
      setMediaType(mt);
      setMediaPrompt(outlineToMediaPrompt(outline, mt));
    }
  }, [open, outline, scene, initialValues]);

  const generatePromptForType = useCallback(
    async (type: 'image' | 'video') => {
      setIsGeneratingPrompt(true);
      setMediaPrompt('');
      try {
        const config = getCurrentModelConfig();
        const res = await fetch('/api/generate/media-prompt', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-model': config.modelString || '',
            'x-provider-type': config.providerType || '',
          },
          body: JSON.stringify({
            indicationText: indication,
            mediaType: type,
            language: outline.language,
          }),
        });
        const json = await res.json();
        if (json.success && json.data?.prompt) {
          setMediaPrompt(json.data.prompt);
        }
      } catch {
        // Prompt stays empty; user can type it manually
      } finally {
        setIsGeneratingPrompt(false);
      }
    },
    [indication, outline.language],
  );

  const handleMediaTypeChange = useCallback(
    (value: 'none' | 'image' | 'video') => {
      setMediaType(value);
      if (value === 'none') {
        setMediaPrompt('');
        return;
      }
      // Check if original outline already has a prompt for this type
      const existingPrompt = outlineToMediaPrompt(outline, value);
      if (existingPrompt) {
        setMediaPrompt(existingPrompt);
      } else {
        generatePromptForType(value);
      }
    },
    [outline, generatePromptForType],
  );

  const handleSubmit = () => {
    const { description, keyPoints } = indicationToOutline(indication);
    const updatedOutline: SceneOutline = {
      ...outline,
      description,
      keyPoints,
    };
    onRegenerate({
      outline: updatedOutline,
      audioTextOverride: audioText,
      mediaType,
      mediaPrompt: mediaType !== 'none' ? mediaPrompt : undefined,
    });
    onClose();
  };

  const isSubmitDisabled = isGeneratingPrompt || (mediaType !== 'none' && !mediaPrompt.trim());

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-purple-700 dark:text-purple-300">
            ↺ {t('stage.regen.dialogTitle')} — {scene.title}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 px-1 py-2">
          {/* Indication */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('stage.regen.indication')}
            </Label>
            <Textarea
              value={indication}
              onChange={(e) => setIndication(e.target.value)}
              rows={4}
              className="resize-none text-sm"
              placeholder={t('stage.regen.indicationPlaceholder')}
            />
          </div>

          {/* Audio text */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('stage.regen.audioText')}
            </Label>
            <Textarea
              value={audioText}
              onChange={(e) => setAudioText(e.target.value)}
              rows={6}
              className="resize-none text-sm"
              placeholder={t('stage.regen.audioTextPlaceholder')}
            />
          </div>

          {/* Media selector */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('stage.regen.media')}
            </Label>
            <RadioGroup
              value={mediaType}
              onValueChange={handleMediaTypeChange as (v: string) => void}
              className="flex gap-3"
            >
              {(['none', 'image', 'video'] as const).map((opt) => (
                <div key={opt} className="flex items-center gap-1.5">
                  <RadioGroupItem value={opt} id={`media-${opt}`} />
                  <Label htmlFor={`media-${opt}`} className="text-sm cursor-pointer capitalize">
                    {t(`stage.regen.media${opt.charAt(0).toUpperCase() + opt.slice(1)}`)}
                  </Label>
                </div>
              ))}
            </RadioGroup>

            {mediaType !== 'none' && (
              <div className="space-y-1">
                {isGeneratingPrompt ? (
                  <p className="text-xs text-blue-500 dark:text-blue-400 animate-pulse">
                    ✨ {t('stage.regen.generatingPrompt')}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {outlineToMediaPrompt(outline, mediaType)
                      ? t('stage.regen.promptOriginal')
                      : t('stage.regen.promptAutoGenerated')}
                  </p>
                )}
                <Textarea
                  value={mediaPrompt}
                  onChange={(e) => setMediaPrompt(e.target.value)}
                  rows={3}
                  disabled={isGeneratingPrompt}
                  className="resize-none text-sm"
                  placeholder={t('stage.regen.mediaPromptPlaceholder')}
                />
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="pt-2">
          <Button variant="ghost" onClick={onClose}>
            {t('stage.regen.cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitDisabled}
            className="bg-purple-600 hover:bg-purple-700 text-white"
          >
            ↺ {t('stage.regen.regenerate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Add i18n strings**

In `lib/i18n/stage.ts`, add these keys to all three locales (`zh-CN`, `en-US`, `ca`). Find the existing `stage` section and add inside it:

**For `en-US`:**
```typescript
'stage.regen.dialogTitle': 'Regenerate',
'stage.regen.indication': 'Indication',
'stage.regen.indicationPlaceholder': 'Describe what this slide should cover…',
'stage.regen.audioText': 'Audio text',
'stage.regen.audioTextPlaceholder': 'Narration text for this slide…',
'stage.regen.media': 'Media',
'stage.regen.mediaNone': 'None',
'stage.regen.mediaImage': 'Image',
'stage.regen.mediaVideo': 'Video',
'stage.regen.generatingPrompt': 'Generating prompt…',
'stage.regen.promptOriginal': 'Original prompt loaded. You can modify it.',
'stage.regen.promptAutoGenerated': 'Auto-generated prompt. Edit if needed.',
'stage.regen.mediaPromptPlaceholder': 'Describe the image or video…',
'stage.regen.cancel': 'Cancel',
'stage.regen.regenerate': 'Regenerate',
'stage.regen.reviewBar': 'Regenerated version — pending acceptance',
'stage.regen.accept': 'Accept',
'stage.regen.undo': 'Undo',
'stage.regen.editAgain': 'Edit again',
'stage.regen.confirmTitle': 'Keep new version?',
'stage.regen.confirmBody': 'Slide "{title}" has a regenerated version pending acceptance. If you switch slides without accepting, the new version will be discarded.',
'stage.regen.confirmKeep': 'Yes, keep',
'stage.regen.confirmDiscard': 'Discard',
'stage.regen.buttonLabel': '↺ Regen.',
```

**For `ca`:**
```typescript
'stage.regen.dialogTitle': 'Regenerar',
'stage.regen.indication': 'Indicació',
'stage.regen.indicationPlaceholder': 'Descriu el que hauria de cobrir aquesta slide…',
'stage.regen.audioText': 'Text àudio',
'stage.regen.audioTextPlaceholder': 'Text de narració per a aquesta slide…',
'stage.regen.media': 'Media',
'stage.regen.mediaNone': 'Cap',
'stage.regen.mediaImage': 'Imatge',
'stage.regen.mediaVideo': 'Vídeo',
'stage.regen.generatingPrompt': 'Generant prompt…',
'stage.regen.promptOriginal': 'Prompt original recuperat. Pots modificar-lo.',
'stage.regen.promptAutoGenerated': 'Prompt generat automàticament. Edita\'l si cal.',
'stage.regen.mediaPromptPlaceholder': 'Descriu la imatge o el vídeo…',
'stage.regen.cancel': 'Cancel·lar',
'stage.regen.regenerate': 'Regenerar',
'stage.regen.reviewBar': 'Versió regenerada — pendent d\'acceptar',
'stage.regen.accept': 'Acceptar',
'stage.regen.undo': 'Desfer',
'stage.regen.editAgain': 'Tornar a editar',
'stage.regen.confirmTitle': 'Conservar la nova versió?',
'stage.regen.confirmBody': 'Slide "{title}" té una versió regenerada pendent d\'acceptar. Si canvies de slide sense acceptar, la nova versió es descartarà.',
'stage.regen.confirmKeep': 'Sí, conservar',
'stage.regen.confirmDiscard': 'Descartar',
'stage.regen.buttonLabel': '↺ Regen.',
```

**For `zh-CN`:**
```typescript
'stage.regen.dialogTitle': '重新生成',
'stage.regen.indication': '说明',
'stage.regen.indicationPlaceholder': '描述此幻灯片应涵盖的内容…',
'stage.regen.audioText': '音频文本',
'stage.regen.audioTextPlaceholder': '此幻灯片的旁白文本…',
'stage.regen.media': '媒体',
'stage.regen.mediaNone': '无',
'stage.regen.mediaImage': '图片',
'stage.regen.mediaVideo': '视频',
'stage.regen.generatingPrompt': '正在生成提示词…',
'stage.regen.promptOriginal': '已加载原始提示词，可以修改。',
'stage.regen.promptAutoGenerated': '自动生成的提示词，可按需编辑。',
'stage.regen.mediaPromptPlaceholder': '描述图片或视频…',
'stage.regen.cancel': '取消',
'stage.regen.regenerate': '重新生成',
'stage.regen.reviewBar': '已重新生成 — 等待确认',
'stage.regen.accept': '接受',
'stage.regen.undo': '撤销',
'stage.regen.editAgain': '重新编辑',
'stage.regen.confirmTitle': '保留新版本？',
'stage.regen.confirmBody': '幻灯片"{title}"有一个待确认的重新生成版本。如果切换幻灯片而不接受，新版本将被丢弃。',
'stage.regen.confirmKeep': '是，保留',
'stage.regen.confirmDiscard': '放弃',
'stage.regen.buttonLabel': '↺ 重新生成',
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/ubuntu/dev/OpenMAIC && pnpm exec tsc --noEmit 2>&1 | grep "regenerate-slide-dialog" | head -10
```

Expected: No errors for this file.

- [ ] **Step 4: Commit**

```bash
git add components/classroom/regenerate-slide-dialog.tsx lib/i18n/stage.ts
git commit -m "feat: add RegenerateSlideDialog component with media auto-prompt"
```

---

## Task 6: Add ↺ Regen. button to `SceneSidebar`

**Files:**
- Modify: `components/stage/scene-sidebar.tsx`

The button is shown only when the active scene is a slide and `regenState === 'idle'`. It is hidden (not disabled) during regeneration to prevent double-triggering.

- [ ] **Step 1: Add new props to `SceneSidebarProps`**

In `components/stage/scene-sidebar.tsx`, update the `SceneSidebarProps` interface at line 22:

```typescript
interface SceneSidebarProps {
  readonly collapsed: boolean;
  readonly onCollapseChange: (collapsed: boolean) => void;
  readonly onSceneSelect?: (sceneId: string) => void;
  readonly onRetryOutline?: (outlineId: string) => Promise<void>;
  readonly regenState?: 'idle' | 'regenerating' | 'review';
  readonly onRegenerateClick?: () => void;
}
```

- [ ] **Step 2: Destructure new props in the component function**

At line 33, update the destructured props:

```typescript
export function SceneSidebar({
  collapsed,
  onCollapseChange,
  onSceneSelect,
  onRetryOutline,
  regenState = 'idle',
  onRegenerateClick,
}: SceneSidebarProps) {
```

- [ ] **Step 3: Add the button below the active scene thumbnail**

After the closing `</div>` of the thumbnail area (the `<div className="relative aspect-video...">` block, around line 321), add the regen button:

```tsx
{/* ↺ Regen. button — only for active slide scenes when idle */}
{isActive && isSlide && regenState === 'idle' && onRegenerateClick && (
  <button
    onClick={(e) => {
      e.stopPropagation();
      onRegenerateClick();
    }}
    className="w-full mt-1 py-0.5 px-2 text-[10px] font-semibold rounded border border-purple-200 dark:border-purple-700 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/30 transition-colors flex items-center justify-center gap-1"
  >
    ↺ {t('stage.regen.buttonLabel')}
  </button>
)}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /home/ubuntu/dev/OpenMAIC && pnpm exec tsc --noEmit 2>&1 | grep "scene-sidebar" | head -5
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add components/stage/scene-sidebar.tsx
git commit -m "feat: add regen button to SceneSidebar for active slide scenes"
```

---

## Task 7: State machine + review bar in `Stage`

**Files:**
- Modify: `components/stage.tsx`

This is the main wiring task. It adds the regen state machine, backup logic, review bar, second AlertDialog, and integrates the dialog + hook.

- [ ] **Step 1: Add imports at the top of `components/stage.tsx`**

After the existing imports, add:

```typescript
import { useSceneRegenerator } from '@/lib/hooks/use-scene-regenerator';
import { RegenerateSlideDialog, type RegenerateFormValues } from '@/components/classroom/regenerate-slide-dialog';
import type { Scene } from '@/lib/types/stage';
```

(Note: `Scene` may already be imported — check and add only if missing.)

- [ ] **Step 2: Add regen state variables after the existing `useState` declarations (around line 100)**

```typescript
// Regenerate-slide state machine
type RegenState = 'idle' | 'dialog_open' | 'regenerating' | 'review';
const [regenState, setRegenState] = useState<RegenState>('idle');
const [backupScene, setBackupScene] = useState<Scene | null>(null);
const [lastRegenValues, setLastRegenValues] = useState<RegenerateFormValues | null>(null);
const [pendingRegenSceneId, setPendingRegenSceneId] = useState<string | null>(null);
```

- [ ] **Step 3: Add `useSceneRegenerator` hook call after the existing hook calls (around line 135)**

```typescript
const sceneRegenerator = useSceneRegenerator();
```

- [ ] **Step 4: Add regen handler callbacks before `gatedSceneSwitch` (around line 660)**

```typescript
/** Open the regeneration dialog for the current scene */
const openRegenerateDialog = useCallback(() => {
  if (!currentScene || currentScene.type !== 'slide') return;
  setRegenState('dialog_open');
}, [currentScene]);

/** Called when the dialog submits — starts the regeneration pipeline */
const handleRegenerate = useCallback(
  async (params: import('@/lib/hooks/use-scene-regenerator').RegenerateParams) => {
    if (!currentScene) return;
    // Store values for "Tornar a editar"
    const { outlineToIndication } = await import('@/lib/hooks/use-scene-regenerator');
    const outline = useStageStore.getState().outlines.find((o) => o.order === currentScene.order);
    setLastRegenValues({
      indication: outlineToIndication(params.outline.description, params.outline.keyPoints),
      audioText: params.audioTextOverride,
      mediaType: params.mediaType,
      mediaPrompt: params.mediaPrompt ?? '',
    });
    // Backup current scene before mutating
    setBackupScene({ ...currentScene });
    setRegenState('regenerating');
    await sceneRegenerator.regenerate(currentScene.id, params);
    setRegenState('review');
  },
  [currentScene, sceneRegenerator],
);

/** Accept the new version: clear backup, return to idle */
const handleRegenAccept = useCallback(() => {
  setBackupScene(null);
  setLastRegenValues(null);
  setRegenState('idle');
}, []);

/** Undo: restore backup scene to store, return to idle */
const handleRegenUndo = useCallback(() => {
  if (backupScene && currentScene) {
    useStageStore.getState().updateScene(currentScene.id, {
      content: backupScene.content,
      actions: backupScene.actions,
    });
  }
  setBackupScene(null);
  setLastRegenValues(null);
  setRegenState('idle');
}, [backupScene, currentScene]);

/** Reopen dialog with previously entered values */
const handleRegenEditAgain = useCallback(() => {
  setRegenState('dialog_open');
}, []);
```

- [ ] **Step 5: Update `gatedSceneSwitch` to intercept review state**

Find the existing `gatedSceneSwitch` callback (around line 668) and extend it to also check `regenState === 'review'`:

```typescript
const gatedSceneSwitch = useCallback(
  (targetSceneId: string): boolean => {
    if (targetSceneId === currentSceneId) return false;
    if (isTopicActive) {
      setPendingSceneId(targetSceneId);
      return false;
    }
    // If a regenerated version is pending review, show regen confirm dialog
    if (regenState === 'review') {
      setPendingRegenSceneId(targetSceneId);
      return false;
    }
    setCurrentSceneId(targetSceneId);
    return true;
  },
  [currentSceneId, isTopicActive, regenState, setCurrentSceneId],
);
```

- [ ] **Step 6: Add regen confirm handlers**

```typescript
/** User chose "Sí, conservar" in regen confirm modal */
const confirmRegenKeep = useCallback(() => {
  if (!pendingRegenSceneId) return;
  setBackupScene(null);
  setLastRegenValues(null);
  setRegenState('idle');
  setCurrentSceneId(pendingRegenSceneId);
  setPendingRegenSceneId(null);
}, [pendingRegenSceneId, setCurrentSceneId]);

/** User chose "Descartar" in regen confirm modal */
const confirmRegenDiscard = useCallback(() => {
  if (!pendingRegenSceneId) return;
  handleRegenUndo();
  setCurrentSceneId(pendingRegenSceneId);
  setPendingRegenSceneId(null);
}, [pendingRegenSceneId, handleRegenUndo, setCurrentSceneId]);
```

- [ ] **Step 7: Add `regenState` and `onRegenerateClick` props to `<SceneSidebar>` in the JSX (around line 936)**

Find the `<SceneSidebar` JSX and add the new props:

```tsx
<SceneSidebar
  collapsed={sidebarCollapsed}
  onCollapseChange={setSidebarCollapsed}
  onSceneSelect={gatedSceneSwitch}
  onRetryOutline={onRetryOutline}
  regenState={regenState === 'regenerating' ? 'regenerating' : regenState === 'review' ? 'review' : 'idle'}
  onRegenerateClick={openRegenerateDialog}
/>
```

- [ ] **Step 8: Add the review bar to the JSX, between the CanvasArea closing div and the Roundtable div (around line 993)**

```tsx
{/* Review bar — shown when a regenerated version is pending acceptance */}
{regenState === 'review' && (
  <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 bg-green-50 dark:bg-green-950/30 border-t border-green-200 dark:border-green-800 text-sm">
    <span className="text-green-700 dark:text-green-300 font-medium">
      {t('stage.regen.reviewBar')}
    </span>
    <div className="flex gap-2">
      <Button size="sm" variant="outline" onClick={handleRegenEditAgain}>
        ✏ {t('stage.regen.editAgain')}
      </Button>
      <Button size="sm" variant="outline" className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-700 dark:hover:bg-red-950/30" onClick={handleRegenUndo}>
        ↩ {t('stage.regen.undo')}
      </Button>
      <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white" onClick={handleRegenAccept}>
        ✓ {t('stage.regen.accept')}
      </Button>
    </div>
  </div>
)}
```

- [ ] **Step 9: Add the `RegenerateSlideDialog` to the JSX (below the existing `AlertDialog`)**

Find the closing `</AlertDialog>` (around line 1235) and add after it:

```tsx
{/* Regenerate Slide Dialog */}
{currentScene?.type === 'slide' && (regenState === 'dialog_open' || regenState === 'regenerating') && (
  (() => {
    const outline = useStageStore.getState().outlines.find((o) => o.order === currentScene.order);
    if (!outline) return null;
    return (
      <RegenerateSlideDialog
        open={regenState === 'dialog_open'}
        scene={currentScene}
        outline={outline}
        initialValues={lastRegenValues ?? undefined}
        onRegenerate={handleRegenerate}
        onClose={() => setRegenState('idle')}
      />
    );
  })()
)}

{/* Regen confirm modal — shown when navigating away during review */}
<AlertDialog open={!!pendingRegenSceneId}>
  <AlertDialogContent className="max-w-md rounded-2xl">
    <VisuallyHidden>
      <AlertDialogTitle>{t('stage.regen.confirmTitle')}</AlertDialogTitle>
    </VisuallyHidden>
    <div className="px-6 pt-6">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold text-gray-900 dark:text-gray-100 mb-1">
            {t('stage.regen.confirmTitle')}
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('stage.regen.confirmBody').replace('{title}', currentScene?.title ?? '')}
          </p>
        </div>
      </div>
    </div>
    <AlertDialogFooter className="px-6 pb-5 pt-3 flex-row gap-3">
      <AlertDialogCancel onClick={confirmRegenDiscard} className="flex-1 rounded-xl">
        {t('stage.regen.confirmDiscard')}
      </AlertDialogCancel>
      <AlertDialogAction
        onClick={confirmRegenKeep}
        className="flex-1 rounded-xl bg-green-600 hover:bg-green-700"
      >
        {t('stage.regen.confirmKeep')}
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

**Important:** The `RegenerateSlideDialog` usage above uses an IIFE to call a hook (`useStageStore`) inside JSX, which is invalid. Instead, derive the outline at the component level. Replace the dialog block with:

```tsx
{/* Regenerate Slide Dialog */}
{(() => {
  if (!currentScene || currentScene.type !== 'slide') return null;
  if (regenState !== 'dialog_open') return null;
  const outline = outlines.find((o) => o.order === currentScene.order);
  if (!outline) return null;
  return (
    <RegenerateSlideDialog
      open={true}
      scene={currentScene}
      outline={outline}
      initialValues={lastRegenValues ?? undefined}
      onRegenerate={handleRegenerate}
      onClose={() => setRegenState('idle')}
    />
  );
})()}
```

And add `outlines` to the destructure from `useStageStore` at the top:

```typescript
const { mode, getCurrentScene, scenes, outlines, currentSceneId, setCurrentSceneId, generatingOutlines } =
  useStageStore();
```

- [ ] **Step 10: Verify TypeScript compiles with no errors**

```bash
cd /home/ubuntu/dev/OpenMAIC && pnpm exec tsc --noEmit 2>&1 | grep -E "stage\.tsx|ERROR" | head -20
```

Expected: No errors.

- [ ] **Step 11: Run all tests to ensure no regressions**

```bash
cd /home/ubuntu/dev/OpenMAIC && pnpm test --reporter=verbose
```

Expected: All existing tests pass plus the new tests.

- [ ] **Step 12: Commit**

```bash
git add components/stage.tsx
git commit -m "feat: add regenerate-slide state machine, review bar, and confirm modal to Stage"
```

---

## Task 8: Manual verification (golden path)

Before declaring the feature complete, verify against the spec's test cases. You cannot use automated tools for UI testing — document what you see.

- [ ] **Start the dev server**

```bash
cd /home/ubuntu/dev/OpenMAIC && pnpm dev
```

- [ ] **Test case 1 — Happy path (no media)**

1. Open any course with at least one slide scene
2. Select a slide in the sidebar
3. Verify the ↺ Regen. button appears below the thumbnail
4. Click ↺ Regen. — dialog opens with indication + audio text pre-loaded
5. Edit the indication, press ↺ Regenerar
6. Verify: dialog closes, sidebar thumbnail shows spinner, canvas shows skeleton during generation
7. Verify: new slide appears, review bar is visible (Accept / Undo / Edit again)
8. Click ✓ Accept — bar disappears, regenState returns to idle
9. Click ↺ Regen. again → can open dialog again

- [ ] **Test case 2 — Undo**

1. Regenerate a slide (follow test case 1 steps 1–7)
2. Click ↩ Undo — original slide is restored, bar disappears

- [ ] **Test case 3 — Tornar a editar**

1. Regenerate a slide
2. In review state, click ✏ Edit again
3. Verify dialog reopens with the values you entered (not the original outline values)

- [ ] **Test case 4 — Navigate away during review (Descartar)**

1. Regenerate a slide, enter review state
2. Click a different scene in the sidebar
3. Verify: modal "Conservar la nova versió?" appears
4. Click Descartar — original slide restored, new scene selected

- [ ] **Test case 5 — Navigate away during review (Sí, conservar)**

1. Regenerate a slide, enter review state
2. Click a different scene in the sidebar
3. Verify: modal appears
4. Click Sí, conservar — new version kept, new scene selected

- [ ] **Test case 6 — Auto-prompt generation**

1. Open a slide that originally had no media
2. Open regen dialog, select Imatge in the media radio group
3. Verify: "✨ Generant prompt…" label appears
4. Verify: prompt arrives and textarea becomes editable
5. Verify: ↺ Regenerar button is disabled until prompt arrives

- [ ] **Final commit after manual verification**

```bash
git add -A
git commit -m "feat: regenerate-slide — complete feature implementation"
```
