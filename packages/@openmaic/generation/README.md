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

PBL scenes use the same `AICallFn` seam for single-call planning. Hosts that
need an agentic fallback may inject `pblLoopFallback`; provider selection and
fallback execution remain caller-owned. The two planner templates ship under
`prompts-pbl/` and resolve relative to the installed package.
