/** Fixed refusal text: do not disclose configured model ids or provider details. */
export class ModelAuthorizationError extends Error {
  readonly code = 'PROVIDER_DISABLED';
  readonly httpStatus = 403;

  constructor() {
    super('This model is not authorized for server-managed credentials');
    this.name = 'ModelAuthorizationError';
  }
}
