import { resolve } from 'node:path';

/** Writable root for local runtime data (classrooms, assets, jobs, and usage). */
export const OPENMAIC_DATA_DIR = resolve(process.env.OPENMAIC_DATA_DIR || 'data');
