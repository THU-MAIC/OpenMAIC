# DocumentStore HTTP contract

This contract exposes the complete `DocumentStore` interface over JSON HTTP. All paths are relative to a deployment-defined base URL. Path segments are percent-encoded UTF-8 strings and MUST NOT be exactly `.` or `..`, because URL parsers normalize dot segments before routing. Request and response bodies use `application/json`; successful writes return `204 No Content`.

## Endpoints

| Method | Path | Purpose | Success |
| --- | --- | --- | --- |
| `PUT` | `/documents/{stageId}` | Save the full `MaicDocument`; body `stage.id` must match the path. The store migrates stale input, stamps `dslVersion`, replaces stage/outline data, upserts incoming scenes, and removes omitted scenes atomically. | `204` |
| `GET` | `/documents/{stageId}` | Load and migrate one complete document. | `200` with `MaicDocument`, or `404 DOCUMENT_NOT_FOUND` |
| `GET` | `/documents` | List version-independent summaries. | `200` with `DocumentSummary[]` |
| `DELETE` | `/documents/{stageId}` | Cascade-delete a document, its scenes, and its outline. Idempotent and intentionally not version-guarded. | `204` |
| `PUT` | `/documents/{stageId}/stage` | Validate and replace the stage row of an existing current-version document; body `id` must match the path. | `204` |
| `PUT` | `/documents/{stageId}/scenes/{sceneId}` | Validate and upsert a scene in an existing current-version document; body `id` and `stageId` must match the path. | `204` |
| `GET` | `/documents/{stageId}/scenes/{sceneId}` | Read one scene through the parent document's migrate-on-read semantics. | `200` with the scene, or `404` |
| `DELETE` | `/documents/{stageId}/scenes/{sceneId}` | Delete one scene. Idempotent for an absent scene or document, but version-guarded when the parent exists. | `204` |

`GET /documents` returns only `id`, `name`, optional `description`, optional `interactiveMode`, optional `taskEngineMode`, `createdAt`, `updatedAt`, and `sceneCount`. Those fields are independent of the DSL version. Implementations MUST NOT migrate document content to produce this list and MUST tolerate an unknown or malformed stored version stamp.

## Validation, versions, and JSON

Servers run their configured `validateStage` and `validateScene` gates before writes. A full save validates the migrated aggregate and rejects duplicate scene ids, mismatched scene partitions, and non-finite order values before changing storage. `putStage` and `putScene` repeat the same boundary validation and require an existing document whose stored `dslVersion` is exactly the server's current `DSL_VERSION`. A stale document must first be loaded and saved as a full aggregate; a future document must never be downgraded. `deleteScene` has the same current-version guard, while whole-document deletion deliberately does not.

HTTP implementations carry data through JSON and therefore accept only plain values that serialize without changing meaning. They fail before sending or storing values such as `Map`, `Set`, `Date`, non-finite numbers, negative zero, `undefined`, `bigint`, sparse arrays, class instances, symbol/non-enumerable properties, U+0000 strings, and circular references. The opaque outline is not DSL-validated or migrated, but it is still subject to this JSON transport rule. A store exposed by the server MUST contain JSON-safe document, scene, outline, and summary values; the handler validates read payloads before serialization and returns `500 NOT_JSON_SAFE` with the offending path if this invariant is violated.

The handler streams request bodies into a bounded buffer. `maxBodyBytes` configures the bound on `createDocumentHttpHandler` and composed/reference server factories; it defaults to 32 MiB. A body that crosses the bound is rejected immediately with `413 PAYLOAD_TOO_LARGE`.

Reads are migrated on both sides of the wire. The backing store performs its normal migrate-on-read, and the HTTP client migrates the returned document again so an older server cannot leak a stale envelope into a newer application. The opaque outline is removed before DSL migration and reattached unchanged.

## Authentication and authorization

Documents are author assets, not learner-partitioned data. The contract does not prescribe a tenant or ownership model; deployments enforce their policy through the injected `authenticate` and `authorizeDocuments` hooks. The reference handler requires an authenticated principal for every document route. Its default authorization permits any authenticated principal; production deployments can supply `authorizeDocuments` to apply author, tenant, role, or document-level policy.

## Errors

Every non-2xx response has a machine-readable JSON body:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "@openmaic/storage: invalid stage ...",
    "details": []
  }
}
```

`details` is optional. Messages retain backing-store semantics so the client exposes the same useful wording as `BrowserDocumentStore`.

| Condition | HTTP status | Error code | Client behavior |
| --- | --- | --- | --- |
| Malformed JSON, invalid stage/scene/document, body/path mismatch, non-JSON value, duplicate scene id, or stale incremental write | `400` | `VALIDATION_FAILED` | Throw `HttpDocumentStoreError` with the server message |
| Request body exceeds `maxBodyBytes` | `413` | `PAYLOAD_TOO_LARGE` | Throw `HttpDocumentStoreError` |
| Document does not exist | `404` | `DOCUMENT_NOT_FOUND` | `loadDocument` returns `null`; required-parent writes throw with `missing document` semantics |
| Scene does not exist | `404` | `SCENE_NOT_FOUND` | `getScene` returns `null` |
| Route does not exist | `404` | `ROUTE_NOT_FOUND` | Throw `HttpDocumentStoreError` |
| Input or stored document was written at a future DSL version | `409` | `FUTURE_VERSION` | Throw `HttpDocumentStoreError` with `newer than this client's`/version-guard semantics |
| A server-exposed read value is not JSON-safe | `500` | `NOT_JSON_SAFE` | Throw `HttpDocumentStoreError` with the offending value path |
| Unexpected server failure | `500` | `INTERNAL_ERROR` | Throw `HttpDocumentStoreError`; the reference handler does not expose internal details |

Only the machine-readable not-found codes are translated to `null`. Status alone is not sufficient. Authentication failures use `401 UNAUTHENTICATED`, and authorization failures use `403 FORBIDDEN_DOCUMENTS`.

## Retry and atomicity guarantees

Full saves are atomic: validation or any failed child write leaves the previous aggregate untouched. `DELETE /documents/{stageId}` and scene deletion are safely retryable. Stage and scene puts are idempotent for the same body, subject to the current-version guard. The contract does not add conditional requests or idempotency keys; deployments that retry an ambiguous full save must rely on the caller-owned `stageId` and replacement semantics.
