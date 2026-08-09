/**
 * ComfyUI Image Generation Adapter
 *
 * Submits a prompt to a local (or remote) ComfyUI instance via its
 * REST API, polls for completion, and returns the image as base64.
 *
 * Endpoint: http://localhost:8188  (configurable via baseUrl)
 * No API key required.
 *
 * Workflow loading strategy:
 *   1. If config.workflowJson is set (an already-parsed object), use it.
 *   2. Else if config.model names a workflow, load that file (validated against
 *      the public/ allowlist server-side).
 *   3. Else default to the first workflow file discovered in public/.
 *      → Ship at least one comfyui-*.json in your Next.js public/ directory.
 *
 * Nodes patched at runtime:
 *   "String (Multiline - Prompt)"  → inputs.value  = prompt
 *   "Empty Flux 2 Latent"          → inputs.width / height
 *   "KSampler"                     → inputs.seed   = random int
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';
import { aspectRatioToDimensions, IMAGE_PROVIDERS } from '../image-providers';

// ---------------------------------------------------------------------------
// Logger  (matches openmaic's [TIMESTAMP] [LEVEL] [Component] format)
// ---------------------------------------------------------------------------

const COMPONENT = 'ComfyUI Image';

const log = {
  info: (msg: string) => console.log(`[${new Date().toISOString()}] [INFO]  [${COMPONENT}] ${msg}`),
  warn: (msg: string) =>
    console.warn(`[${new Date().toISOString()}] [WARN]  [${COMPONENT}] ${msg}`),
  error: (msg: string) =>
    console.error(`[${new Date().toISOString()}] [ERROR] [${COMPONENT}] ${msg}`),
  debug: (msg: string) =>
    console.debug(`[${new Date().toISOString()}] [DEBUG] [${COMPONENT}] ${msg}`),
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'http://localhost:8188';
/** Default workflow filename (relative to Next.js public/) */
const DEFAULT_WORKFLOW_FILENAME = 'comfyui-workflow.json';
/** Default public path for the workflow JSON (relative to Next.js public/) */
const DEFAULT_WORKFLOW_PUBLIC_PATH = `/${DEFAULT_WORKFLOW_FILENAME}`;
/** Polling interval while waiting for the queue to finish (ms) */
const POLL_INTERVAL_MS = 1500;
/** Hard timeout for a single generation request (ms) */
const GENERATION_TIMEOUT_MS = 300_000; // 5 minutes
/**
 * Per-request timeout for individual ComfyUI HTTP calls (ms). The 5-minute
 * bound above is on the *polling loop* only — without this, an awaited call
 * whose socket connects but never responds (queuePrompt / pollHistory /
 * fetchImageAsBase64) could hang indefinitely.
 */
const FETCH_TIMEOUT_MS = 30_000;
/** Timeout for the lightweight connectivity probe (ms) */
const CONNECTIVITY_TIMEOUT_MS = 10_000;
/** Fallback max dimension if provider has no maxResolution defined */
const DEFAULT_MAX_WIDTH = 1024;

// ---------------------------------------------------------------------------
// Extended config type (avoids touching shared types.ts)
// ---------------------------------------------------------------------------

interface ComfyUIImageGenerationConfig extends ImageGenerationConfig {
  /**
   * Pre-parsed workflow object. When supplied the adapter skips the
   * fetch() call and uses this directly (deep-cloned on each request).
   */
  workflowJson?: Record<string, unknown>;
  /**
   * Public URL path to fetch the workflow JSON from.
   * Defaults to "/comfyui-workflow.json" (served from Next.js public/).
   */
  workflowPublicPath?: string;
}

// ---------------------------------------------------------------------------
// Workflow helpers
// ---------------------------------------------------------------------------

/**
 * Load and deep-clone the workflow.
 * - Browser: fetch() from the Next.js public/ origin
 * - Server (API route): read directly from disk with fs — relative URLs
 *   don't work in Node fetch since there's no browser origin to resolve against
 *
 * Security: config.model is client-controlled (it flows straight from the
 * x-image-model request header). It is never trusted as a raw path — it is
 * checked against isComfyuiWorkflowFilename() (bare basename, no traversal)
 * AND against the live directory listing from listComfyuiWorkflowFilenames()
 * (the same list /api/comfyui-workflows shows the user), before it's used to
 * build a filesystem path. See lib/media/comfyui-workflows.ts.
 */
async function loadWorkflow(
  config: ComfyUIImageGenerationConfig,
): Promise<Record<string, unknown>> {
  // Fast path: caller already supplied the parsed JSON.
  if (config.workflowJson) {
    log.debug('Using pre-supplied workflowJson (skipping fetch)');
    return JSON.parse(JSON.stringify(config.workflowJson)) as Record<string, unknown>;
  }

  // Server-side: read from disk (public/ directory relative to cwd)
  if (typeof window === 'undefined') {
    const fs = await import('fs');
    const path = await import('path');
    const { isComfyuiWorkflowFilename, listComfyuiWorkflowFilenames } =
      await import('../comfyui-workflows');

    let filename: string;
    if (config.workflowPublicPath) {
      // Server-set override (e.g. a caller passing workflowJson's sibling
      // path directly) — not client-controlled, so a plain basename() is
      // enough here rather than the full allowlist check below.
      filename = path.basename(config.workflowPublicPath);
    } else if (config.model) {
      // Client-controlled (x-image-model header) — must be a safe basename
      // AND a real file /api/comfyui-workflows would also list. Anything
      // else is rejected outright rather than silently falling back, so a
      // caller can't probe the filesystem via unexpected .json files.
      if (!isComfyuiWorkflowFilename(config.model)) {
        log.error(`Rejected unsafe workflow identifier: "${config.model}"`);
        throw new Error(`ComfyUI: "${config.model}" is not a valid workflow filename.`);
      }
      const known = await listComfyuiWorkflowFilenames();
      if (!known.includes(config.model)) {
        log.error(`Rejected unknown workflow identifier: "${config.model}"`);
        throw new Error(
          `ComfyUI: workflow "${config.model}" was not found. ` +
            'Choose one returned by /api/comfyui-workflows.',
        );
      }
      filename = config.model;
    } else {
      // No workflow specified. This happens on two real paths:
      //   1. Classroom / autonomous media generation, which has no model id
      //      to pass for ComfyUI (IMAGE_PROVIDERS['comfyui-image'].models is []).
      //   2. The provider is selected in Settings but no workflow has been
      //      clicked yet, so x-image-model is empty.
      // Default to the first workflow actually discovered in public/ rather
      // than a hard-coded name: the set of workflow files is user-supplied and
      // nothing guarantees any particular filename (e.g. comfyui-workflow.json)
      // exists. This is the same list /api/comfyui-workflows shows the user.
      const known = await listComfyuiWorkflowFilenames();
      if (known.length === 0) {
        log.error('No ComfyUI workflow files found in public/');
        throw new Error(
          'ComfyUI: no workflow JSON files found in the public/ folder. ' +
            'Add at least one comfyui-*.json workflow — see comfyui-setup-instructions.md.',
        );
      }
      filename = known[0];
      log.info(`No workflow specified — defaulting to first available: "${filename}"`);
    }

    const publicDir = path.join(process.cwd(), 'public');
    const filePath = path.join(publicDir, filename);

    // Defense in depth: even after the allowlist check above, verify the
    // resolved path is still inside public/ before reading it. path.join
    // does NOT stop ".." segments from escaping a base directory, so this
    // check — not the join above — is what actually prevents traversal.
    const resolvedPublicDir = path.resolve(publicDir) + path.sep;
    if (!path.resolve(filePath).startsWith(resolvedPublicDir)) {
      log.error(`Refusing to read outside public/ directory: "${filePath}"`);
      throw new Error('ComfyUI: resolved workflow path escapes the public/ directory.');
    }

    log.info(`Loading workflow from disk: "${filePath}"`);
    if (!fs.existsSync(filePath)) {
      log.error(`Workflow file not found at "${filePath}"`);
      throw new Error(
        `ComfyUI: workflow file not found at "${filePath}". ` +
          'Place comfyui-workflow.json in your Next.js public/ folder.',
      );
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    log.debug(`Workflow loaded from disk successfully`);
    return JSON.parse(raw) as Record<string, unknown>;
  }

  // Browser-side: fetch from origin.
  //
  // NOTE: generation always runs server-side (via the API route), so this
  // branch is currently unreachable for real generations. It enforces the
  // basename/traversal check (isComfyuiWorkflowFilename) but NOT the live
  // directory allowlist the server branch uses — listComfyuiWorkflowFilenames()
  // reads the filesystem and deliberately returns [] in the browser, so there
  // is nothing to check against here. The basename check is still the
  // traversal guard; the missing allowlist is an intentional consequence of
  // this path being client-side, not an oversight.
  let publicPath = DEFAULT_WORKFLOW_PUBLIC_PATH;
  if (config.workflowPublicPath) {
    publicPath = config.workflowPublicPath;
  } else if (config.model) {
    const { isComfyuiWorkflowFilename } = await import('../comfyui-workflows');
    if (!isComfyuiWorkflowFilename(config.model)) {
      log.error(`Rejected unsafe workflow identifier: "${config.model}"`);
      throw new Error(`ComfyUI: "${config.model}" is not a valid workflow filename.`);
    }
    publicPath = `/${config.model}`;
  }

  const url = `${window.location.origin}${publicPath}`;
  log.info(`Loading workflow from "${url}"`);
  const response = await fetch(url);
  if (!response.ok) {
    log.error(`Failed to load workflow from "${url}" (HTTP ${response.status})`);
    throw new Error(
      `ComfyUI: could not load workflow from "${url}" (HTTP ${response.status}). ` +
        'Place comfyui-workflow.json in your Next.js public/ folder.',
    );
  }

  log.debug(`Workflow loaded from URL successfully`);
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Resolve the output dimensions for a request, clamped to fit inside the
 * provider's maxResolution bounding box while preserving aspect ratio.
 *
 * aspectRatioToDimensions() always pins width to maxWidth and scales height,
 * so a portrait ratio overflows the declared max height (e.g. 9:16 at
 * maxWidth 1920 → 1920×3413, well past a 1920×1920 cap). Feeding that
 * straight into the latent-size node can OOM or fail generation. Scaling
 * both axes down by the tighter of the width/height ratios keeps the result
 * inside maxWidth × maxHeight without distorting the aspect ratio.
 *
 * Returns null when no dimensions can be resolved (caller uses workflow
 * defaults in that case).
 */
function resolveDimensions(
  options: ImageGenerationOptions,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } | null {
  const raw = options.aspectRatio
    ? aspectRatioToDimensions(options.aspectRatio, maxWidth)
    : options.width && options.height
      ? { width: options.width, height: options.height }
      : null;
  if (!raw) return null;

  const scale = Math.min(1, maxWidth / raw.width, maxHeight / raw.height);
  return {
    width: Math.round(raw.width * scale),
    height: Math.round(raw.height * scale),
  };
}

/**
 * Safely return a workflow node's `inputs` object, or undefined if the node
 * is malformed (missing/!object inputs). Guards the direct `node.inputs[...]`
 * assignments below against a TypeError on a hand-edited workflow file.
 */
function nodeInputs(node: unknown): Record<string, unknown> | undefined {
  const inputs = (node as Record<string, unknown> | undefined)?.['inputs'];
  return inputs && typeof inputs === 'object' ? (inputs as Record<string, unknown>) : undefined;
}

/**
 * Walk every node in the workflow and return the id of the first node
 * whose _meta.title matches title (case-insensitive).
 */
function findNodeIdByTitle(workflow: Record<string, unknown>, title: string): string | undefined {
  const lower = title.toLowerCase();
  for (const [id, node] of Object.entries(workflow)) {
    const meta = (node as Record<string, unknown>)['_meta'] as Record<string, unknown> | undefined;
    if (typeof meta?.title === 'string' && meta.title.toLowerCase() === lower) {
      return id;
    }
  }
  return undefined;
}

/**
 * Patch the workflow clone with the caller-supplied generation options.
 *
 * Prompt injection priority:
 *   1. Node titled "Input Prompt"  (preferred — explicit dedicated node)
 *   2. Node titled "String (Multiline - Prompt)"  (legacy fallback)
 *
 * Dimension injection priority:
 *   1. Nodes titled "Width" and "Height"  (preferred — explicit dedicated nodes)
 *   2. Node titled "Empty Flux 2 Latent"  (legacy fallback — patches inputs directly)
 */
function patchWorkflow(
  workflow: Record<string, unknown>,
  options: ImageGenerationOptions,
  maxWidth: number,
  maxHeight: number,
): void {
  // --- Resolve dimensions once (clamped to the provider's max resolution) ----
  const dims = resolveDimensions(options, maxWidth, maxHeight);

  // --- Prompt node -----------------------------------------------------------
  // Try "Input Prompt" first, fall back to "String (Multiline - Prompt)"
  const promptNodeId =
    findNodeIdByTitle(workflow, 'Input Prompt') ??
    findNodeIdByTitle(workflow, 'String (Multiline - Prompt)');

  if (!promptNodeId) {
    log.error('No prompt node found — add a node titled "Input Prompt" to your workflow');
    throw new Error(
      'ComfyUI workflow is missing a prompt input node. ' +
        'Add a node titled "Input Prompt" (or "String (Multiline - Prompt)") to your workflow.',
    );
  }
  const promptInputs = nodeInputs(workflow[promptNodeId]);
  if (!promptInputs) {
    log.error(`Prompt node (id: ${promptNodeId}) has no "inputs" object`);
    throw new Error(
      `ComfyUI workflow prompt node (id: ${promptNodeId}) is malformed — it has no "inputs" object. ` +
        'Re-export the workflow in API format (see comfyui-setup-instructions.md).',
    );
  }
  promptInputs['value'] = options.prompt;
  log.debug(
    `Patched prompt node (id: ${promptNodeId}) → "${options.prompt.slice(0, 80)}${options.prompt.length > 80 ? '…' : ''}"`,
  );

  // --- Width / Height nodes (preferred) -------------------------------------
  const widthNodeId = findNodeIdByTitle(workflow, 'Width');
  const heightNodeId = findNodeIdByTitle(workflow, 'Height');

  if (widthNodeId && heightNodeId) {
    // Explicit Width / Height primitive nodes found — patch them
    if (dims) {
      const widthInputs = nodeInputs(workflow[widthNodeId]);
      const heightInputs = nodeInputs(workflow[heightNodeId]);
      if (widthInputs && heightInputs) {
        widthInputs['value'] = dims.width;
        heightInputs['value'] = dims.height;
        log.debug(`Patched Width node (id: ${widthNodeId}) → ${dims.width}`);
        log.debug(`Patched Height node (id: ${heightNodeId}) → ${dims.height}`);
      } else {
        log.warn('Width/Height nodes are malformed (missing "inputs") — using workflow defaults');
      }
    } else {
      log.debug('Width/Height nodes found but no dimensions resolved — using workflow defaults');
    }
  } else {
    // Fall back to patching the latent size node directly
    if (widthNodeId || heightNodeId) {
      log.warn(
        'Only one of "Width"/"Height" nodes found — both are needed. Falling back to latent node.',
      );
    }
    const latentNodeId = findNodeIdByTitle(workflow, 'Empty Flux 2 Latent');
    if (latentNodeId) {
      const latentInputs = nodeInputs(workflow[latentNodeId]);
      if (dims && latentInputs) {
        latentInputs['width'] = dims.width;
        latentInputs['height'] = dims.height;
        log.debug(
          `Patched latent size node (id: ${latentNodeId}) → ${dims.width}×${dims.height} (aspectRatio: ${options.aspectRatio ?? 'none'})`,
        );
      } else if (dims && !latentInputs) {
        log.warn(
          `Latent size node (id: ${latentNodeId}) is malformed (missing "inputs") — using workflow defaults`,
        );
      } else {
        log.debug(
          `Latent size node (id: ${latentNodeId}) — no dimensions resolved, using workflow defaults`,
        );
      }
    } else {
      log.warn(
        'No dimension nodes found ("Width"/"Height" or "Empty Flux 2 Latent") — using workflow defaults',
      );
    }
  }

  // --- KSampler seed ---------------------------------------------------------
  const samplerNodeId = findNodeIdByTitle(workflow, 'KSampler');
  if (samplerNodeId) {
    const samplerInputs = nodeInputs(workflow[samplerNodeId]);
    if (samplerInputs) {
      const seed = Math.floor(Math.random() * 1e15);
      samplerInputs['seed'] = seed;
      log.debug(`Patched KSampler seed (id: ${samplerNodeId}) → ${seed}`);
    } else {
      log.warn(
        `KSampler node (id: ${samplerNodeId}) is malformed (missing "inputs") — seed not randomised`,
      );
    }
  } else {
    log.warn('KSampler node not found — seed not randomised');
  }
}

// ---------------------------------------------------------------------------
// ComfyUI REST helpers
// ---------------------------------------------------------------------------

interface QueuePromptResponse {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
}

interface HistoryEntry {
  outputs: Record<
    string,
    {
      images?: Array<{ filename: string; subfolder: string; type: string }>;
    }
  >;
  status: {
    status_str: string;
    completed: boolean;
    // ComfyUI records execution events here as [eventName, data] tuples.
    // On failure an "execution_error" event carries the real reason.
    messages?: Array<[string, Record<string, unknown>]>;
  };
}

/**
 * Pull a human-readable reason out of a failed history entry's message log.
 * Returns undefined if no execution_error detail is present.
 */
function extractExecutionError(entry: HistoryEntry): string | undefined {
  const messages = entry.status?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (const [event, data] of messages) {
    if (event === 'execution_error' && data) {
      const nodeType = typeof data['node_type'] === 'string' ? data['node_type'] : undefined;
      const exception =
        typeof data['exception_message'] === 'string' ? data['exception_message'] : undefined;
      const parts = [nodeType, exception].filter(Boolean);
      if (parts.length > 0) return parts.join(': ');
      return 'execution_error';
    }
  }
  return undefined;
}

async function queuePrompt(
  baseUrl: string,
  workflow: Record<string, unknown>,
  clientId: string,
): Promise<string> {
  log.info(`Submitting workflow to queue [client_id: ${clientId}]`);
  const response = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text();
    log.error(`/prompt request failed (HTTP ${response.status}): ${text}`);
    throw new Error(`ComfyUI /prompt failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as QueuePromptResponse;

  if (data.node_errors && Object.keys(data.node_errors).length > 0) {
    log.error(`Node errors returned: ${JSON.stringify(data.node_errors)}`);
    throw new Error(`ComfyUI reported node errors: ${JSON.stringify(data.node_errors)}`);
  }

  log.info(`Queued successfully — prompt_id: ${data.prompt_id} (queue position: ${data.number})`);
  return data.prompt_id;
}

async function pollHistory(baseUrl: string, promptId: string): Promise<HistoryEntry | null> {
  // A single poll timing out or blipping must not abort the whole generation —
  // return null so the caller's loop simply tries again on the next interval.
  try {
    const response = await fetch(`${baseUrl}/history/${promptId}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, HistoryEntry>;
    return data[promptId] ?? null;
  } catch (err) {
    log.debug(`Poll request failed (will retry): ${err}`);
    return null;
  }
}

async function fetchImageAsBase64(
  baseUrl: string,
  filename: string,
  subfolder: string,
  type: string,
): Promise<string> {
  const params = new URLSearchParams({ filename, subfolder, type });
  const response = await fetch(`${baseUrl}/view?${params.toString()}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`ComfyUI /view failed (${response.status}) for image "${filename}"`);
  }

  const buffer = await response.arrayBuffer();

  // This runs server-side, so encode with Buffer (single native pass) rather
  // than a multi-MB per-byte String.fromCharCode loop. The btoa fallback is
  // retained only to keep this module import-safe in the browser bundle; it
  // is never exercised in practice because generation runs server-side.
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buffer).toString('base64');
  }
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Lightweight connectivity test — calls GET /system_stats.
 * Returns 200 when ComfyUI is running and reachable.
 */
export async function testComfyuiImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  log.info(`Testing connectivity to ${baseUrl}`);
  try {
    const response = await fetch(`${baseUrl}/system_stats`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(CONNECTIVITY_TIMEOUT_MS),
    });
    if (response.ok) {
      log.info(`Connectivity test passed — ComfyUI is reachable at ${baseUrl}`);
      return { success: true, message: 'Connected to ComfyUI' };
    }
    log.warn(`Connectivity test failed — HTTP ${response.status} from ${baseUrl}`);
    return {
      success: false,
      message: `ComfyUI returned HTTP ${response.status}. Is it running at ${baseUrl}?`,
    };
  } catch (err) {
    log.error(`Connectivity test error: ${err}`);
    return {
      success: false,
      message: `ComfyUI connectivity error: ${err}. Is it running at ${baseUrl}?`,
    };
  }
}

export async function generateWithComfyuiImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const comfyConfig = config as ComfyUIImageGenerationConfig;

  log.info(`Starting image generation [baseUrl: ${baseUrl}] [model: ${config.model ?? 'default'}]`);
  log.info(`Prompt: "${options.prompt.slice(0, 120)}${options.prompt.length > 120 ? '…' : ''}"`);
  log.debug(
    `Options: ${JSON.stringify({ width: options.width, height: options.height, aspectRatio: options.aspectRatio })}`,
  );

  const startTime = Date.now();

  // Resolve the provider's max resolution (set in image-providers.ts). Both
  // axes are needed so portrait ratios can be clamped to the bounding box.
  const maxResolution = IMAGE_PROVIDERS[config.providerId]?.maxResolution;
  const maxWidth = maxResolution?.width ?? DEFAULT_MAX_WIDTH;
  const maxHeight = maxResolution?.height ?? DEFAULT_MAX_WIDTH;

  // 1. Load and patch the workflow -------------------------------------------
  const workflow = await loadWorkflow(comfyConfig);
  patchWorkflow(workflow, options, maxWidth, maxHeight);

  // 2. Client ID for this request --------------------------------------------
  const clientId = `openmaic-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // 3. Submit to the queue ---------------------------------------------------
  const promptId = await queuePrompt(baseUrl, workflow, clientId);

  // 4. Poll history until complete -------------------------------------------
  const deadline = Date.now() + GENERATION_TIMEOUT_MS;
  let entry: HistoryEntry | null = null;
  let pollCount = 0;

  log.info(`Polling for completion [prompt_id: ${promptId}]`);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    pollCount++;
    entry = await pollHistory(baseUrl, promptId);

    // Fail fast on a runtime execution error. A workflow that errors mid-run
    // records completed:false with status_str:"error", so without this check
    // the loop would poll the full timeout and then throw a misleading
    // "timed out" instead of the real cause.
    if (entry?.status?.status_str === 'error') {
      const detail = extractExecutionError(entry);
      log.error(`Workflow execution error [prompt_id: ${promptId}]${detail ? `: ${detail}` : ''}`);
      throw new Error(
        `ComfyUI workflow execution failed (prompt_id: ${promptId})` +
          (detail ? `: ${detail}` : '. Check the ComfyUI server logs for details.'),
      );
    }

    if (entry?.status?.completed) {
      log.info(
        `Generation complete after ${pollCount} poll(s) (${((Date.now() - startTime) / 1000).toFixed(1)}s)`,
      );
      break;
    }

    if (pollCount % 10 === 0) {
      log.debug(
        `Still waiting… ${pollCount} polls, ${((Date.now() - startTime) / 1000).toFixed(0)}s elapsed`,
      );
    }
  }

  if (!entry?.status?.completed) {
    log.error(
      `Generation timed out after ${GENERATION_TIMEOUT_MS / 1000}s [prompt_id: ${promptId}]`,
    );
    throw new Error(
      `ComfyUI generation timed out after ${GENERATION_TIMEOUT_MS / 1000}s ` +
        `(prompt_id: ${promptId})`,
    );
  }

  // 5. Extract the first output image ----------------------------------------
  let imageInfo: { filename: string; subfolder: string; type: string } | undefined;

  for (const nodeOutput of Object.values(entry.outputs)) {
    if (nodeOutput.images && nodeOutput.images.length > 0) {
      imageInfo = nodeOutput.images[0];
      break;
    }
  }

  if (!imageInfo) {
    log.error('Generation finished but no images found in output nodes');
    throw new Error(
      'ComfyUI finished but returned no images. ' +
        'Check that your workflow includes a SaveImage node.',
    );
  }

  log.info(`Fetching image "${imageInfo.filename}" from ComfyUI /view`);

  // 6. Download and encode the image -----------------------------------------
  const base64 = await fetchImageAsBase64(
    baseUrl,
    imageInfo.filename,
    imageInfo.subfolder,
    imageInfo.type,
  );

  const totalMs = Date.now() - startTime;
  // Report the same clamped dimensions that were patched into the workflow.
  const dims = resolveDimensions(options, maxWidth, maxHeight);

  log.info(
    `Image generation complete — ${imageInfo.filename} (${dims?.width ?? options.width ?? 1024}×${dims?.height ?? options.height ?? 1024}) in ${(totalMs / 1000).toFixed(1)}s`,
  );

  return {
    base64,
    width: dims?.width ?? options.width ?? 1024,
    height: dims?.height ?? options.height ?? 1024,
  };
}
