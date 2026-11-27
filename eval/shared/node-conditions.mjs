// Standalone evals import the same server modules as Next. Resolve server-only
// for this process and allow tsx's CommonJS output to load ESM-only exports.
// Setting --conditions=import globally breaks CommonJS dependencies such as pg.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return nextResolve(specifier, {
        ...context,
        conditions: [...context.conditions, 'react-server'],
      });
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' || context.conditions.includes('import'))
        throw error;
      return nextResolve(specifier, { ...context, conditions: [...context.conditions, 'import'] });
    }
  },
});
