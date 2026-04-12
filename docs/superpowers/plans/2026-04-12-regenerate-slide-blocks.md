# Regenerate Slide — Block Toggles + Title Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a slide block toggle and editable title field to the regenerate-slide dialog, plus `skipSlide` support in the regeneration hook.

**Architecture:** Three parallel changes: (1) i18n keys, (2) `resolveSkipSlide` pure helper + `RegenerateParams.skipSlide` in the hook, (3) UI updates to the dialog. Hook `skipSlide` logic wraps Steps 1a+1b; media re-renders automatically via the existing `useMediaGenerationStore` subscription in `SlideRenderer` (no canvas patching needed — `elementInfo.src === 'gen_img_1'` is the store key).

**Tech Stack:** React 19, TypeScript strict, Zustand 5, shadcn/ui (`Switch`, `Input`, `Label`), Vitest 4, i18n JSON (5 locales).

---

## File Map

| File | Change |
|------|--------|
| `lib/i18n/locales/ca.json` | Add 4 keys: `modifySlide`, `slideTitle`, `slideKeep`, `slideWarningMediaNeeded` |
| `lib/i18n/locales/en-US.json` | Same 4 keys |
| `lib/i18n/locales/zh-CN.json` | Same 4 keys |
| `lib/i18n/locales/ja-JP.json` | Same 4 keys |
| `lib/i18n/locales/ru-RU.json` | Same 4 keys |
| `lib/hooks/use-scene-regenerator.ts` | Add `skipSlide?: boolean` to `RegenerateParams`; export `resolveSkipSlide`; extend pre-step; wrap Steps 1a+1b; add `title` to `updateScene` |
| `tests/hooks/use-scene-regenerator.test.ts` | Add `resolveSkipSlide` test suite |
| `components/classroom/regenerate-slide-dialog.tsx` | Add `title`/`regenerateSlide` state; import `Input`; slide block toggle + title input; conflict warning; bind `DialogTitle` |

---

### Task 1: i18n — Add new regen keys to all 5 locales

**Files:**
- Modify: `lib/i18n/locales/ca.json`
- Modify: `lib/i18n/locales/en-US.json`
- Modify: `lib/i18n/locales/zh-CN.json`
- Modify: `lib/i18n/locales/ja-JP.json`
- Modify: `lib/i18n/locales/ru-RU.json`

Each file's `stage.regen` object currently ends with:
```json
"modifyAudio": "...",
"audioKeep": "...",
"generateNarration": "...",
"generatingNarration": "...",
"aiGenerationError": "...",
"aiModelHint": "..."
```

- [ ] **Step 1: Add keys to ca.json**

In `lib/i18n/locales/ca.json`, find the line `"modifyAudio": "Modificar narració",` and insert the 4 new keys immediately after it:

```json
      "modifyAudio": "Modificar narració",
      "modifySlide": "Modificar slide",
      "slideTitle": "Títol",
      "slideKeep": "La slide actual es conservarà.",
      "slideWarningMediaNeeded": "Per afegir nova imatge/vídeo, la slide s'haurà de regenerar igualment.",
```

- [ ] **Step 2: Add keys to en-US.json**

Find `"modifyAudio": "Modify narration",` and insert after:

```json
      "modifyAudio": "Modify narration",
      "modifySlide": "Modify slide",
      "slideTitle": "Title",
      "slideKeep": "Existing slide will be preserved.",
      "slideWarningMediaNeeded": "To add new image/video, the slide must also be regenerated.",
```

- [ ] **Step 3: Add keys to zh-CN.json**

Find `"modifyAudio": "修改旁白",` and insert after:

```json
      "modifyAudio": "修改旁白",
      "modifySlide": "修改幻灯片",
      "slideTitle": "标题",
      "slideKeep": "现有幻灯片将被保留。",
      "slideWarningMediaNeeded": "添加新图片/视频时，幻灯片也将被重新生成。",
```

- [ ] **Step 4: Add keys to ja-JP.json**

Find `"modifyAudio": "ナレーションを変更",` and insert after:

```json
      "modifyAudio": "ナレーションを変更",
      "modifySlide": "スライドを変更",
      "slideTitle": "タイトル",
      "slideKeep": "既存のスライドが保持されます。",
      "slideWarningMediaNeeded": "新しい画像/動画を追加するには、スライドも再生成する必要があります。",
```

- [ ] **Step 5: Add keys to ru-RU.json**

Find `"modifyAudio": "Изменить нарратив",` and insert after:

```json
      "modifyAudio": "Изменить нарратив",
      "modifySlide": "Изменить слайд",
      "slideTitle": "Заголовок",
      "slideKeep": "Существующий слайд будет сохранён.",
      "slideWarningMediaNeeded": "Для добавления нового изображения/видео слайд также будет регенерирован.",
```

- [ ] **Step 6: Commit**

```bash
git add lib/i18n/locales/ca.json lib/i18n/locales/en-US.json lib/i18n/locales/zh-CN.json lib/i18n/locales/ja-JP.json lib/i18n/locales/ru-RU.json
git commit -m "feat(regen): add i18n keys for slide block toggle and title"
```

---

### Task 2: Export `resolveSkipSlide` helper + update `RegenerateParams`

**Files:**
- Modify: `lib/hooks/use-scene-regenerator.ts`

- [ ] **Step 1: Add `skipSlide` to `RegenerateParams`**

In `lib/hooks/use-scene-regenerator.ts`, find the `RegenerateParams` interface (around line 69) and add the new field:

```typescript
export interface RegenerateParams {
  outline: SceneOutline;
  audioTextOverride: string;
  mediaType: 'none' | 'image' | 'video' | 'keep';
  mediaPrompt?: string;
  /** When true, skip TTS generation and preserve existing speech audio from the scene. */
  skipAudio?: boolean;
  /** When true, skip slide content + actions generation and preserve the existing slide. */
  skipSlide?: boolean;
  /** Theme to apply during content generation. Falls back to server-side stage default. */
  themeId?: string;
}
```

- [ ] **Step 2: Export `resolveSkipSlide` pure helper**

Add the following function to the "Pure helpers" section (after `applyAudioOverride`, before `// ── Types ──`):

```typescript
/**
 * Resolves the effective `skipSlide` value.
 * When new media is requested but the existing slide has no media slot,
 * the slide must be regenerated even if skipSlide was requested.
 */
export function resolveSkipSlide(
  skipSlide: boolean,
  mediaType: 'none' | 'image' | 'video' | 'keep',
  hasExistingMediaSlot: boolean,
): boolean {
  if (!skipSlide) return false;
  if (mediaType === 'none' || mediaType === 'keep') return true;
  // New media requested — only skip if there is already a media element to replace
  return hasExistingMediaSlot;
}
```

- [ ] **Step 3: Commit**

```bash
git add lib/hooks/use-scene-regenerator.ts
git commit -m "feat(regen): add skipSlide to RegenerateParams and export resolveSkipSlide helper"
```

---

### Task 3: Tests for `resolveSkipSlide`

**Files:**
- Modify: `tests/hooks/use-scene-regenerator.test.ts`

- [ ] **Step 1: Write failing tests**

Add the following test suite at the end of `tests/hooks/use-scene-regenerator.test.ts`:

```typescript
import {
  outlineToIndication,
  indicationToOutline,
  buildMediaGenerations,
  applyAudioOverride,
  resolveSkipSlide,
} from '@/lib/hooks/use-scene-regenerator';

// ... existing suites ...

describe('resolveSkipSlide', () => {
  it('returns false when skipSlide is false regardless of other args', () => {
    expect(resolveSkipSlide(false, 'image', true)).toBe(false);
    expect(resolveSkipSlide(false, 'none', false)).toBe(false);
  });

  it('returns true when skipSlide and mediaType is none', () => {
    expect(resolveSkipSlide(true, 'none', false)).toBe(true);
  });

  it('returns true when skipSlide and mediaType is keep', () => {
    expect(resolveSkipSlide(true, 'keep', false)).toBe(true);
  });

  it('returns true when skipSlide, new image requested, and existing slot present', () => {
    expect(resolveSkipSlide(true, 'image', true)).toBe(true);
  });

  it('returns true when skipSlide, new video requested, and existing slot present', () => {
    expect(resolveSkipSlide(true, 'video', true)).toBe(true);
  });

  it('returns false when skipSlide, new image requested, but no existing slot', () => {
    expect(resolveSkipSlide(true, 'image', false)).toBe(false);
  });

  it('returns false when skipSlide, new video requested, but no existing slot', () => {
    expect(resolveSkipSlide(true, 'video', false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
pnpm test -- tests/hooks/use-scene-regenerator.test.ts --reporter=verbose
```

Expected: 7 new tests fail with "resolveSkipSlide is not a function" (because the export doesn't exist yet — if you committed Task 2 first, they should PASS instead; run to confirm all pass).

- [ ] **Step 3: Verify all tests pass**

If Task 2 was completed first, tests should already pass. Confirm:

```bash
pnpm test -- tests/hooks/use-scene-regenerator.test.ts --reporter=verbose
```

Expected output: all tests PASS including the 7 new `resolveSkipSlide` tests.

- [ ] **Step 4: Commit**

```bash
git add tests/hooks/use-scene-regenerator.test.ts
git commit -m "test(regen): add resolveSkipSlide unit tests"
```

---

### Task 4: Hook — implement `skipSlide` + title in `updateScene`

**Files:**
- Modify: `lib/hooks/use-scene-regenerator.ts`

This task modifies the `regenerate` function inside `useSceneRegenerator`. Read the current implementation carefully before editing — there are several interdependent sections.

- [ ] **Step 1: Extend pre-step to capture existing scene when `skipSlide` is requested**

Find the pre-step block (around line 153) that starts with:
```typescript
if (params.skipAudio || params.mediaType === 'keep') {
```

Replace the entire pre-step block with:

```typescript
// Pre-step: capture existing data from the current scene before any update
const existingSpeechActions: SpeechAction[] = [];
type MediaElementInfo = { type: 'image' | 'video'; src: string };
const existingMediaElements: MediaElementInfo[] = [];
let oldSceneContent: SceneContent | null = null;
let oldSceneActions: Action[] | null = null;

if (params.skipAudio || params.mediaType === 'keep' || params.skipSlide) {
  const oldScene = store.getState().scenes.find((s) => s.id === sceneId);
  if (oldScene) {
    if (params.skipAudio) {
      for (const action of oldScene.actions ?? []) {
        if (action.type === 'speech') existingSpeechActions.push(action as SpeechAction);
      }
    }
    if ((params.mediaType === 'keep' || params.skipSlide) && oldScene.type === 'slide') {
      for (const el of (oldScene.content as SlideContent).canvas.elements) {
        if ((el.type === 'image' || el.type === 'video') && el.src) {
          existingMediaElements.push({ type: el.type, src: el.src });
        }
      }
    }
    if (params.skipSlide) {
      oldSceneContent = oldScene.content;
      oldSceneActions = [...(oldScene.actions ?? [])];
    }
  }
}
```

- [ ] **Step 2: Compute `effectiveSkipSlide` after the pre-step**

Immediately after the pre-step block (before `// Resolve the effective media type for the outline:`), add:

```typescript
// Resolve effective skipSlide: if new media is requested but there's no existing slot,
// we must regenerate the slide to create a placeholder element.
const effectiveSkipSlide = resolveSkipSlide(
  params.skipSlide ?? false,
  params.mediaType,
  existingMediaElements.length > 0,
);
```

- [ ] **Step 3: Wrap Steps 1a + 1b in `if (!effectiveSkipSlide)` block**

Find the section that starts at `// ── Step 1a: Generate slide content ──` and ends at the line:
```typescript
// Immediately show new slide content (without audio yet)
store.getState().updateScene(sceneId, { content: newContent, actions: newActions });
```

Replace that entire section (Steps 1a, 1b, keep-media injection, and the immediate `updateScene` call) with:

```typescript
// ── Steps 1a + 1b: Generate slide content and actions (or use existing) ──
let contentData: unknown;
let newActions: Action[];
let newContent: SceneContent;

if (effectiveSkipSlide) {
  // Use the existing scene — no content or actions regeneration
  if (!oldSceneContent || !oldSceneActions) {
    log.error('Cannot skipSlide: existing scene content not captured');
    setProgress('error');
    setErrorStep('content');
    return { success: false, error: 'Existing scene not found' };
  }
  newContent = oldSceneContent;
  newActions = oldSceneActions;
} else {
  // ── Step 1a: Generate slide content ──
  try {
    const contentRes = await fetch('/api/generate/scene-content-only', {
      method: 'POST',
      headers: getApiHeaders(),
      body: JSON.stringify({ outline, stageId, themeId: params.themeId }),
      signal,
    });
    const json = await contentRes.json();
    if (!contentRes.ok || !json.success) {
      throw new Error(json.error || `HTTP ${contentRes.status}`);
    }
    contentData = json.data;
  } catch (err) {
    if (signal.aborted) return { success: false };
    log.error('Step 1 (content) failed:', err);
    setProgress('error');
    setErrorStep('content');
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (signal.aborted) return { success: false };

  // ── Step 1b: Generate scene actions ──
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
    if (!json.scene.content) {
      throw new Error('Missing scene content in actions response');
    }
    newActions = json.scene.actions ?? [];
    newContent = json.scene.content;
  } catch (err) {
    if (signal.aborted) return { success: false };
    log.error('Step 1 (actions) failed:', err);
    setProgress('error');
    setErrorStep('content');
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (signal.aborted) return { success: false };

  // When keeping existing media, inject old src values into new content elements
  if (params.mediaType === 'keep' && existingMediaElements.length > 0 && newContent.type === 'slide') {
    const slideContent = newContent as SlideContent;
    const updatedElements = slideContent.canvas.elements.map((el) => {
      if (el.type === 'image') {
        const old = existingMediaElements.find((e) => e.type === 'image');
        if (old) return { ...el, src: old.src };
      } else if (el.type === 'video') {
        const old = existingMediaElements.find((e) => e.type === 'video');
        if (old) return { ...el, src: old.src };
      }
      return el;
    });
    newContent = { ...slideContent, canvas: { ...slideContent.canvas, elements: updatedElements } };
  }

  // Immediately show new slide content (without audio yet)
  store.getState().updateScene(sceneId, { title: outline.title, content: newContent, actions: newActions });
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
pnpm exec tsc --noEmit 2>&1 | grep "use-scene-regenerator"
```

Expected: no errors.

- [ ] **Step 5: Run existing tests to confirm no regression**

```bash
pnpm test -- tests/hooks/use-scene-regenerator.test.ts --reporter=verbose
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/hooks/use-scene-regenerator.ts
git commit -m "feat(regen): implement skipSlide in regeneration hook and propagate outline.title"
```

---

### Task 5: Dialog — slide block toggle + title input + conflict warning

**Files:**
- Modify: `components/classroom/regenerate-slide-dialog.tsx`

- [ ] **Step 1: Add `Input` import and new state fields**

At the top of `components/classroom/regenerate-slide-dialog.tsx`, add `Input` to the ui imports. Find the line:
```typescript
import { Textarea } from '@/components/ui/textarea';
```
Add after it:
```typescript
import { Input } from '@/components/ui/input';
```

Also add `resolveSkipSlide` to the import from `use-scene-regenerator`. Find:
```typescript
import { outlineToIndication, indicationToOutline } from '@/lib/hooks/use-scene-regenerator';
```
Replace with:
```typescript
import { outlineToIndication, indicationToOutline, resolveSkipSlide } from '@/lib/hooks/use-scene-regenerator';
```

- [ ] **Step 2: Update `RegenerateFormValues` interface**

Find:
```typescript
export interface RegenerateFormValues {
  indication: string;
  audioText: string;
  modifyAudio: boolean;
  mediaType: 'none' | 'image' | 'video' | 'keep';
  mediaPrompt: string;
  themeId: string;
}
```
Replace with:
```typescript
export interface RegenerateFormValues {
  title: string;
  indication: string;
  regenerateSlide: boolean;
  audioText: string;
  modifyAudio: boolean;
  mediaType: 'none' | 'image' | 'video' | 'keep';
  mediaPrompt: string;
  themeId: string;
}
```

- [ ] **Step 3: Add new state variables**

Find the state declarations block (around line 89):
```typescript
const [indication, setIndication] = useState('');
const [audioText, setAudioText] = useState('');
```
Add two new state lines immediately before `const [indication`:
```typescript
const [title, setTitle] = useState('');
const [regenerateSlide, setRegenerateSlide] = useState(true);
const [indication, setIndication] = useState('');
const [audioText, setAudioText] = useState('');
```

- [ ] **Step 4: Update `useEffect` initialisation**

Inside the `useEffect` that runs on `open`, find the `if (initialValues)` branch:
```typescript
    if (initialValues) {
      setIndication(initialValues.indication);
      setAudioText(initialValues.audioText);
      setModifyAudio(initialValues.modifyAudio);
      setMediaType(initialValues.mediaType);
      setMediaPrompt(initialValues.mediaPrompt);
      setThemeId(initialValues.themeId || defaultThemeId);
    } else {
      setIndication(outlineToIndication(outline.description, outline.keyPoints));
      setAudioText(sceneToAudioText(scene));
      setModifyAudio(false);
      const mt = outlineToMediaType(outline);
      setMediaType(mt);
      setMediaPrompt(mt === 'keep' ? '' : outlineToMediaPrompt(outline, mt));
      setThemeId(defaultThemeId);
    }
```
Replace with:
```typescript
    if (initialValues) {
      setTitle(initialValues.title);
      setRegenerateSlide(initialValues.regenerateSlide);
      setIndication(initialValues.indication);
      setAudioText(initialValues.audioText);
      setModifyAudio(initialValues.modifyAudio);
      setMediaType(initialValues.mediaType);
      setMediaPrompt(initialValues.mediaPrompt);
      setThemeId(initialValues.themeId || defaultThemeId);
    } else {
      setTitle(outline.title);
      setRegenerateSlide(true);
      setIndication(outlineToIndication(outline.description, outline.keyPoints));
      setAudioText(sceneToAudioText(scene));
      setModifyAudio(false);
      const mt = outlineToMediaType(outline);
      setMediaType(mt);
      setMediaPrompt(mt === 'keep' ? '' : outlineToMediaPrompt(outline, mt));
      setThemeId(defaultThemeId);
    }
```

- [ ] **Step 5: Compute derived warning flag**

Immediately before the `handleSubmit` function, add:
```typescript
  // Conflict: media requested without slide toggle, but slide has no existing media slot
  const hasExistingMedia = outlineToMediaType(outline) !== 'none';
  const needsNewMedia = mediaType === 'image' || mediaType === 'video';
  const showSlideWarning = !regenerateSlide && needsNewMedia && !hasExistingMedia;
```

- [ ] **Step 6: Update `handleSubmit`**

Find the entire `handleSubmit` function and replace it:
```typescript
  const handleSubmit = () => {
    const { description, keyPoints } = indicationToOutline(indication);
    const updatedOutline: SceneOutline = {
      ...outline,
      title: regenerateSlide ? title : outline.title,
      description,
      keyPoints,
    };
    const forceSlideRegen = !regenerateSlide && needsNewMedia && !hasExistingMedia;
    onRegenerate({
      outline: updatedOutline,
      audioTextOverride: modifyAudio ? audioText : '',
      mediaType,
      mediaPrompt: mediaType !== 'none' && mediaType !== 'keep' ? mediaPrompt : undefined,
      skipAudio: !modifyAudio,
      skipSlide: !regenerateSlide && !forceSlideRegen,
      themeId: themeId || undefined,
    });
  };
```

- [ ] **Step 7: Bind `DialogTitle` to the live `title` state**

Find in the JSX:
```tsx
          <DialogTitle className="text-purple-700 dark:text-purple-300">
            <span aria-hidden="true">↺</span> {t('stage.regen.dialogTitle')} — {scene.title}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('stage.regen.dialogTitle')} — {scene.title}
          </DialogDescription>
```
Replace both `{scene.title}` references with `{title}`:
```tsx
          <DialogTitle className="text-purple-700 dark:text-purple-300">
            <span aria-hidden="true">↺</span> {t('stage.regen.dialogTitle')} — {title}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('stage.regen.dialogTitle')} — {title}
          </DialogDescription>
```

- [ ] **Step 8: Replace the slide block section in the form**

Find the current `{/* Indication */}` section and the `{/* Theme selector */}` section that follow it. Replace both sections (from `{/* Indication */}` through the closing `)}` of the theme selector) with the new slide block that includes the toggle, title input, indication, and theme selector:

```tsx
          {/* Slide block */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('stage.regen.indication')}
              </Label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{t('stage.regen.modifySlide')}</span>
                <Switch
                  id="regen-modify-slide"
                  checked={regenerateSlide}
                  onCheckedChange={setRegenerateSlide}
                />
              </div>
            </div>
            {regenerateSlide ? (
              <>
                <div className="space-y-1">
                  <Label htmlFor="regen-title" className="text-xs text-muted-foreground">
                    {t('stage.regen.slideTitle')}
                  </Label>
                  <Input
                    id="regen-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>
                <Textarea
                  id="regen-indication"
                  value={indication}
                  onChange={(e) => setIndication(e.target.value)}
                  rows={4}
                  className="resize-none text-sm"
                  placeholder={t('stage.regen.indicationPlaceholder')}
                />
                {themes.length > 0 && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('stage.regen.theme')}
                    </Label>
                    <Select value={themeId} onValueChange={setThemeId}>
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue>
                          {(() => {
                            const active = themes.find((th) => th.id === themeId);
                            return active ? (
                              <span className="flex items-center gap-2">
                                <span
                                  className="w-3 h-3 rounded-sm border border-border/50 shrink-0"
                                  style={{ background: active.colors.primary }}
                                />
                                {active.name}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">{t('stage.regen.theme')}</span>
                            );
                          })()}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {themes.map((theme) => (
                          <SelectItem key={theme.id} value={theme.id}>
                            <span className="flex items-center gap-2">
                              <span
                                className="w-3 h-3 rounded-sm border border-border/50 shrink-0"
                                style={{ background: theme.colors.primary }}
                              />
                              {theme.name}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground py-1">
                {t('stage.regen.slideKeep')}
              </p>
            )}
          </div>

          {/* Conflict warning: new media requested but slide has no existing media slot */}
          {showSlideWarning && (
            <div className="mx-1 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-sm text-amber-700 dark:text-amber-300">
              ⚠ {t('stage.regen.slideWarningMediaNeeded')}
            </div>
          )}
```

- [ ] **Step 9: TypeScript check**

```bash
pnpm exec tsc --noEmit 2>&1 | grep "regenerate-slide-dialog"
```

Expected: no errors.

- [ ] **Step 10: Run full unit test suite**

```bash
pnpm test --reporter=verbose
```

Expected: all tests PASS.

- [ ] **Step 11: Commit**

```bash
git add components/classroom/regenerate-slide-dialog.tsx
git commit -m "feat(regen): add slide block toggle, title input, and conflict warning to dialog"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Slide block toggle (`regenerateSlide` / `modifySlide` switch) — Task 5
- [x] Editable title field — Task 5
- [x] `<DialogTitle>` live binding — Task 5 Step 7
- [x] Conflict warning (amber banner) — Task 5 Step 8
- [x] `RegenerateFormValues.title` + `regenerateSlide` — Task 5 Steps 2–4
- [x] `RegenerateParams.skipSlide` — Task 2
- [x] `resolveSkipSlide` pure helper — Task 2 + Task 3
- [x] Hook: skip Steps 1a+1b when `effectiveSkipSlide` — Task 4
- [x] Hook: `title: outline.title` in `updateScene` — Task 4 Step 3
- [x] `forceSlideRegen` logic in `handleSubmit` — Task 5 Step 6
- [x] `initialValues` includes `title` and `regenerateSlide` — Task 5 Step 4
- [x] i18n: 4 new keys × 5 locales — Task 1
- [x] Unit tests for `resolveSkipSlide` — Task 3

**Placeholder scan:** No TBD, no TODO, no "similar to above", all code blocks complete.

**Type consistency:**
- `resolveSkipSlide` exported in Task 2, imported in Task 5 Step 1 ✓
- `RegenerateFormValues.title` defined in Task 5 Step 2, read in Task 5 Step 4 ✓
- `RegenerateParams.skipSlide` defined in Task 2, set in Task 5 Step 6, consumed in Task 4 ✓
- `effectiveSkipSlide` computed in Task 4 Step 2, used in Task 4 Step 3 ✓
- `oldSceneContent`/`oldSceneActions` captured in Task 4 Step 1, used in Task 4 Step 3 ✓
- `showSlideWarning` computed in Task 5 Step 5, used in Task 5 Steps 6 and 8 ✓
