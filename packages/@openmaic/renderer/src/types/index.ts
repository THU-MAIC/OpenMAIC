// The slide object model is the canonical contract from @openmaic/dsl. The renderer
// no longer vendors its own copy; it re-exports the DSL types here so the public
// `@openmaic/renderer/types` surface stays intact.
export * from '@openmaic/dsl';
export * from './effects';
