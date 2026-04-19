# Regenerate Slide — Block Toggles + Title Editing

**Date:** 2026-04-12
**Branch:** `feat/regenerate-slide`
**Status:** Approved

---

## Context

The regenerate-slide dialog (`components/classroom/regenerate-slide-dialog.tsx`) already supports toggling audio regeneration and choosing what to do with media. This spec adds:

1. A **slide block toggle** (`regenerateSlide`) — mirrors the existing `modifyAudio` pattern. When OFF, content generation is skipped and the existing slide is preserved.
2. An **editable title field** inside the slide block — `outline.title` drives the visual title on the generated slide and `scene.title` in the sidebar. Currently immutable in the dialog.
3. A **conflict warning** when the user disables slide regeneration but requests new media on a slide that has no existing media slot.

---

## Scope

- `RegenerateSlideDialog` (`components/classroom/regenerate-slide-dialog.tsx`)
- `useSceneRegenerator` hook (`lib/hooks/use-scene-regenerator.ts`)
- i18n files for all 5 locales (ca, en-US, zh-CN, ja-JP, ru-RU)
- Unit tests (`tests/hooks/use-scene-regenerator.test.ts`)

No changes to API routes or the Prisma schema.

---

## UI Structure

```
┌─────────────────────────────────────────────────────────┐
│  ↺ Regenerar — [títol — actualitzat en temps real]     │
├─────────────────────────────────────────────────────────┤
│  SLIDE                       [Modificar slide ●──○]    │
│    Títol   [_____________input________________________] │
│    Indicació [___________textarea____________________] │
│    Tema    [selector…]                                  │
│  — (quan toggle OFF) —                                  │
│    "La slide actual es conservarà."                     │
│                                                         │
│  ⚠ warning (si media nova + slide sense slot existent) │
│                                                         │
│  TEXT ÀUDIO                  [Modificar narració ●──○] │
│    [textarea…]  [Generar amb IA]                        │
│                                                         │
│  MEDIA                                                  │
│    [No regen.] [Cap] [Imatge] [Vídeo]                   │
│    [textarea prompt si imatge/vídeo]                    │
├─────────────────────────────────────────────────────────┤
│  [Model] [Media]          [Cancel·lar] [↺ Regenerar]   │
└─────────────────────────────────────────────────────────┘
```

### Slide block toggle

- **Label:** `stage.regen.modifySlide` ("Modificar slide")
- Default: `true` (toggle ON — regenerates slide, same behavior as today)
- When **OFF**: hide indication textarea, title input, and theme selector; show `stage.regen.slideKeep` message
- When **ON**: show title `<Input>`, indication `<Textarea>`, theme `<Select>` (as today, plus the new title input above)

### Title input

- First field inside the slide block, above the indication textarea
- Label: `stage.regen.slideTitle` ("Títol")
- `<Input>` (single line), pre-loaded with `outline.title`
- The `<DialogTitle>` binds to the `title` state → updates live as the user types
- Only editable when `regenerateSlide = true`. When `regenerateSlide = false`, `title` passes through unchanged and the header shows the original `scene.title`

### Conflict warning

Shown as an amber banner between the slide block and the audio block when **all three** conditions hold:

1. `regenerateSlide === false`
2. `mediaType === 'image' || mediaType === 'video'`
3. `outlineToMediaType(outline) === 'none'` (slide has no existing media slot)

Text: `stage.regen.slideWarningMediaNeeded`

**Behavior on submit:** when the warning is active, `handleSubmit` sends `skipSlide: false` regardless of the toggle state. The slide is regenerated to create the media placeholder element. The warning informs the user of this automatic override.

---

## Type Changes

### `RegenerateFormValues`

```typescript
export interface RegenerateFormValues {
  title: string;             // NEW — outline.title, editable when regenerateSlide=true
  indication: string;
  regenerateSlide: boolean;  // NEW — toggle: skip content/actions generation when false
  audioText: string;
  modifyAudio: boolean;
  mediaType: 'none' | 'image' | 'video' | 'keep';
  mediaPrompt: string;
  themeId: string;
}
```

### `RegenerateParams`

```typescript
export interface RegenerateParams {
  outline: SceneOutline;
  audioTextOverride: string;
  mediaType: 'none' | 'image' | 'video' | 'keep';
  mediaPrompt?: string;
  skipAudio?: boolean;
  skipSlide?: boolean;       // NEW — when true, skip Steps 1a + 1b
  themeId?: string;
}
```

---

## Hook Changes (`use-scene-regenerator`)

### `skipSlide` logic

When `params.skipSlide === true`:

- Skip Step 1a (`POST /api/generate/scene-content-only`)
- Skip Step 1b (`POST /api/generate/scene-actions`)
- Use the **existing scene** from the store as `newContent` and `newActions` (pre-captured before any mutation)
- Steps 2 (audio) and 3 (media) run as normal against the existing content/actions

**Safety override:** if `skipSlide === true` but `mediaType !== 'none' && mediaType !== 'keep'` and the existing scene canvas has no image/video element — force Steps 1a + 1b anyway (same as `skipSlide = false`). This is a belt-and-suspenders guard; the dialog already prevents this via the warning + submit override.

**Media injection when `skipSlide = true` + new media + existing slot:**
In the normal flow, Step 1 generates the slide with a `gen_img_1`/`gen_vid_1` placeholder element; the `SlideRenderer` resolves it via `useMediaGenerationStore`. When the slide is NOT regenerated, the existing canvas element has its own `src` (old media URL). After Step 3 completes, the hook must:
1. Read the new media URL from `useMediaGenerationStore.getState()` for `elementId` `gen_img_1`/`gen_vid_1`
2. Find the first matching element type (image/video) in the existing scene canvas
3. Directly patch its `src` to the new URL via `store.updateScene(sceneId, { content: patchedContent })`

This avoids a `SlideRenderer` lookup mismatch between canvas elementId and the media store key.

### `scene.title` update

After Step 1b (or when using existing content in skip mode), include `title` in the `updateScene` call:

```typescript
store.getState().updateScene(sceneId, {
  title: outline.title,   // propagates edited title to sidebar
  content: newContent,
  actions: newActions,
});
```

When `skipSlide = true` and no title change is possible (title field is read-only when toggle OFF), this call is omitted for content/actions but the existing scene title is already correct.

---

## i18n — New Keys (5 locales)

| Key | ca | en-US | zh-CN | ja-JP | ru-RU |
|-----|-----|-------|-------|-------|-------|
| `slideTitle` | "Títol" | "Title" | "标题" | "タイトル" | "Заголовок" |
| `modifySlide` | "Modificar slide" | "Modify slide" | "修改幻灯片" | "スライドを変更" | "Изменить слайд" |
| `slideKeep` | "La slide actual es conservarà." | "Existing slide will be preserved." | "现有幻灯片将被保留。" | "既存のスライドが保持されます。" | "Существующий слайд будет сохранён." |
| `slideWarningMediaNeeded` | "Per afegir nova imatge/vídeo, la slide s'haurà de regenerar igualment." | "To add new image/video, the slide must also be regenerated." | "添加新图片/视频时，幻灯片也将被重新生成。" | "新しい画像/動画を追加するには、スライドも再生成する必要があります。" | "Для добавления нового изображения/видео слайд также будет регенерирован." |

---

## Initialisation Logic

On dialog open (`useEffect` on `open`):

```typescript
// existing
setIndication(outlineToIndication(outline.description, outline.keyPoints));
setAudioText(sceneToAudioText(scene));
setModifyAudio(false);
// new
setTitle(outline.title);
setRegenerateSlide(true);   // always default ON
```

When `initialValues` is provided (re-opening via "Tornar a editar"):

```typescript
setTitle(initialValues.title);
setRegenerateSlide(initialValues.regenerateSlide);
```

---

## `handleSubmit` in Dialog

```typescript
const handleSubmit = () => {
  const { description, keyPoints } = indicationToOutline(indication);
  const updatedOutline: SceneOutline = {
    ...outline,
    title: regenerateSlide ? title : outline.title,  // only update title if slide is being regenerated
    description,
    keyPoints,
  };

  // Conflict: media requested but no existing slot and slide toggle is OFF
  const hasExistingMedia = outlineToMediaType(outline) !== 'none';
  const needsNewMedia = mediaType === 'image' || mediaType === 'video';
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

---

## Unit Tests

Add cases in `tests/hooks/use-scene-regenerator.test.ts`:

1. `skipSlide: true` — Steps 1a and 1b are **not** called; existing scene content/actions used; audio step runs.
2. `skipSlide: true` + `mediaType: 'image'` + existing media slot — Steps 1a/1b skipped, media step runs.
3. `skipSlide: true` + `mediaType: 'image'` + **no** existing media slot — Steps 1a/1b run despite `skipSlide: true` (safety override).
4. `skipSlide: false` — full pipeline unchanged (regression).
5. Title update: `outline.title` change propagates to `store.updateScene` call.

---

## Verification

1. **Toggle OFF, audio unchanged, media keep:** dialog submits, no content generation call made, existing slide preserved, review bar appears.
2. **Toggle OFF, modify audio:** TTS regenerated for existing speech actions with new text; slide unchanged.
3. **Toggle OFF + new media + existing slot:** media generated and injected into existing slide; no content/actions regeneration.
4. **Toggle OFF + new media + no slot (warning shown):** warning amber banner visible; on submit, slide IS regenerated; media placeholder created and filled.
5. **Toggle ON + title edited:** `<DialogTitle>` updates live; regenerated slide shows new title; sidebar shows new title.
6. **"Tornar a editar":** `initialValues.title` and `initialValues.regenerateSlide` restored correctly.
7. **Regression — full regen (toggle ON, default):** identical behavior to pre-feature.
