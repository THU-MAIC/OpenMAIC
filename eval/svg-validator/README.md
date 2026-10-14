# SVG generation and rendering regression

This evaluation uses real provider responses with the production generation package, then verifies the generated DSL in Chromium and the local classroom. Controlled malformed shapes are tested separately. Results do not rank model intelligence or establish mathematical correctness.

Build the workspace packages first. Credentials are read from the usual environment or `.env.local`; they are never embedded in scripts. `results/` is ignored by Git.

```sh
EVAL_ENV_DIR=/path/to/environment \
SVG_EVAL_MODELS=OPENAI:gpt-5.6-luna,DEEPSEEK:deepseek-flash \
SVG_EVAL_MAX_TOKENS=32768 \
SVG_EVAL_OUTPUT=eval/svg-validator/results/my-run \
node eval/svg-validator/runner.mjs
```

Each model produces an outline and three slide scenarios, each repeated twice: triangle geometry, SVG arcs/curves, and dark nodes with white labels. The first triangle sample also generates actions. Requests use the configured provider's chat-completions endpoint, without switching to a stronger model. This runner covers the production prompts and postprocessing, not the server's provider adapter; `live-api.mjs` covers actual server orchestration.

Options:

- `SVG_EVAL_REPEATS`: defaults to 2.
- `SVG_EVAL_MAX_TOKENS`: defaults to 16,384; includes reasoning where providers count it.
- `SVG_EVAL_DISABLE_THINKING=1`: sends `thinking: { type: 'disabled' }`; support is provider dependent. Recorded as a requested setting, not proof it took effect.
- `SVG_EVAL_RESUME=1`: reuses successful saved samples and existing outlines in the same output directory. Failed samples are retried; use a new directory to retain failure evidence.

Outputs include raw content, normalized scenes, warnings, token usage, returned model, finish reason, and side-by-side renderer pages. `gallery.mjs` rebuilds the pages offline and combines completed outputs. Historical comparison preserves raw shape geometry, while formulas receive their generated HTML as they would in a saved course.

```sh
node eval/svg-validator/faults.mjs eval/svg-validator/results/my-run/OPENAI-gpt-5-6-luna/triangles-1.json
node eval/svg-validator/gallery.mjs
python3 -m http.server 1852 --bind 127.0.0.1 --directory eval/svg-validator/results
```

With the gallery server running and an application connected to an isolated test database:

```sh
SVG_EVAL_APP_URL=http://localhost:3003 node eval/svg-validator/browser.mjs
SVG_EVAL_APP_URL=http://localhost:3003 SVG_EVAL_API_MODEL=openai:gpt-5.6-luna node eval/svg-validator/live-api.mjs
```

`browser.mjs` checks all sample pages, compares generated and historical fallback pixels at the same viewport position, seeds unique test courses through the persistence API, navigates the classroom, reloads, and enters/leaves Pro mode. It verifies historical shapes remain shapes in storage. Screenshots and machine-readable browser outcomes are saved in `results/browser/`.

`live-api.mjs` uses a fresh browser owner, assigns its `llm` slot to the selected lightweight model, starts a real server generation run, waits for completion, reads its persisted course, and opens the classroom. This writes test courses and model preferences to the configured local application: use an isolated test database. Narration audio is outside this evaluation.

The 13 controlled faults cover trailing numbers after `Z`, incomplete paths, markup, overflow, zero viewBox, invalid dimensions/types, absent/empty labels, dark backgrounds and white labels, and rotated bottom-aligned text. These fixtures are deliberately corrupted and are not attributed to a model.
