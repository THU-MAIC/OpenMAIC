# Translation Guide

## Adding a new language

1. Copy `locales/en-US.json` to `locales/<code>.json` (e.g. `ja-JP.json`)
2. Append an entry to the end of the `supportedLocales` array in `locales.ts` — do not reorder existing entries, as the first locale for each language prefix (e.g. `zh-CN` for `zh`) is used as the default when the browser sends a bare language code:
   ```ts
   { code: 'ja-JP', label: '日本語', shortLabel: 'JA' },
   ```
3. Translate all values in the new JSON file. Keys must remain identical.

## Interpolation

This project uses i18next with the default double-brace syntax: `{{variable}}`.

Example: `"Hi, {{name}}"` will render as `"Hi, Alice"` when called with `t('key', { name: 'Alice' })`.

Do NOT remove or rename interpolation variables — they are referenced in code.

## Keys with design intent

Not every key needs explanation, but the following have non-obvious UX context that affects how they should be translated.

| Key | Where it appears | Translation notes |
|-----|-----------------|-------------------|
| `home.greetingWithName` | Top-left of homepage, clickable pill that opens nickname editor | This is a **call-to-action** — the greeting doubles as an entry point for users to set their nickname. The translation must include `{{name}}` and read naturally with the default nickname (see `profile.defaultNickname`). Avoid generic greetings that hide the name (e.g. don't translate as just "Welcome"). |
| `profile.defaultNickname` | Pre-filled in the greeting and the nickname input field | Shown before the user sets a real name. Pick a warm, gender-neutral word that: (1) feels natural in the greeting, (2) clearly signals "this is a placeholder you should replace". Avoid cold terms like "User" or formal terms like "Student". Examples: EN "Learner", ZH "同学". |
| `profile.bioPlaceholder` | Textarea placeholder in the profile editor | The bio is fed to the AI teacher to personalize lessons. The placeholder should hint at this — tell users *why* filling it in helps. |
| `pbl.chat.welcomeMessage` | First message from the Question Agent in PBL mode | Contains `{{title}}` (issue title) and `{{questions}}` (multi-line generated text). The `{{questions}}` block can be long — make sure surrounding text doesn't make the message feel cluttered. Keep the framing concise. |
| `pbl.chat.issueCompleteMessage` | System message when a PBL issue is completed | Contains `{{completed}}` and `{{next}}`. Should feel like a natural progression, not a mechanical status update. |
| `generation.textTruncated` / `generation.imageTruncated` | Toast warnings during PDF-based course generation | These are technical warnings shown briefly. Keep them short and factual. `textTruncated` has `{{n}}` (character count), `imageTruncated` has `{{total}}` and `{{max}}`. |
| `agentBar.readyToLearn` | Classroom page, above the agent role list | Conversational prompt to set the mood before class starts. Should feel inviting, not instructional. |
| `settings.agentsCollaboratingCount` | Settings panel, multi-agent mode description | Contains `{{count}}`. This is a status label, not a button — keep it descriptive. |
