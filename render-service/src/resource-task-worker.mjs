import { statSync } from 'node:fs';
import { createRenderJob, executeRenderJob } from 'hyperframes-resource-producer';

const [projectDir, outputPath, optionsJson] = process.argv.slice(2);
if (!projectDir || !outputPath || !optionsJson)
  throw new Error('Missing resource worker arguments');
const options = JSON.parse(optionsJson);
const job = createRenderJob({
  fps: options.fps,
  quality: options.quality,
  format: 'mp4',
  workers: 1,
  useGpu: false,
  hdrMode: 'force-sdr',
});
await executeRenderJob(job, projectDir, outputPath, () => {});
if (!statSync(outputPath).isFile() || statSync(outputPath).size === 0)
  throw new Error('Producer did not create a non-empty candidate');
