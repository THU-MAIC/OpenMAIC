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

Nothing else is a request field. Web search, image generation, video generation and TTS narration are attempted automatically whenever the OpenMAIC server has a provider configured for them; they cannot be switched on or off per request, and requests never carry provider choices or API keys. Other fields are ignored, except `pdfContent`, which is rejected with `400 INVALID_REQUEST` (upload the document instead, see below).

Do not rely on request-time model or provider override parameters. To change what a generation job can do, change the OpenMAIC server-side provider config.

## Keep One Owner Across Requests

Uploaded materials belong to the owner the server resolves for the upload request, and `materialIds` only resolve for that same owner.

- `GET {url}/api/generate-classroom/capabilities` needs no owner.
- If the server resolves a fixed owner — a shared team owner (`PERSISTENCE_SHARED_OWNER_ID` together with `ACCESS_CODE`), single-user mode (`OWNER_SINGLE_USER=true`), or a host that resolves the owner from a credential you send on every request — every request is the same owner automatically.
- Otherwise the server identifies callers by an anonymous owner cookie that it sets on the first owner-scoped response (including error responses). Reuse one cookie jar on every request of the flow — uploads, the submission, polls and deletions — for example `curl -c cookies.txt -b cookies.txt` on all calls. An upload made without the cookie belongs to a different owner, and its id is unavailable to the submission.

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

`capabilities` says which optional features the server has a provider configured for; nothing needs to be sent back. It is best-effort, not a promise: if a configured provider fails at run time, the job continues and completes without that output. Today only narration reports this — through `result.ttsCoverage` and `result.warning` — so a missing image, video or search context is not flagged in the result.

`materials.formats` lists the upload types this server can extract text from with its current configuration (plain text, Markdown and PDF always; Office documents, images, audio and video only when a matching extraction service or local media pipeline is configured). Classroom generation uses only the extracted text of each material — no images, slides-as-pictures or video keyframes. With the local media pipeline (ffmpeg) but no server ASR provider, video is listed and audio is not: a video without an audio track extracts, but contributes almost nothing (its text is just "No audio track"), and a video with an audio track fails when the job runs, because its speech cannot be transcribed. `maxCount` and `maxTotalBytes` bound one request's `materialIds`; the byte limits apply per file (`maxMediaBytes` for audio/video, `maxDocumentBytes` for everything else). `POST /api/materials` may accept more types than are listed here, but a submission with a material of an unlisted type is refused.

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
  "jobId": "abc123",
  "status": "queued",
  "step": "queued",
  "pollUrl": "http://localhost:3000/api/generate-classroom/abc123",
  "pollIntervalMs": 5000
}
```

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

5. After the job reaches `succeeded` or `failed`, delete the uploads you no longer need:

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
6. Stop only when `status` becomes `succeeded` or `failed`.

### Reliability Rules

- Never restart the job just because a poll request fails once.
- If a poll request returns a transient network error or `5xx`, wait about 60 seconds and retry the same `pollUrl`.
- Treat a `404` on the `pollUrl` as terminal: the server does not know that job. Stop polling, report the `jobId` to the user, and do not resubmit without their confirmation.
- If the job is still running after many polls, tell the user it is still in progress and continue polling instead of resubmitting.
- Prefer fewer poll attempts over aggressive polling. Long-running jobs are more likely to survive agent-loop limits if the tool-call cadence stays low.
- Within a single agent turn, cap active polling to about 10 minutes. If the job is still not finished, tell the user it is still running and include the `jobId` and `pollUrl` so a later turn can continue checking without resubmitting.
- Report progress to the user only when `status`, `step`, or visible progress meaningfully changes. Do not spam every poll result.
- Do not try to recover from auth, provider, model, or base URL errors by changing request parameters. Tell the user to fix OpenMAIC server-side config and retry only after they confirm.
- On `failed`, surface the server error and include the `jobId`.
- On `succeeded`, read `result.classroomId` and `result.url` from the final poll response, and also read `result.warning` and `result.ttsCoverage` before telling the user the classroom is ready.
  - If `result.warning` is set, quote it in the same update and describe narration as incomplete.
  - If `result.ttsCoverage` is set and `written` is less than `total`, tell the user how many narration clips were written and how many speech actions were left silent. The classroom URL is still usable, and narration is incomplete.
  - A missing `ttsCoverage` means the server has no TTS provider configured, so no narration was generated. A TTS run includes `ttsCoverage`. `warning` is set when `written` is less than `total`, or when the TTS phase failed. A run with no narratable speech (`written: 0`, `total: 0`) has coverage and no `warning`.

## If The Loop Ends First

If the job is still running when you stop active polling for this turn, tell the user that the classroom generation is still running in the background and invite them to come back a little later to continue checking the same job.

Use natural phrasing such as:

```text
The classroom generation is still running in the background.
Job ID: abc123

Check back with me in a little while and I can continue tracking this same job without starting over.
```

## What To Return

Return the generated classroom ID plus a directly clickable classroom URL.

When the succeeded job includes `result.warning` or an incomplete `result.ttsCoverage` (`written` < `total`), say that narration is incomplete in the same reply, quoting `result.warning` when it is present, and still include the classroom ID and URL.

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

If the job fails, return the job ID plus the server error.

If generation fails, surface the server error directly instead of paraphrasing it away.

If the error suggests a provider or model configuration problem, explicitly tell the user to update `.env.local` or `server-providers.yml` instead of attempting a runtime override.

## Confirmation Requirements

- Ask before reading local files for upload.
- Do not ask for a second confirmation before the generation request if the user has already clearly asked you to generate the classroom.
