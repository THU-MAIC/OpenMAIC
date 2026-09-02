import {
  isActionType,
  validateAction,
  validateScene,
  validateStage,
  type ValidationIssue,
} from '@openmaic/dsl';
import type { SceneValidator, StageValidator } from '@openmaic/storage';
import { hasPBLProjectV2Containers } from '@/lib/pbl/v2/types';
import { isEmptyLegacyPBLConfig, type PBLProjectConfig } from '@/lib/pbl/legacy/read';

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  errors: ValidationIssue[],
): void {
  if (typeof value[key] !== 'string' || value[key] === '') {
    errors.push({ path: `/${key}`, message: `expected non-empty string \`${key}\`` });
  }
}

/** Validate the app's four-way scene union at the document write boundary. */
export const validateAppScene: SceneValidator = (scene) => {
  const value = objectValue(scene);
  if (!value) {
    return { valid: false, errors: [{ path: '/', message: 'scene must be an object' }] };
  }
  if (value.type === 'slide' || value.type === 'quiz') return validateScene(scene);

  const errors: ValidationIssue[] = [];
  requiredString(value, 'id', errors);
  requiredString(value, 'stageId', errors);
  requiredString(value, 'title', errors);
  if (typeof value.order !== 'number' || !Number.isFinite(value.order)) {
    errors.push({ path: '/order', message: 'expected finite number `order`' });
  }

  const content = objectValue(value.content);
  if (value.type !== 'interactive' && value.type !== 'pbl') {
    errors.push({
      path: '/type',
      message: `unknown app scene type: ${JSON.stringify(value.type)}`,
    });
  } else if (!content) {
    errors.push({ path: '/content', message: 'scene `content` must be an object' });
  } else if (content.type !== value.type) {
    errors.push({
      path: '/content/type',
      message: `content type ${JSON.stringify(content.type)} does not match scene type ${JSON.stringify(value.type)}`,
    });
  } else if (value.type === 'interactive') {
    if (typeof content.html !== 'string' && typeof content.url !== 'string') {
      errors.push({
        path: '/content',
        message: 'interactive content requires `html` or `url` as a string',
      });
    }
    if (content.url !== undefined && typeof content.url !== 'string') {
      errors.push({ path: '/content/url', message: '`url` must be a string when present' });
    }
    if (content.html !== undefined && typeof content.html !== 'string') {
      errors.push({ path: '/content/html', message: '`html` must be a string when present' });
    }
    if (content.widgetConfig !== undefined && objectValue(content.widgetConfig) === null) {
      // Primitive widgetConfig values crash hydration ('in' throws on non-objects
      // in migrateInteractiveContent), so the write barrier rejects exactly that
      // class. Arrays and type-less objects stay tolerated as historical shapes.
      errors.push({
        path: '/content/widgetConfig',
        message: '`widgetConfig` must be an object when present',
      });
    }
    // The contract validator stays strict for external consumers. The app write
    // path remains lenient over historical widget shapes until stored configs
    // are canonicalized in a follow-up.
  } else if (
    value.type === 'pbl' &&
    content.projectConfig !== undefined &&
    (!objectValue(content.projectConfig) || Array.isArray(content.projectConfig))
  ) {
    errors.push({ path: '/content/projectConfig', message: '`projectConfig` must be an object' });
  } else if (
    value.type === 'pbl' &&
    // null is treated like absent so documents stored before projectV2
    // validation existed keep saving; the renderer applies the same rule.
    content.projectV2 != null &&
    // Every scene accepted by the old write barrier carried projectConfig, so
    // stored scenes with both fields are the pre-cutover hybrid cohort. Preserve
    // a damaged projectV2 there as inert bytes — but only when the legacy config
    // is structurally sound and non-empty (real stored v1 data, the renderer's
    // actual fallback); an empty stub like `{}` must not disable v2 validation.
    // V2-only scenes are new planner writes, where strict container validation
    // enforces planner output quality.
    !(
      objectValue(content.projectConfig) &&
      !Array.isArray(content.projectConfig) &&
      !isEmptyLegacyPBLConfig(content.projectConfig as PBLProjectConfig)
    ) &&
    !hasPBLProjectV2Containers(content.projectV2)
  ) {
    errors.push({
      path: '/content/projectV2',
      message: '`projectV2` must contain milestones, roles and threads arrays',
    });
  }

  // The app-only branch historically never looked at `actions`, so a
  // `patch_stage set /actions = "not-an-array"` persisted a string that
  // crashed the tool's own return-value construction and playback
  // (`(scene.actions ?? []).map is not a function` — R5-P2-2). Every element
  // must be action-shaped (a string `id` and a string `type`), and an element
  // whose type IS in the DSL action registry additionally runs the DSL's own
  // per-variant required-field validation — `{id, type:'speech'}` without a
  // string `text` crashes the playback engine's `speechAction.text.trim()`
  // (R6-P2-3), so persisting it is persisting corruption. Elements with types
  // OUTSIDE the registry stay lenient beyond the id/type shape: the legacy
  // corpus holds hundreds of invented types that must keep saving — the write
  // barrier is for corruption, not canon. (Legacy actions missing only an
  // `id` are completed by `canonicalizeLegacyScene` before they ever reach
  // this barrier — R6-P2-2.)
  if (value.actions !== undefined) {
    if (!Array.isArray(value.actions)) {
      errors.push({ path: '/actions', message: '`actions` must be an array' });
    } else {
      value.actions.forEach((action, index) => {
        if (action === null || typeof action !== 'object' || Array.isArray(action)) {
          errors.push({ path: `/actions/${index}`, message: 'action must be an object' });
          return;
        }
        const record = action as Record<string, unknown>;
        if (typeof record.id !== 'string') {
          errors.push({ path: `/actions/${index}/id`, message: 'expected string `id`' });
        }
        if (typeof record.type !== 'string') {
          errors.push({ path: `/actions/${index}/type`, message: 'expected string `type`' });
          return;
        }
        if (isActionType(record.type)) {
          const variant = validateAction(record);
          if (!variant.valid) {
            for (const issue of variant.errors ?? []) {
              errors.push({
                path: `/actions/${index}${issue.path === '/' ? '' : issue.path}`,
                message: issue.message,
              });
            }
          }
        }
      });
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
};

/** Validate canonical app stage metadata and exclude device playback position. */
export const validateAppStage: StageValidator = (stage) => {
  const base = validateStage(stage);
  const value = objectValue(stage);
  if (!value || !Object.prototype.hasOwnProperty.call(value, 'currentSceneId')) return base;
  const issue = {
    path: '/currentSceneId',
    message: '`currentSceneId` is device playback state and is not allowed on AppStage',
  };
  return base.valid
    ? { valid: false, errors: [issue] }
    : { valid: false, errors: [...base.errors, issue] };
};
