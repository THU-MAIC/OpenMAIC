import { validateScene, validateStage, type ValidationIssue } from '@openmaic/dsl';
import type { SceneValidator, StageValidator } from '@openmaic/storage';

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
  } else if (value.type === 'interactive' && typeof content.url !== 'string') {
    errors.push({ path: '/content/url', message: 'interactive content requires string `url`' });
  } else if (value.type === 'pbl' && !objectValue(content.projectConfig)) {
    errors.push({
      path: '/content/projectConfig',
      message: 'pbl content requires object `projectConfig`',
    });
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
