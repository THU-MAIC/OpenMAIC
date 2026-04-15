/**
 * Temporal Worker
 *
 * Run this alongside Next.js to process background jobs:
 *   pnpm run worker          # production (Temporal Cloud)
 *   pnpm run dev:full        # dev (local Temporal + Next.js in parallel)
 *
 * The worker connects to:
 *   - localhost:7233 (dev) when TEMPORAL_API_KEY is not set
 *   - Temporal Cloud       when TEMPORAL_API_KEY is set
 */

// Register @/ path aliases from tsconfig before any other imports
import 'tsconfig-paths/register';

import path from 'path';
import { Worker, NativeConnection } from '@temporalio/worker';
import { TASK_QUEUE } from './constants';
import * as classroomActivities from './activities/classroom-generation.activities';
import * as catalogActivities from './activities/course-catalog.activities';
import * as previewActivities from './activities/preview-generation.activities';

async function main() {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const apiKey = process.env.TEMPORAL_API_KEY;

  console.log(`[Worker] Connecting to Temporal at ${address} (namespace: ${namespace})`);

  const connection = await NativeConnection.connect({
    address,
    tls: apiKey ? {} : undefined,
    ...(apiKey ? { apiKey } : {}),
  });

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue: TASK_QUEUE,
    // Temporal bundles workflow code with webpack; the workflowsPath must be
    // an absolute path to the file containing all workflow exports.
    workflowsPath: path.join(__dirname, 'workflows'),
    activities: {
      ...classroomActivities,
      ...catalogActivities,
      ...previewActivities,
    },
    // Allow the bundler to resolve @/ aliases from tsconfig
    bundlerOptions: {
      webpackConfigHook(config) {
        const existing = (config.resolve ??= {});
        existing.alias = {
          ...(existing.alias as Record<string, string> | undefined),
          '@': path.resolve(__dirname, '..'),
        };
        return config;
      },
    },
  });

  console.log(`[Worker] Started. Task queue: ${TASK_QUEUE}`);
  await worker.run();
}

main().catch((err) => {
  console.error('[Worker] Fatal error:', err);
  process.exit(1);
});
