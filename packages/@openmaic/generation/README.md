# @openmaic/generation

Pure generation pipeline contracts and packaged prompt assets for MAIC consumers.

`AICallFn` is the package's model seam: callers provide a function that accepts
system and user prompts and returns model output. The package does not select a
provider, read environment configuration, or own persistence.

Prompt templates and their referenced snippets ship as readable Markdown assets
under `templates/` and `snippets/`. The loader resolves them relative to the
installed package, so it works from both source tests and compiled output.
