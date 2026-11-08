/** Run under the same host registration/config as the application, on a scheduled job. */
import { SandboxStore } from '../lib/server/sandbox/store';
const store = await SandboxStore.open();
const result = await store.collectCheckpoints();
console.log(JSON.stringify(result));
process.exitCode = result.deferred ? 1 : 0;
// The standalone maintenance process owns its pool; no server is sharing it.
process.exit(process.exitCode);
