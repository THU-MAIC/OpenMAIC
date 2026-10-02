# Generate Flow

## Preconditions

- Repo path is confirmed
- Startup mode has been chosen
- OpenMAIC is healthy at the selected `url`
- Provider keys are configured

> **Live Demo mode**: If using the OpenMAIC Live Demo (open.maic.chat), all
> preconditions (repo, startup, provider keys) are already satisfied.
> Include `Authorization: Bearer <access-code>` header on all requests below.
> See [live-demo.md](live-demo.md) for details.

## Request Contract

`POST {url}/api/generate-classroom` accepts exactly two fields:

- `requirement` (string, required) — what the classroom should teach. The course language follows the requirement (and any uploaded material); there is no `language` field.
- `materialIds` (string array, optional) — up to 5 ids returned by `POST {url}/api/materials`, used as source documents in the order given.

Nothing else is a request field. Web search, image generation, video generation and TTS narration are attempted automatically whenever their slot (`webSearch`, `image`, `video`, `tts`) resolves to a provider in the server's model configuration for the caller's workspace; they cannot be switched on or off per request, and requests never carry provider choices or API keys. Other fields are ignored, except `pdfContent`, which is rejected with `400 INVALID_REQUEST` (upload the document instead, see below).

A job is a server-side generation run, the same pipeline the web app's classic generation uses: the server generates the outline, confirms it itself, and then generates course-specific agents, the scenes in order, their narration, and the images and videos the outline asks for. The job id is the run id.

Do not rely on request-time model or provider override parameters. To change what a generation job can do, change the slots in `openmaic.yml` or in the model settings (a slot set to `null` is off).

## Keep One Owner Across Requests

Uploaded materials belong to the owner the server resolves for the upload request, and `materialIds` only resolve for that same owner.

- `GET {url}/api/generate-classroom/capabilities` needs no owner.
- If the server resolves a fixed owner — a shared team owner (`PERSISTENCE_SHARED_OWNER_ID` together with `ACCESS_CODE`), single-user mode (`OWNER_SINGLE_USER=true`), or a host that resolves the owner from a credential you send on every request — every request is the same owner automatically.
- Otherwise the server identifies callers by an anonymous owner cookie that it sets on the first owner-scoped response (including error responses). Reuse one cookie jar on every request of the flow — uploads, the submission, polls and deletions — for example `curl -c cookies.txt -b cookies.txt` on all calls. An upload made without the cookie belongs to a different owner, and its id is unavailable to the submission.

The job and the classroom it produces belong to the owner that submitted it:

- A job can only be polled by that owner. A poll without the submission's cookie (or credential) is a different owner, and gets the same `404` as an unknown job.
- The finished classroom is saved in that owner's course library. With a fixed owner it is editable wherever that owner signs in. With an anonymous owner cookie, the classroom opens read-only for anyone who has its URL but cannot be edited from a user's browser, because the browser is a different anonymous owner. If the user wants to edit classrooms generated through the API, the server needs a fixed owner or host authentication.

## Optional: Check Capabilities

To tell the user in advance what the job is configured to attempt, or which files it can generate from, query:

```text
GET {url}/api/generate-classroom/capabilities
```

```json
{
  "success": true,
  "capabilities": {
    "webSearch": true,
    "imageGeneration": false,
    "videoGeneration": false,
    "tts": true
  },
  "materials": {
    "formats": [{ "id": "pdf", "mime": "application/pdf", "extensions": [".pdf"] }],
    "maxCount": 5,
    "maxTotalBytes": 157286400,
    "maxDocumentBytes": 52428800,
    "maxMediaBytes": 52428800
  }
}
```

`capabilities` says which optional features the server has a provider configured for; nothing needs to be sent back. A search that fails continues without its context. An image or video that fails does not fail the job: the classroom completes with a placeholder there, and `result.warning` counts the failures. Narration is part of each scene: a narration provider failure the server's retries cannot overcome fails the job like any other step (see the polling loop for Retry), while a clip the server could not store (the owner's asset storage is full) is left silent and counted in `result.warning`.

`materials.formats` lists the upload types this server can extract with its current configuration (plain text, Markdown and PDF always; Office documents, images, audio and video only when a matching extraction service or local media pipeline is configured). Classroom generation uses the extracted text of each material, and the images the extraction finds in documents are stored with the classroom and can be placed on its slides. With the local media pipeline (ffmpeg) but no server ASR provider, video is listed and audio is not: a video without an audio track extracts, but contributes almost nothing (its text is just "No audio track"), and a video with an audio track fails when the job runs, because its speech cannot be transcribed. `maxCount` and `maxTotalBytes` bound one request's `materialIds`; the byte limits apply per file (`maxMediaBytes` for audio/video, `maxDocumentBytes` for everything else). `POST /api/materials` may accept more types than are listed here, but a submission with a material of an unlisted type is refused.

## Requirement-Only Generation

If the user has already clearly asked to generate the classroom and the preconditions are satisfied, submit the generation job immediately. Do not ask for a second confirmation just before calling `/api/generate-classroom`.

```text
POST {url}/api/generate-classroom
```

```json
{
  "requirement": "Create an introductory classroom on quantum mechanics for high school students"
}
```

Treat the `POST` response as job submission only. Expect fields such as:

```json
{
  "success": true,
  "jobId": "run-Q2xhc3Nyb29tSm9i",
  "runId": "run-Q2xhc3Nyb29tSm9i",
  "status": "queued",
  "step": "queued",
  "pollUrl": "http://localhost:3000/api/generate-classroom/run-Q2xhc3Nyb29tSm9i",
  "pollIntervalMs": 5000
}
```

The submission is refused before any job exists when:

- a model the job needs (the outline, the actions, or scene content for at least one scene type) is not configured or its slot is turned off (`400 MISSING_MODEL`), its provider has no API key (`400 MISSING_API_KEY`), its endpoint is refused (`400 INVALID_URL`), or it sets an option only the deployment may set (`400 MODEL_CONFIG_INVALID`): tell the user to fix the server's model configuration;
- the owner already has as many generations in progress as the server allows (`429 ACTIVE_RUN_LIMIT`; 2 by default, `OPENMAIC_MAX_ACTIVE_RUNS_PER_OWNER`): wait for a running job to finish, then submit again. A failed job whose run is paused (see below) does not count; retrying it does, so its Retry answers the same `429` while the owner is at the limit.

The request is checked in this order: the body (`400`/`413`), the models, the materials, then the limit.

## Generation From Local Files

Use this when the user wants the classroom built from their own files. Check `materials.formats` from the capabilities endpoint first when the file is not plain text, Markdown or PDF.

1. Resolve the absolute path of each file.
2. Confirm before reading the files.
3. Upload each file as the raw request body (not multipart):

```text
POST {url}/api/materials
Content-Type: <the file's MIME type, e.g. application/pdf>
X-Material-Filename: <the file name, percent-encoded if it is not ASCII>
<raw file bytes>
```

For example, with curl:

```bash
curl -sS -c cookies.txt -b cookies.txt \
  -H 'Content-Type: application/pdf' \
  -H 'X-Material-Filename: lecture-notes.pdf' \
  --data-binary @/path/to/lecture-notes.pdf \
  {url}/api/materials
```

A successful upload answers `201` with `{ "materialId": "...", "originalName": "...", "bytes": ..., "mime": "...", "extraction": { "status": "idle" } }`. Other answers: `413` (the file exceeds the limit; the body's `maxBytes` gives it), `415` (unsupported type), `429` (the owner's material library is full — it holds a bounded number of files and bytes per owner, 100 files and 2 GiB by default; delete materials you no longer need, see below). Extraction happens later, inside the generation job, so `status: "idle"` is expected.

4. Submit the job with the returned ids, in the order the documents should be read:

```json
{
  "requirement": "Create a classroom from these lecture notes",
  "materialIds": ["mat_01...", "mat_02..."]
}
```

The submission is checked before a job is created, and answers `400 INVALID_REQUEST` when:

- an id is unknown, not fully uploaded, deleted, or belongs to someone else (`One or more materials are unavailable`, the same answer for all of these);
- a material's type has no extractor available on this server;
- the materials together exceed `maxTotalBytes`.

If a document still cannot be extracted when the job runs (for example the extraction service fails, or the file contains no text), the job fails rather than generating without it; surface the error to the user.

5. After the job reaches `succeeded`, or `failed` with no Retry planned, delete the uploads you no longer need:

```text
DELETE {url}/api/materials/{materialId}
```

It answers `200` with `{ "materialId": "...", "deleted": true }`, or a plain `404` for an id the owner does not have — including one already deleted, so a `404` after an earlier successful delete just means it is gone. Do not delete before the job is finished: the job reads the files when it runs, and a job whose material was deleted fails. Deleting frees the owner's library quota; with a shared team owner every caller shares that one quota, so cleaning up matters.

### URLs Are Not Accepted

There is no way to pass a document URL. The server intentionally never fetches caller-supplied URLs; download the file locally (with the user's confirmation) and upload its bytes instead.

## Polling Loop

After the job is submitted:

1. Save `jobId`, `pollUrl`, and `pollIntervalMs`.
2. Do not submit another generation job while this one is still `queued` or `running`.
3. Poll:

```text
GET {pollUrl}
```

4. Prefer a conservative polling cadence of about 60 seconds between polls for classroom generation jobs, even if `pollIntervalMs` is shorter.
5. Treat `queued` and `running` as in-progress states.
6. Stop only when `status` becomes `succeeded` or `failed` (`done` is then `true`).

`step` is one of `queued`, `initializing` (extracting materials), `researching`, `generating_outlines`, `generating_scenes`, `generating_media` (the scenes are in; images and videos are finishing), `completed` or `failed`. `scenesGenerated` counts the scenes already in the classroom, and `totalScenes` appears once the outline exists.

### Failed Jobs And Retry

A `failed` job carries `error`, naming the step that failed when there is one (for example `scene:2:content: ...`). Two kinds exist:

- The run is paused at a failed step (`retryable: true`, `runState: "paused"`). Nothing is lost: the scenes generated so far stay, and the classroom is read-only until the run completes. With the user's confirmation, re-run only that step by calling `POST {url}/api/generation-runs/{runId}/retry` with `{ "commandId": "<a new unique id>" }` (same owner, same cookie jar); the job then reads `running` again, so keep polling the same `pollUrl`. Do not resubmit the requirement instead: that starts a second classroom.
- The classroom was deleted, or the run was discarded, before it finished (`error` says so). It cannot be retried.

`GET {url}/api/generation-runs/{runId}` shows the run itself (its state, the failed step, every image and video) for the same owner.

### Reliability Rules

- Never restart the job just because a poll request fails once.
- If a poll request returns a transient network error or `5xx`, wait about 60 seconds and retry the same `pollUrl`.
- Treat a `404` on the `pollUrl` as terminal: the server does not know that job for this owner. Check that the poll carries the submission's cookie (or credential); if it does, stop polling, report the `jobId` to the user, and do not resubmit without their confirmation.
- If the job is still running after many polls, tell the user it is still in progress and continue polling instead of resubmitting.
- Prefer fewer poll attempts over aggressive polling. Long-running jobs are more likely to survive agent-loop limits if the tool-call cadence stays low.
- Within a single agent turn, cap active polling to about 10 minutes. If the job is still not finished, tell the user it is still running and include the `jobId` and `pollUrl` so a later turn can continue checking without resubmitting.
- Report progress to the user only when `status`, `step`, or visible progress meaningfully changes. Do not spam every poll result.
- Do not try to recover from auth, provider, model, or base URL errors by changing request parameters. Tell the user to fix OpenMAIC server-side config and retry only after they confirm.
- On `failed`, surface the server error and include the `jobId`.
- On `succeeded`, read `result.classroomId` and `result.url` from the final poll response, and also read `result.warning` before telling the user the classroom is ready.
  - If `result.warning` is set, quote it in the same update: some images or videos could not be generated (for example the provider refused them, or the owner's asset storage is full) and show a placeholder, or some speech clips were left without narration because the owner's asset storage refused them. The classroom URL is still usable. The retryable images and videos can be retried with `POST {url}/api/generation-runs/{runId}/retry` and `{ "commandId": "<a new unique id>", "media": { "elementId": "<id>" } }`, where the element ids and their states are in `GET {url}/api/generation-runs/{runId}` under `media`.
  - A succeeded job is narrated when the server has a TTS provider configured (except the clips `result.warning` counts), and has no narration when it has none.

## If The Loop Ends First

If the job is still running when you stop active polling for this turn, tell the user that the classroom generation is still running in the background and invite them to come back a little later to continue checking the same job.

Use natural phrasing such as:

```text
The classroom generation is still running in the background.
Job ID: run-Q2xhc3Nyb29tSm9i

Check back with me in a little while and I can continue tracking this same job without starting over.
```

## What To Return

Return the generated classroom ID plus a directly clickable classroom URL.

When the succeeded job includes `result.warning`, say that some images, videos or narration are missing in the same reply, quoting `result.warning`, and still include the classroom ID and URL.

Output the URL as a raw absolute URL on its own line.

Do not wrap the URL in:

- bold markers such as `**...**`
- markdown links such as `[title](url)`
- code formatting such as `` `...` ``
- angle brackets such as `<...>`
- markdown tables

Use a compact format like:

```text
Classroom ID: Uyh82Y32ZK
Classroom URL:
http://localhost:3001/classroom/Uyh82Y32ZK
```

If the job fails, return the job ID plus the server error, and say whether it can be retried (a paused run) or not (a deleted classroom or a discarded run).

If generation fails, surface the server error directly instead of paraphrasing it away.

If the error suggests a provider or model configuration problem, explicitly tell the user to update `openmaic.yml` (with the key in `.env.local`) or the model settings in the web app instead of attempting a runtime override. See [provider-keys.md](provider-keys.md#recognizing-configuration-errors) for the common messages.

## Confirmation Requirements

- Ask before reading local files for upload.
- Do not ask for a second confirmation before the generation request if the user has already clearly asked you to generate the classroom.
