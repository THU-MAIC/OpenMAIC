/**
 * The importer's protocol with the server, as plain constants: the model
 * settings import uses them without loading the course importer's clients.
 */

/** The request header an importer request carries its browser id in. */
export const LEGACY_IMPORT_HEADER = 'x-openmaic-legacy-import';

/** Where the binding is asked for (without the header). */
export const BINDING_ENDPOINT = '/api/identity/legacy-import-binding';
