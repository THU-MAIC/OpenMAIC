/**
 * PBL v2 — Git bridge (public surface).
 *
 * Self-hosted Gitea integration for git-backed submissions: signature
 * verification + push parsing (pure, unit-tested), env config, and a typed
 * REST client. Routes under `/api/pbl/v2/git/*` compose these.
 */

export * from './types';
export * from './config';
export * from './webhook';
export * from './gitea-client';
export * from './static-checks';
export * from './provision';
