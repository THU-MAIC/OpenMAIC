# @openmaic/generation

Pure generation pipeline contracts and packaged prompt assets for MAIC consumers.

`AICallFn` is the package's model seam: callers provide a function that accepts
system and user prompts and returns model output. The package does not select a
provider, read environment configuration, or own persistence.

Prompt templates and their referenced snippets ship as readable Markdown assets
under `templates/` and `snippets/`. The loader resolves them relative to the
installed package, so it works from both source tests and compiled output.

Scene generation is available as independent content, action, and assembly
primitives. A caller can generate one outline, pass it to `generateSceneContent`
and `generateSceneActions`, then assemble the DSL value with
`buildCompleteScene`. Retrying consumers can supply `sceneId` to preserve scene
identity across replays.

`generateSceneContent` returns `null` when a non-PBL content prompt cannot be
prepared or the model output cannot be parsed. Callers that need a stable cause
may supply `onFailure`; it receives `{ code: 'prompt-unavailable' }` or
`{ code: 'invalid-model-output' }` immediately before that `null` result.
`generateWidgetContent` accepts the same callback in its options.

`renderScenePrompt('slide-content', { imageElementEnabled, generatedImageEnabled,
generatedVideoEnabled })` returns `{ system }`, the system prompt that slide
content generation sends to the model for those media rules, without running
generation. The slide generator builds its own system prompt through the same
code, so a consumer that serves the slide contract with another model sends the
same prompt. `imageElementEnabled` covers assigned and generated images.

PBL scenes use the same `AICallFn` seam for single-call planning. Hosts that
need an agentic fallback may inject `pblLoopFallback`; provider selection and
fallback execution remain caller-owned. The two planner templates ship under
`prompts-pbl/` and resolve relative to the installed package.

## Interactive libraries

`INTERACTIVE_LIBRARIES` is the source of truth for pinned versions, compatible CDN URL forms, prompt guidance, and build-time copied files. `rewriteInteractiveLibraries(html, baseUrl?)` preserves authored bytes outside recognized resource references and returns unmatched-host counts. `postProcessInteractiveHtml` applies this mapping and upgrades legacy platform KaTeX markup. It injects the hosted KaTeX (stylesheet, library and auto-render, loaded synchronously ahead of the page's own scripts) only when the page contains math: in page text, as TeX in inline script strings (JS-escaped or `String.raw`), or as calls to the KaTeX API. Pages without math get no KaTeX. Re-processing replaces the platform's KaTeX markup with markup for the current asset base, and re-points library URLs under the default `/vendor/interactive` path; library URLs that an earlier pass pointed at a former absolute `INTERACTIVE_ASSET_BASE_URL` are not recognized and stay as written. Browser consumers can import these APIs from `@openmaic/generation/browser`.

Hosts must copy the manifest's files from the exact installed package versions and serve them below `/vendor/interactive` (or the public `INTERACTIVE_ASSET_BASE_URL` setting), including fonts and Three.js addons, with CORS enabled for sandboxed frames. The OpenMAIC app runs `scripts/sync-interactive-assets.mjs` at install/build/dev time. Compatible version rules accept exact/partial/wildcard/caret/tilde versions with the same major for stable libraries and same minor for pre-1.0 libraries, without downgrading concrete requested minimums; unversioned and `latest` URLs select the hosted pin. Other ranges/tags, query parameters, unsupported paths, legacy Tailwind v3 Play CDN, and Google Fonts stay authored. Literal ESM imports and import-map values are handled; computed imports, ordinary JS strings, external CSS contents, and import-map scope keys are untouched.
