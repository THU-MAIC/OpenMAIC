import type { ModelConfigFile } from './openmaic-yml';

/** Fixed text: a refusal must not expose the operator's model catalogue or key. */
export class ModelAuthorizationError extends Error {
  constructor() {
    super('This model is not authorized for server-managed credentials');
    this.name = 'ModelAuthorizationError';
  }
}

/** Shared source for authorization and the deployment provider's model picker. */
export function deploymentAuthorizedModels(
  config: ModelConfigFile | undefined,
  providerId: string,
): string[] {
  const providers = config?.providers;
  if (!providers || !Object.hasOwn(providers, providerId)) return [];
  const models = new Set(providers[providerId].models ?? []);
  const prefix = `${providerId}:`;
  const addReference = (reference: string | undefined) => {
    if (reference?.startsWith(prefix)) models.add(reference.slice(prefix.length));
  };

  for (const assignment of Object.values(config?.slots ?? {})) {
    if (typeof assignment === 'string') {
      addReference(assignment);
    } else if (assignment) {
      addReference(assignment.model);
      addReference(assignment.fallback);
    }
  }
  return [...models];
}

/** Only operator declarations grant access; workspace assignments and SDK catalogues do not. */
export function assertDeploymentModelAuthorized(
  config: ModelConfigFile | undefined,
  providerId: string,
  modelId: string,
): void {
  if (!deploymentAuthorizedModels(config, providerId).includes(modelId)) {
    throw new ModelAuthorizationError();
  }
}
