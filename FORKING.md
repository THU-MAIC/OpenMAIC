# FORKING.md — Re-forking upstream into this repo

This guide is written for a future AI session (or human) who needs to pull in
updates from the upstream `THU-MAIC/OpenMAIC` repository without losing our
customisations. Read it end-to-end before touching anything.

---

## Why we fork

`thomhoffer-arch/OpenMAIC` is a fork of `THU-MAIC/OpenMAIC`. The upstream repo
is a general classroom AI engine. This fork adds:

- External API auth (`OPENMAIC_API_KEY` bearer token)
- CORS support for cross-origin calls from `learning.thomhoffer`
- A job-based `/api/generate-classroom` endpoint backed by Vercel Blob
- A dual-language generation pipeline (`language` = target spoken language,
  `explanationLanguage` = display/explanation language)
- Lithuanian TTS voice defaults (`lt-LT-OnaNeural`)
- iOS audio routing fix (`playsinline` attribute)
- Shared session memory: `HISTORY.md` + `CLAUDE.md` + Stop hook

---

## What is custom — file groups

### Group A — New files (no upstream equivalent, copy verbatim after merge)

```
lib/server/api-auth.ts
lib/server/cors.ts
lib/server/blob-store.ts
lib/server/classroom-job-store.ts
lib/server/classroom-job-runner.ts
lib/utils/fetch-retry.ts
lib/generation/prompts/templates/lesson-plan/system.md
lib/generation/prompts/templates/lesson-plan/user.md
app/api/generate-classroom/route.ts          (entire file — job endpoint)
app/api/generate-classroom/[jobId]/route.ts  (entire file — polling endpoint)
.claude/settings.json
.claude/branch-summary.sh
HISTORY.md
CLAUDE.md
FORKING.md
vercel.json
.env.example
```

### Group B — 1-line tweaks (re-apply after merge if overwritten)

| File | What to check / set |
|------|---------------------|
| `lib/i18n/types.ts` | `defaultLocale = 'en-US'` |
| `lib/audio/constants.ts` | `'azure-tts': 'lt-LT-OnaNeural'` in `DEFAULT_TTS_VOICES` |
| `package.json` | `build` script uses `next build --turbopack`; postinstall removed (pptxgenjs/mathml2omml not used) |
| `lib/utils/audio-player.ts` | `audio.setAttribute('playsinline', '')` after each `new Audio()` (2 places) |
| `lib/audio/use-tts-preview.ts` | `audio.setAttribute('playsinline', '')` after `new Audio(url)` |
| `lib/hooks/use-discussion-tts.ts` | `audio.setAttribute('playsinline', '')` after `new Audio(audioUrl)` |
| `lib/generation/prompts/templates/slide-actions/user.md` | Keep our language requirement line (speak only `{{language}}` target words) |
| `lib/generation/prompts/templates/quiz-actions/user.md` | Same as above |
| `lib/generation/prompts/templates/requirements-to-outlines/user.md` | Keep dual-language section (`{{language}}` vs `{{explanationLanguage}}`) |

### Group C — Structural additions requiring careful merge

These files exist upstream but we've added new fields or imports. Keep **both**
sides when resolving conflicts — our additions and upstream changes.

```
lib/types/generation.ts           explanationLanguage field in UserRequirements + SceneOutline
lib/server/classroom-generation.ts  lesson_plan type, explanationLanguage, agent lang
lib/generation/outline-generator.ts  explanationLanguage passed to buildPrompt
lib/generation/scene-generator.ts   language passed to SLIDE_ACTIONS + QUIZ_ACTIONS prompts
app/api/health/route.ts             corsOptionsHandler export
app/api/quiz-grade/route.ts         corsOptionsHandler + validateApiKey
All other app/api/*/route.ts        corsOptionsHandler export added
```

### Group D — Large rewrites (3-way merge required)

These files were significantly rewritten. The upstream version may have new
features; our version has new architecture. Do a careful 3-way diff.

```
lib/server/classroom-media-generation.ts  Vercel Blob for TTS/images + resolveTTSVoice()
lib/server/resolve-model.ts              fallback chain + overload detection
lib/ai/providers.ts                      overload error detection
```

---

## Step-by-step merge process

```bash
# 1. Add upstream as a remote (one-time setup)
git remote add upstream https://github.com/THU-MAIC/OpenMAIC.git

# 2. Fetch upstream
git fetch upstream

# 3. Create a merge branch from your current main
git checkout main
git checkout -b merge/upstream-$(date +%Y-%m-%d)

# 4. Merge upstream main into the branch (conflicts expected in Group C/D)
git merge upstream/main

# 5. Resolve conflicts (use VS Code merge editor or your tool of choice)
#    Group C files: keep BOTH sides (our additions AND upstream changes)
#    Group D files: carefully merge; preserve our new functions intact
#    When in doubt, keep our version and note the upstream change in a comment

# 6. After resolving all conflicts, stage them
git add -A

# 7. Restore Group A files that upstream overwrote or doesn't have
#    (replace `main` with whatever your production branch is called)
git checkout main -- \
  lib/server/api-auth.ts \
  lib/server/cors.ts \
  lib/server/blob-store.ts \
  lib/server/classroom-job-store.ts \
  lib/server/classroom-job-runner.ts \
  lib/utils/fetch-retry.ts \
  "lib/generation/prompts/templates/lesson-plan/system.md" \
  "lib/generation/prompts/templates/lesson-plan/user.md" \
  "app/api/generate-classroom/route.ts" \
  "app/api/generate-classroom/[jobId]/route.ts" \
  .claude/settings.json \
  .claude/branch-summary.sh \
  HISTORY.md CLAUDE.md FORKING.md vercel.json .env.example

# 8. Verify Group B tweaks survived (see table above)
#    Check each file; re-apply any that were overwritten

# 9. Build to catch TypeScript errors early
pnpm install
pnpm build

# 10. Commit and open a PR
git commit -m "Merge upstream/main into our fork"
git push -u origin merge/upstream-$(date +%Y-%m-%d)
```

---

## End-to-end verification checklist

After the merge, test these before merging to main:

- [ ] `pnpm build` completes with no TypeScript errors
- [ ] `GET /api/health` returns `200` with model info
- [ ] `POST /api/generate-classroom` with a valid `OPENMAIC_API_KEY` header starts a job
- [ ] `GET /api/generate-classroom/:jobId` polls correctly and returns the classroom when done
- [ ] TTS audio plays on desktop (no console errors)
- [ ] TTS audio plays on iPhone (volume goes up when pressing media volume, not ringer)
- [ ] UI language is English (not Chinese)
- [ ] Spoken words in the generated lesson are in the target language (e.g. Lithuanian)

---

## Adding a new teaching language

For each new target language (example: French `fr-FR`):

1. Add to `azureVoiceMap` in `lib/server/classroom-media-generation.ts`:
   ```ts
   'fr-FR': 'fr-FR-DeniseNeural',
   'fr': 'fr-FR-DeniseNeural',
   ```
2. Optionally add to `langNames` in `app/api/quiz-grade/route.ts` for better
   grading prompts:
   ```ts
   'fr-FR': 'French', 'fr': 'French',
   ```
3. Pass `"language": "fr-FR"` in the `/api/generate-classroom` request body.
4. That's it — the generation pipeline is fully generic.

---

## Key environment variables

```
OPENMAIC_API_KEY          # Bearer token learning.thomhoffer uses
DEFAULT_MODEL             # e.g. google:gemini-2.5-flash
GOOGLE_API_KEY
AZURE_TTS_KEY
AZURE_TTS_REGION
BLOB_READ_WRITE_TOKEN     # Vercel Blob
```

See `.env.example` for the full list.
