# One-way legacy browser import (temporary)

Earlier builds could keep courses in the browser (IndexedDB). Persistence is now
server-only, so on the first load after an upgrade this module moves whatever the
browser still holds to the server, for the owner the server resolves (the
anonymous cookie owner by default). It is automatic and silent: there is no
banner, dialog or opt-in, and a course simply appears in the library once it is on
the server. Problems are logged with `console.warn` under the prefix
`[legacy-browser-import]`.

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
| Another owner holds the id (ids are global)                          | Created under a fresh id derived from the owner and the legacy id (`<id>-i<digest>`); scene stage ids, runtime session and record ids, playback and editor positions and membership follow it. |
| The owner deleted the course on the server (a write answers 404)     | Skipped; the deletion stands.                                                                                                                             |
| The legacy record fails validation or cannot be read                 | Skipped with the reason; the other courses continue.                                                                                                      |

## Failures

| Failure                                                 | Handling                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Server persistence unreachable, learner key unavailable | Nothing is done; the next load tries again.                                                                                           |
| Network error, 5xx, 408/429, 409                         | The item stays pending; a later load retries it. Backoff between runs: 30 s, doubling, capped at 6 h.                                  |
| 503 `OWNER_BUSY`                                         | The run pauses; the next run is allowed after `Retry-After` (2 s when not visible to the client).                                      |
| 401 `INVALID_CREDENTIAL`, 403 `OWNER_RETIRED`            | The run stops; the item is recorded as failed and this owner's ledger is closed (a new owner starts its own).                          |
| 400 / 422 validation on an item                          | That item is recorded as failed with the reason; the rest continue.                                                                  |
| Asset quota exceeded                                     | The document is imported anyway. A generation placeholder's bytes go to the device cache's `mediaFiles` and narration to its `audioFiles`, where the app's own retry uploads them without a provider call; references with no such path (legacy pool ids, import-minted ids) stay pending and the importer retries them. Nothing is lost: the legacy copy is untouched. |
| Folder name refused or folder limit reached              | The folder is recorded as failed; its courses stay unfiled.                                                                          |

## Ledger

One ledger per server owner in localStorage, `maic:legacy-import:v1:<ownerId>`
(`ledger.ts`). Every step is recorded when it lands, so a crash or reload resumes
at the first unfinished step. A different owner in the same browser has no ledger
and re-evaluates everything. Clear Local Cache keeps the ledgers (and the old
learner key), so it neither loses import state nor brings back a course the user
deleted on the server after it was imported. Runs are serialized across tabs with
the Web Lock `openmaic:legacy-browser-import`; without Web Locks a run just
proceeds.

## Removal

When the maintainers decide enough releases have passed:

1. Delete `lib/legacy-browser-import/` and its tests (`tests/legacy-browser-import/`,
   `e2e/tests/legacy-browser-import.spec.ts`).
2. Remove the dynamic import at the end of `lib/persistence/bootstrap.ts`.
3. Optionally, drop what only the importer used: `LEGACY_IMPORT_LEDGER_PREFIX`
   in `lib/device-storage/clear-local-cache.ts` (and the legacy learner key it
   keeps), `lib/legacy-browser-storage/`, `importLegacyQuizSnapshot` in
   `lib/quiz/runtime.ts`, `canonicalizeLegacySnapshot`'s export, and the
   `lib/legacy-browser-import/` entries in
   `tests/persistence/server-always-boundary.test.ts`.

`LIBRARY_CHANGED_EVENT` (`lib/utils/stage-storage.ts`) is a generic
"courses changed in the background" signal and can stay.
