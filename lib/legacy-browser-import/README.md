# One-way legacy browser import (temporary)

Earlier builds could keep courses in the browser (IndexedDB). Persistence is now
server-only, so on the first load after an upgrade this module moves whatever the
browser still holds to the server, for the owner the server resolves (the
anonymous cookie owner by default). It is automatic and silent: there is no
banner, dialog or opt-in, and a course simply appears in the library once it is on
the server. Problems are logged with `console.warn` under the prefix
`[legacy-browser-import]`.

It runs **once per browser; the server binds the browser to the first owner; a
claim carries the binding to the account.** The ledger holds a random 128-bit
browser id and no owner information. A run first asks
`POST /api/identity/legacy-import-binding` (`{ browserId }`): one atomic insert
into `legacy_import_bindings` binds the id to the requesting owner unless another
owner holds it, and the answer says only whether the requesting owner holds it
now. It binds only an owner the browser already presents: a binding request
that arrives without an owner cookie (and so mints one) answers `409
OWNER_NOT_ESTABLISHED`, and the run is retried on a later load. The page
response establishes the owner cookie before any script runs
(`lib/server/identity/navigation.ts`), so this is the exception. A claim
participant re-keys the claimed owner's bindings to the account in the claim
transaction. Every other request the importer sends carries the id in
`X-OpenMAIC-Legacy-Import`, and owner resolution
(`lib/server/identity/with-owner.ts`) refuses it with `409
LEGACY_IMPORT_NOT_BOUND` unless the owner the request resolves to holds the
binding. So the data can reach no other owner, whatever the page believes the
owner is: a cookie switch in another tab, a stale page, a tab that lost the race.
The importer uses its own fenced clients (`server.ts`), never the app's
persistence seams, and asks for the runtime learner key during each run. It
opens the old databases only once the server bound the browser to this owner;
a browser whose data another owner holds asks again only every ten minutes
(`OTHER_OWNER_RECHECK_MS`), which is when an account a claim moved the binding
to picks the import up. The delay is in the browser's ledger, which names no
owner, so an owner that holds the binding and loads right after a refused one
also waits for it.

It is **temporary** and will be deleted a few releases after it ships (see
[Removal](#removal)).

## What it reads (never writes)

Through the read-only module `lib/legacy-browser-storage/`:

| Source                                      | Imported as                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `maic-documents` (browser document store)   | the course document (preferred when a course is also in the old tables) |
| `MAIC-Database` stages, scenes, outlines    | the course document (canonicalized as the lazy migration did)           |
| `MAIC-Database` `generatedAgents`           | the stage roster, merged with `mergeLegacyAgentFallbacks`               |
| `MAIC-Database` `chatSessions`              | chat sessions, through `loadChatSessions` with a read-only legacy store |
| `MAIC-Database` `playbackState`             | the device playback cursor, through `loadCursor`                        |
| `MAIC-Database` `folders`, `stageFolders`   | server folders (matched by name) and folder membership                  |
| `maic-runtime` (by the old device learner key) | server runtime sessions for the server-derived learner key           |
| `maic-asset-pool`, `mediaFiles`, `audioFiles` | server assets; the document is rewritten to the allocated ids        |
| `mediaFiles` failure and refused rows, `autoVoiceCache` | the device cache (`maic-device-cache`), current shape       |
| `quizDraft:` / `quizAnswers:` / `quizResults:` / `quizAttemptId:` keys | quiz attempts in the runtime store         |

Media bytes are uploaded with `commitToPool` and written back with the existing
funnels (`persistGeneratedMediaReference`, `persistNarrationReference`), so a
document ends up exactly as the normal save path leaves it. The same pass also
converts server documents from earlier opt-in server builds that still carry
`gen_*` placeholders or derived narration keys whose bytes are only in the old
tables.

Quiz keys name a scene, not a course. They are imported for the course whose
scene carries that id; a scene id that two legacy courses share (a duplicated
course) cannot say whose answers they are, and is skipped. The regular quiz
load path still migrates and removes any keys the importer left.

Nothing is ever written, cleared or deleted in a legacy database or legacy
localStorage key. (Opening an old `MAIC-Database` runs Dexie's own upgrade steps,
which the legacy schema keeps verbatim; that is the only change an open makes.)
Settings → Clear Local Cache still leaves the legacy databases alone, and keeps the
pre-runtime quiz keys until the ledger records the import as complete
(`legacyImportIsComplete` in `ledger.ts`): they exist nowhere else.

## Where a course goes

| Situation                                                            | Outcome                                                                                                                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The owner already has the course id on the server                    | Server copy is authoritative and is not overwritten. Only media bytes that exist solely in this browser are uploaded, device-only rows copied, and an unfiled course filed in its old folder. |
| The id is free                                                       | Created under its own id, with chat, runtime, playback, roster, quiz state, folder membership and media.                                                   |
| Another owner holds the id (ids are global)                          | Created under a fresh id, `<id>-i<16 hex of SHA-256(browser id, id)>`; scene stage ids, runtime session and record ids (only their course segment, including chat restore markers), playback and editor positions and membership follow it. |
| The owner deleted the course on the server (a write answers 404)     | Skipped; the deletion stands.                                                                                                                             |
| The legacy record fails validation or cannot be migrated or parsed    | Skipped with the reason (a document-store copy that is unusable falls back to the original tables first); the other courses continue.                     |
| Reading the old browser storage fails (an aborted transaction, a closed database) | Not a verdict on the record: the course stays pending and a later load reads it again. The quiz-scene and speech indexes leave such a course out as unindexed, which holds up only the quiz state or narration it could own; every other course imports. The failures are counted per course: after 5 consecutive failing runs spanning at least 24 hours (a run that reads the course without a failure resets the count; a first failure dated in the future counts from now), a document-store copy that still cannot be read falls back to the older table copy when there is one (noted in the ledger), and the course is skipped with the reason when there is not. |
| Another tab of this browser is placing the same course (no Web Locks) | The library is listed again right before a course is placed; a course that appeared meanwhile is left to that tab.                                        |
| Two tabs of different owners start together (no Web Locks)          | The server's insert decides: one owner holds the browser, the other is told no and writes nothing (and any write it tried would be refused by the fence). |

## Failures

| Failure                                                 | Handling                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Server persistence unreachable, learner key unavailable | Nothing is done; the next load tries again.                                                                                           |
| Network error (including the asset client's `0 HTTP_REQUEST_FAILED`, a dropped request or a timed-out existence probe), 5xx, 408/429, 409, a 2xx/3xx answer the client could not use | The item stays pending; a later load retries it. Backoff between runs: 30 s, doubling, capped at 6 h.                                  |
| 503 `OWNER_BUSY`                                         | The run pauses; the next run is allowed after `Retry-After` (2 s when not visible to the client).                                      |
| 401 (`INVALID_CREDENTIAL`, the access-code gate)         | The run pauses; items stay pending; a later load retries with backoff. This holds for a failure from any call of a course.            |
| 403 `OWNER_RETIRED`                                      | The run stops and items stay pending; the claim carried the binding, so the account continues them.                                  |
| 503 `PERSISTENCE_UNAVAILABLE` (the fence could not read the binding) | Transient, like any 5xx.                                                                                                              |
| 409 `LEGACY_IMPORT_NOT_BOUND`                            | The owner this request resolved to does not hold the browser (the cookie changed): the run stops, items stay pending, and a later load asks for the binding again. |
| 403 `FORBIDDEN_LEARNER` (the owner changed mid-run)      | The run stops; items stay pending for the next run.                                                                                   |
| 400 / 422 validation on an item, or a local validation failure of the asset client (`0 VALIDATION_FAILED`) | That item is recorded as failed with the reason; the rest continue.                                                                  |
| An upload refused for good (413, 400, 403)               | The element gets the app's ordinary failed-media record in the device cache (the one the generation pass writes) instead of a dangling reference: with Retry (regenerate) when the legacy row has a generation request, without it (`ASSET_REFUSED`) for the user's own media. The legacy bytes stay. |
| A whiteboard / PBL session is already active on the server | The legacy session of that kind is not created (the app keeps one active session per kind).                                         |
| Asset quota exceeded                                     | The document is imported anyway. A generation placeholder's bytes go to the device cache's `mediaFiles` and narration to its `audioFiles`, where the app's own retry uploads them without a provider call; references with no such path (legacy pool ids, import-minted ids) stay pending and the importer retries them. Nothing is lost: the legacy copy is untouched. |
| Folder name refused or folder limit reached              | The folder is recorded as failed; its courses stay unfiled.                                                                          |
| The folder is gone when a course is filed (404)          | The course is imported and stays unfiled; the ledger notes it.                                                                       |

## Ledger

One ledger per browser in localStorage, `maic:legacy-import:v3` (`ledger.ts`),
holding a random browser id and no owner information. The same id derives fresh
course ids. Every step is recorded when it lands, so a crash or reload resumes at
the first unfinished step; writes merge with the stored copy, so tabs without Web
Locks do not erase each other's progress. Clear Local Cache keeps the ledger (and
the old learner key), so it neither loses import state nor brings back a course
the user deleted on the server after it was imported. Runs are serialized across
tabs with the Web Lock `openmaic:legacy-browser-import`. If the ledger itself is
deleted by hand, the next run creates a new browser id, which the server binds
afresh: a course under its own id is still not duplicated, but a course imported
under a fresh id would be imported again and a half-copied runtime session is not
completed.

## Model settings

Earlier builds also kept the model settings in the browser, in the persisted
settings store (`maic:account:settings-storage`): providers with their API keys
and base URLs, the chosen model, token plan enrollment and the selection of
each capability (speech, transcription, images, video, web search, document
extraction). Model settings now live on the server (`/api/model-config`), and
`model-settings.ts` with `model-settings-import.ts` carry them over once:

1. The settings store's migration to version 5 (`migrateSettingsToV5` in
   `lib/store/settings.ts`) first brings older shapes to the version 4 one
   (`normalizeLegacyModelSettings`: the version 0 default model, the single
   TTS model setting, global TTS/ASR model ids, a TTS provider's `model`, the
   flat web search key), builds a proposal (`buildModelSettingsProposal`, pure)
   and keeps it under `maic:legacy-import:model-settings`, only when it holds
   something: a key, a custom endpoint, a model choice or speech input turned
   off. The store then drops those fields; it keeps only the user's
   preferences, with the narration voice tied to the provider it was picked
   for. **Keys are never dropped before they are staged**: when the proposal
   cannot be written (a full storage, an unreadable proposal already waiting),
   the old fields stay in the store (`legacyModelSettings`) and every load
   tries again, writing the store back without them once staging succeeds.
2. Once the store has hydrated, `components/model-settings-init.tsx` runs the
   import. The proposal holds this browser's keys, so like the course import
   it goes only to the owner the browser is bound to: it asks for the binding
   (`POST /api/identity/legacy-import-binding` with the ledger's browser id)
   and sends the import with `X-OpenMAIC-Legacy-Import`, so owner resolution
   refuses it (409 `LEGACY_IMPORT_NOT_BOUND`) for any other owner. The import
   route is one of `FENCED_ENDPOINTS`. `POST /api/model-config/import` merges
   the proposal item by item and never replaces an existing setting (a
   provider id already declared, a slot the workspace already sets or the
   deployment locks).

| Answer                                   | Handling                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| Binding held by another owner, or not asked for yet | Nothing is sent; the proposal stays for a later load.                            |
| 2xx                                      | The proposal, and every key in it, is removed from the browser. Skipped item ids are logged. |
| 400, or an unreadable proposal           | The proposal is dropped: sending it again cannot succeed.                                    |
| 401, 404, 409 (including `LEGACY_IMPORT_NOT_BOUND`), 5xx, network error | The proposal stays; a later load (or unlocking the access code) tries again. |

Its completion is its own: the proposal's key is removed once the server took
it (or refused it for good); the ledger's course state is not involved. Nothing
it logs quotes the proposal or an error message (only fixed text, item ids
and error names), since either could contain a key.

What the proposal holds:

| Browser state                                                   | Proposed as                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A built-in chat provider with a key or its own base URL         | a provider of preset `presetIdFor('chat', id)`; models the user added (not in the catalogue) are listed with the catalogue's |
| A custom chat provider (OpenAI-compatible)                      | a provider of preset `openai-compatible` with its base URL and model ids (Anthropic / Google custom providers keep their own preset) |
| An enrolled token plan                                          | one provider of preset `tokenPlanPresetId(plan)` with the plan's key (and, when the user added models, the plan's models with them); the services the plan filled with the same key are that provider |
| A speech, transcription, image, video, web search or document provider with a key | a provider of preset `presetIdFor(capability, id)`                              |
| The chosen model                                                | `slots.llm` = `provider:model`; a server-configured provider is named by its preset id, as the server names translated legacy providers |
| An enabled selection whose provider is proposed or server-configured | the capability's root slot (`tts`, `asr`, `image`, `video`, `webSearch`, `document`), with the selected model; a server-configured provider by its preset id, without credentials |
| Browser speech synthesis or recognition, when selected          | a `browser-native-tts` / `browser-native` provider and its root slot                              |
| A keyless search service (Brave) selected with research switched on | a provider of its preset (no key) and `slots.webSearch`; a self-hosted one (SearXNG) needs an endpoint only the deployment may set and is not proposed |
| The model picked for Claude web search | `slots.webSearch` = `claude:<model>` |
| Speech input turned off (`asrEnabled` stored as false)             | `slots.asr = null` (off): without an `asr` slot the browser's own speech recognition would take over. The other switches (`ttsEnabled`, `imageGenerationEnabled`, `videoGenerationEnabled`, `webSearchEnabled`) are not carried over: availability follows the slots, and a lasting `null` would override the deployment's defaults |

Not carried over:

- per-stage routes (`llmStageRoutes`), which do not map one to one onto
  slots: set per-stage models in Settings → Course Model Config (or `slots` in
  `openmaic.yml`);
- the per-browser switches for image, video, narration and research
  (`imageGenerationEnabled`, `videoGenerationEnabled`, `ttsEnabled`,
  `webSearchEnabled`): each capability now runs whenever its slot resolves,
  and turning one off is setting its slot off (only speech input's off switch
  carries over, see above);
- Baidu search sub-sources (`baiduSubSources`): the server's defaults apply;
- thinking settings (`thinkingConfigs`, per-route `thinking`): set `thinking`
  on a slot assignment instead;
- the VoxCPM backend (`providerOptions.backend`): set `options.backend` on the
  provider in `openmaic.yml`;
- custom speech and transcription providers, and AliDocMind's key pair (a
  workspace provider holds one key).

A base URL a workspace may not set (any service but chat) makes the server
skip that provider, with the reason in the server's answer. Provider ids are
derived to match `^[a-z0-9][a-z0-9-]{0,62}$` and made unique within the
proposal.

Clear Local Cache keeps a proposal that is still waiting: it exists nowhere
else.

## Removal

When the maintainers decide enough releases have passed:

1. Delete `lib/legacy-browser-import/` and its tests (`tests/legacy-browser-import/`,
   `e2e/tests/legacy-browser-import.spec.ts`), with `components/model-settings-init.tsx`
   (and its uses in `app/layout.tsx` and `components/access-code-guard.tsx`), the
   proposal saving and `legacyModelSettings` in `lib/store/settings.ts` (the
   fields are still dropped) and its cases in
   `tests/store/settings-model-settings-migration.test.ts`, and the model
   settings import route in the handler table of
   `tests/server/identity/legacy-import-binding-route.test.ts`;
   `lib/device-storage/clear-local-cache.ts` keeps `MODEL_SETTINGS_IMPORT_KEY`: drop it. `lib/device-storage/clear-local-cache.ts`
   imports `LEDGER_KEY` and `legacyImportIsComplete` from `ledger.ts`: define the
   ledger key there again (or drop it with step 5) and drop the quiz-key retention,
   with its cases in `tests/settings/general-settings.test.ts`.
2. Remove the dynamic import at the end of `lib/persistence/bootstrap.ts`.
3. Remove the server side:
   - `app/api/identity/legacy-import-binding/` and
     `tests/server/identity/legacy-import-binding-route.test.ts`;
   - `lib/persistence/legacy-import-bindings.ts` and its
     `ensureLegacyImportBindingSchema` call in `ensureStageMetaSchema`
     (`lib/persistence/stage-meta.ts`);
   - in `lib/persistence/owner-claims.ts`: the `legacy-import-bindings` row of
     the participant table in the header comment, its entry in
     `CORE_CLAIM_PARTICIPANTS`, and the participant itself (order 800);
   - in `tests/persistence/_owner-claim-scenarios.ts`: the `bindLegacyImport`
     seed, the `legacyImportBindings` counts and the
     `'legacy-import-bindings': 1` expectation of `moved`;
   - `legacyImportFence` and its call in `lib/server/identity/with-owner.ts`
     (and the `LEGACY_IMPORT_HEADER` import).
   - The docs: the legacy-import paragraphs of `README.md` and `README-zh.md`
     (and item 8 of the claim's "What moves" list, with the "100-800" order
     note), the six `packages/docs/content/docs/deployment*.mdx` pages, and a
     CHANGELOG entry for the removal.

   Keep the `legacy_import_bindings` table in this release: during a rolling
   deploy, pods still on the previous code run the claim participant's
   `UPDATE legacy_import_bindings`, and a dropped table would abort every
   claim on them. **One release later**, add
   `DROP TABLE IF EXISTS legacy_import_bindings;` to `ensureStageMetaSchema`
   (it takes the index with it). The `legacy-import-bindings` keys already
   recorded in `owner_merges.moved` can stay.
4. Optionally remove the `ASSET_REFUSED` code in `lib/media/media-failure.ts`
   once no device record carries it.
5. Optionally, drop what only the importer used: `LEGACY_IMPORT_LEDGER_KEY`
   in `lib/device-storage/clear-local-cache.ts` (and the legacy learner key it
   keeps; the regular quiz load path still migrates and removes leftover quiz
   keys), `lib/legacy-browser-storage/`, `importLegacyQuizSnapshot` in
   `lib/quiz/runtime.ts`, the exports of `canonicalizeLegacySnapshot` and
   `rowBelongsToAction`, the optional store/put/runtime parameters of the
   write-back funnels, `commitToPool` and `preparePBLScenesForDocumentPersistence`,
   and the `lib/legacy-browser-import/` entries in
   `tests/persistence/server-always-boundary.test.ts`.

`LIBRARY_CHANGED_EVENT` (`lib/utils/stage-storage.ts`) is a generic
"courses changed in the background" signal and can stay.
