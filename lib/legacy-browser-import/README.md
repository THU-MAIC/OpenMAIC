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
now. A claim participant re-keys the claimed owner's bindings to the account in
the claim transaction. Every other request the importer sends carries the id in
`X-OpenMAIC-Legacy-Import`, and owner resolution
(`lib/server/identity/with-owner.ts`) refuses it with `409
LEGACY_IMPORT_NOT_BOUND` unless the owner the request resolves to holds the
binding. So the data can reach no other owner, whatever the page believes the
owner is: a cookie switch in another tab, a stale page, a tab that lost the race.
The importer uses its own fenced clients (`server.ts`), never the app's
persistence seams, and asks for the runtime learner key during each run.

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
Settings → Clear Local Cache still leaves the legacy databases alone.

## Where a course goes

| Situation                                                            | Outcome                                                                                                                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The owner already has the course id on the server                    | Server copy is authoritative and is not overwritten. Only media bytes that exist solely in this browser are uploaded, device-only rows copied, and an unfiled course filed in its old folder. |
| The id is free                                                       | Created under its own id, with chat, runtime, playback, roster, quiz state, folder membership and media.                                                   |
| Another owner holds the id (ids are global)                          | Created under a fresh id, `<id>-i<16 hex of SHA-256(browser id, id)>`; scene stage ids, runtime session and record ids (only their course segment, including chat restore markers), playback and editor positions and membership follow it. |
| The owner deleted the course on the server (a write answers 404)     | Skipped; the deletion stands.                                                                                                                             |
| The legacy record fails validation or cannot be migrated or parsed    | Skipped with the reason (a document-store copy that is unusable falls back to the original tables first); the other courses continue.                     |
| Reading the old browser storage fails (an aborted transaction, a closed database) | Not a verdict on the record: the course stays pending and a later load reads it again. The quiz-scene and speech indexes leave such a course out as unindexed, which holds up only the quiz state or narration it could own; every other course imports. The failures are counted per course: after 5 failing runs spanning at least 24 hours, a document-store copy that still cannot be read falls back to the older table copy when there is one (noted in the ledger), and the course is skipped with the reason when there is not. |
| Another tab of this browser is placing the same course (no Web Locks) | The library is listed again right before a course is placed; a course that appeared meanwhile is left to that tab.                                        |
| Two tabs of different owners start together (no Web Locks)          | The server's insert decides: one owner holds the browser, the other is told no and writes nothing (and any write it tried would be refused by the fence). |

## Failures

| Failure                                                 | Handling                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Server persistence unreachable, learner key unavailable | Nothing is done; the next load tries again.                                                                                           |
| Network error, 5xx, 408/429, 409                         | The item stays pending; a later load retries it. Backoff between runs: 30 s, doubling, capped at 6 h.                                  |
| 503 `OWNER_BUSY`                                         | The run pauses; the next run is allowed after `Retry-After` (2 s when not visible to the client).                                      |
| 401 (`INVALID_CREDENTIAL`, the access-code gate)         | The run pauses; items stay pending; a later load retries with backoff. This holds for a failure from any call of a course.            |
| 403 `OWNER_RETIRED`                                      | The run stops and items stay pending; the claim carried the binding, so the account continues them.                                  |
| 409 `LEGACY_IMPORT_NOT_BOUND`                            | The owner this request resolved to does not hold the browser (the cookie changed): the run stops, items stay pending, and a later load asks for the binding again. |
| 403 `FORBIDDEN_LEARNER` (the owner changed mid-run)      | The run stops; items stay pending for the next run.                                                                                   |
| 400 / 422 validation on an item                          | That item is recorded as failed with the reason; the rest continue.                                                                  |
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

## Removal

When the maintainers decide enough releases have passed:

1. Delete `lib/legacy-browser-import/` and its tests (`tests/legacy-browser-import/`,
   `e2e/tests/legacy-browser-import.spec.ts`).
2. Remove the dynamic import at the end of `lib/persistence/bootstrap.ts`.
3. Remove the server side: `app/api/identity/legacy-import-binding/`,
   `lib/persistence/legacy-import-bindings.ts` (and its call in
   `ensureStageMetaSchema`), the `legacy-import-bindings` claim participant in
   `lib/persistence/owner-claims.ts`, the `legacyImportFence` in
   `lib/server/identity/with-owner.ts`, and
   `tests/server/identity/legacy-import-binding-route.test.ts`. A later
   migration may drop the `legacy_import_bindings` table.
4. Optionally remove the `ASSET_REFUSED` code in `lib/media/media-failure.ts`
   once no device record carries it.
5. Optionally, drop what only the importer used: `LEGACY_IMPORT_LEDGER_KEY`
   in `lib/device-storage/clear-local-cache.ts` (and the legacy learner key it
   keeps), `lib/legacy-browser-storage/`, `importLegacyQuizSnapshot` in
   `lib/quiz/runtime.ts`, the exports of `canonicalizeLegacySnapshot` and
   `rowBelongsToAction`, the optional store/put/runtime parameters of the
   write-back funnels, `commitToPool` and `preparePBLScenesForDocumentPersistence`,
   and the `lib/legacy-browser-import/` entries in
   `tests/persistence/server-always-boundary.test.ts`.

`LIBRARY_CHANGED_EVENT` (`lib/utils/stage-storage.ts`) is a generic
"courses changed in the background" signal and can stay.
