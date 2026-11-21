# ComfyUI Workflow Setup for OpenMAIC

## Where to store workflows

Place all workflow JSON files in your Next.js `public/` folder:

```
your-project/
  public/
    comfyui-workflow.json          → displays as "Workflow"
    comfyui-anime-style.json       → displays as "Anime Style"
    comfyui-line-art.json          → displays as "Line Art"
    comfyui-portrait.json          → displays as "Portrait"
```

### Naming convention
- Filenames **must** start with `comfyui-` or contain `workflow`
- Use hyphens to separate words — they become the display name in the UI
- The `comfyui-` prefix is stripped automatically
- Example: `comfyui-anime-style.json` → **"Anime Style"** in the dropdown

---

## Required nodes in your workflow

The adapter finds nodes **by their title** (the `_meta.title` field in the JSON).
To set a node's title in ComfyUI: right-click the node → **Title** → type the name.

### Required

| Node Title | Recommended Type | Purpose |
|------------|-----------------|---------|
| `Input Prompt` | `PrimitiveStringMultiline` | The image description from OpenMAIC is injected here |

### Recommended (automatically patched if present)

| Node Title | Recommended Type | Purpose |
|------------|-----------------|---------|
| `Width` | `PrimitiveInt` | Output width in pixels. An explicit width/height on the request wins; otherwise the aspect ratio expands up to `maxResolution` |
| `Height` | `PrimitiveInt` | Output height in pixels — paired with `Width` |
| `KSampler` | `KSampler` | Seed is randomised on every generation for varied outputs |
| `Enable prompt enhancement?` | `PrimitiveBoolean` | Set to `false` to skip LLM prompt enhancement (recommended for speed) |

### Fallback behaviour

If `Width` and `Height` nodes are **not found**, the adapter patches the latent
node directly. It looks for a node titled `Empty Latent Image` (SDXL
`EmptyLatentImage`), then `Empty Flux 2 Latent`, then those `class_type`s —
so existing workflows without dedicated dimension nodes still work.

When the request already carries `width` and `height`, those pixels are used.
`aspectRatio` is only the fallback, and it expands to `maxResolution` (a 16:9
request with no pixel size becomes 1920×1080). Sending both used to ignore the
pixels and always expand, which turned a 1344×768 SDXL request into 1920×1080.

Both `Width` and `Height` must be present for the explicit node approach to
activate — if only one is found the adapter falls back to the latent node method
and logs a warning.

### Prompt node fallback

If `Input Prompt` is not found, the adapter falls back to a node titled
`String (Multiline - Prompt)` — so existing workflows still work without
renaming anything.

---

## Connecting the nodes

### Input Prompt
Connect the output of the `Input Prompt` node to wherever your prompt text
enters the pipeline — typically the `text` input of a `CLIPTextEncode` node,
or a `StringReplace` node if you use prompt templating.

### Width and Height
Connect the output of each node to the corresponding `width` and `height`
inputs of your `Empty Flux 2 Latent` (or equivalent empty latent) node.

Example wiring:
```
[Input Prompt] ──→ CLIPTextEncode (text)
[Width]        ──→ EmptyLatentImage (width)
[Height]       ──→ EmptyLatentImage (height)
```

---

## How to export in API format

The workflow JSON must be in **ComfyUI API format** (not the default save format).

1. In ComfyUI, go to **Settings** → enable **Dev Mode Options**
2. A new **Save (API Format)** button appears in the toolbar
3. Click **Save (API Format)** — this produces the correct JSON
4. Place the file in your `public/` folder

> ⚠️ The regular **Save** button produces a different format that will not work.

---

## Settings in OpenMAIC

1. Go to **Settings → Image Generation**
2. Select **ComfyUI Image** as the provider
3. Set **Base URL** to your ComfyUI address (default `http://localhost:8188`)
4. Select your workflow from the **Workflows** list
5. Click **Test Connection** to verify ComfyUI is reachable

### Default workflow selection

If no workflow is explicitly selected — for example on the autonomous
classroom-media generation path, or before you've clicked a workflow in
Settings — the adapter falls back to the **first workflow file discovered in
`public/`** (alphabetically by display name). It does **not** rely on any
hard-coded filename, so you don't need a file called `comfyui-workflow.json`;
any single `comfyui-*.json` you ship will be used as the default. If `public/`
contains **no** workflow files at all, generation fails with a clear error
asking you to add one.

---

## Deployment topology (important for hosted/production)

The default Base URL `http://localhost:8188` assumes **OpenMAIC and ComfyUI run
on the same host** (the typical local / self-hosted setup).

When OpenMAIC runs with `NODE_ENV=production`, a **client-supplied** Base URL
(`x-base-url`) that points at `localhost`, `127.0.0.1`, or a private/internal IP
range is rejected with HTTP 403 by the SSRF guard (`validateUrlForSSRF`). This
is deliberate and matches the behaviour of the other local providers — it stops
a browser client from steering server-side requests at internal services.

Practical implications:

- **Same-host / self-hosted:** works out of the box. Server-resolved defaults
  are not subject to the client-URL SSRF check, so the `localhost:8188` default
  is fine when OpenMAIC and ComfyUI share a host.
- **ComfyUI on a different machine in production:** point OpenMAIC at ComfyUI
  over a **routable, non-private** address (or terminate it behind a reverse
  proxy on a public hostname). A `localhost`/private URL sent from the browser
  in production will be refused.
- **Local development** (`NODE_ENV` ≠ `production`): the SSRF check is skipped,
  so `localhost` works normally.

---

## Performance tips

- **Disable prompt enhancement** — if your workflow has an LLM-based prompt
  enhancer, set its enable node to `false`. Enhancement can add 3–5 minutes
  per image. The prompts generated by OpenMAIC are already descriptive enough.
- The adapter randomises the KSampler seed on every generation automatically.
- Output dimensions use an explicit width and height when the request has
  them, and otherwise the aspect ratio capped at the `maxResolution` set in
  `image-providers.ts` (default `1920×1920`).
- A cold checkpoint load can take several minutes. `COMFYUI_GENERATION_TIMEOUT_MS`
  bounds one ComfyUI generation (default 12 minutes, minimum 60 seconds).
  `MEDIA_DEADLINE_MS` is the generation run's budget for one image or video
  and defaults to the same 12 minutes.

---

## Shipped examples

`public/` includes two API-format workflows:

| File | Shown as | What it runs |
| --- | --- | --- |
| `comfyui-workflow.json` | Workflow | The default Flux / Ernie graph. This stays the default when both files are present (display names sort "Workflow" before "Workflow Sdxl"). |
| `comfyui-workflow-sdxl.json` | Workflow Sdxl | SDXL: `CheckpointLoaderSimple` with `sdxl_base_v1.0.safetensors`, `EmptyLatentImage`, `KSampler` at 20 steps / cfg 7 / `dpmpp_2m` / `karras`, `VAEDecode`, `SaveImage`. |

Place `sdxl_base_v1.0.safetensors` in the ComfyUI `models/checkpoints` folder
(or change `ckpt_name` to the checkpoint you actually have).

Selecting a workflow whose filename contains `sdxl` snaps the requested size
to an SDXL training bucket: 1024×1024 (1:1), 1344×768 (16:9), 768×1344 (9:16),
1152×896 (4:3), 896×1152 (3:4). Other workflows are not snapped.

### Server configuration

ComfyUI needs no API key. In `openmaic.yml`:

```yaml
providers:
  comfyui:
    preset: comfyui-image
    baseUrl: http://localhost:8188

slots:
  image: comfyui
```

The same base URL works from the legacy file (only when `openmaic.yml` is
absent) or from the environment, read at runtime:

```yaml
# server-providers.yml
image:
  comfyui-image:
    baseUrl: http://localhost:8188
```

```bash
IMAGE_COMFYUI_BASE_URL=http://localhost:8188
```

A provider that *returns* an `http://` image URL on a loopback, private,
link-local, or CGNAT address is fetched only when `ALLOW_LOCAL_NETWORKS=true`.
Public `http://` URLs stay refused, and cloud-metadata addresses stay refused
either way. The ComfyUI adapter itself returns image bytes, so the usual
base URL does not need that flag when the deployment configures it.
