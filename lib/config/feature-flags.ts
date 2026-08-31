/**
 * Feature flags. Public flags come from `NEXT_PUBLIC_*` env vars, which
 * Next.js inlines at build time so they are safe to read from client
 * components. Server-only flags must not use the `NEXT_PUBLIC_` prefix.
 *
 * Truthy values: `'true'` or `'1'`. Anything else (including unset) is
 * treated as disabled.
 */

function readBoolean(envValue: string | undefined): boolean {
  return envValue === 'true' || envValue === '1';
}

/**
 * Server-only gate for durable background agent execution. This is evaluated
 * at process runtime and is never exposed to the browser bundle.
 */
export function isAgentRuntimeEnabled(): boolean {
  return readBoolean(process.env.OPENMAIC_AGENT_RUNTIME_ENABLED);
}

/** The Node runtime can start the runner only with a non-empty database URL. */
export function isAgentRuntimeConfigured(): boolean {
  return isAgentRuntimeEnabled() && Boolean(process.env.DATABASE_URL?.trim());
}

/**
 * Build-time workbench affordance. This public flag is separate from the
 * server runtime gate because Next.js inlines NEXT_PUBLIC values into client
 * bundles; both gates must be on before a workbench page is reachable.
 */
export function isProWorkbenchEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_PRO_WORKBENCH_ENABLED);
}

/**
 * MAIC Editor (Pro mode) gate. Default OFF — gates only the Pro toggle
 * affordance in `Header`. The `StageMode` type union is unaffected so
 * existing code paths typecheck identically with the flag in either
 * state.
 *
 * Implied by the Pro workbench flag: the workbench IS Pro mode, and a
 * workbench build without the editor toggle has no way to edit a course.
 * The standalone flag remains for deployments that want the classroom
 * editor without the workbench.
 */
export function isMaicEditorEnabled(): boolean {
  return isProWorkbenchEnabled() || readBoolean(process.env.NEXT_PUBLIC_MAIC_EDITOR_ENABLED);
}

/**
 * Experimental playback canvas renderer. Default OFF so classroom playback uses
 * the legacy in-app renderer unless explicitly enabled in `.env.local`.
 */
export function isPlaybackRendererEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_MAIC_PLAYBACK_RENDERER_ENABLED);
}

/**
 * Experimental Pro-mode slide editor renderer. Default OFF so professional
 * editing keeps using the legacy in-app editor canvas unless explicitly enabled
 * in `.env.local`.
 */
export function isEditorRendererEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED);
}

/**
 * Experimental Pi-based classroom chat runtime. Default OFF. The same public
 * flag selects the client runtime and gates the corresponding server route.
 */
export function isPiChatEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_PI_CHAT_ENABLED);
}

/**
 * Unified playback courseware-reference gate for PPT and Interactive scenes.
 * Default OFF and independently disableable while Pi chat remains available.
 */
export function isCoursewareReferenceEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED);
}

/**
 * Server-only selector for the Pi Child execution harness. Default OFF keeps
 * the existing Legacy JSON-action Child runtime.
 */
export function isPiNativeChildRuntimeEnabled(): boolean {
  return readBoolean(process.env.OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME);
}

/**
 * Server-only capability gate for Native Child Spotlight. This flag never
 * selects the Child runtime and has no effect while the Legacy harness is used.
 */
export function isPiNativeChildSpotlightEnabled(): boolean {
  return readBoolean(process.env.OPENMAIC_ENABLE_PI_NATIVE_CHILD_SPOTLIGHT);
}

/**
 * Server-authoritative gate for the vocational task-engine generation path.
 * Default OFF. When disabled, requests that include taskEngineMode must
 * silently fall back to the ordinary standard / interactive generation paths.
 */
export function isVocationalTaskEngineEnabled(): boolean {
  return readBoolean(process.env.OPENMAIC_ENABLE_VOCATIONAL);
}

export function resolveVocationalActive(
  requirements?: { taskEngineMode?: boolean } | null,
): boolean {
  return Boolean(requirements?.taskEngineMode) && isVocationalTaskEngineEnabled();
}

/**
 * Optional client-only affordance for exposing the experimental vocational
 * test toggle. This is not a security or routing gate.
 */
export function shouldShowVocationalTestUi(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_SHOW_VOCATIONAL_TEST_UI);
}

/**
 * Experimental classroom video export (Hyperframes composition ZIP, #865).
 * Default OFF — gates only the "Export Video" affordance in the export menu.
 * The emitter/compiler code paths are unaffected; this hides the UI entry
 * point until the render pipeline (#866) lands.
 */
export function isVideoExportEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_ENABLE_VIDEO_EXPORT);
}

/** Experimental PPTX import entry point. Default OFF. */
export function isPptxImportEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_ENABLE_PPTX_IMPORT);
}
