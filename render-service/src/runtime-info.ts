import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { RuntimeVersions } from './types.js';

const execFileAsync = promisify(execFile);

async function packageVersion(url: URL): Promise<string> {
  const contents = JSON.parse(await readFile(url, 'utf8')) as { version?: unknown };
  if (typeof contents.version !== 'string') throw new Error(`Missing version in ${url.pathname}`);
  return contents.version;
}

async function commandVersion(command: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  const firstLine = `${stdout || stderr}`.split('\n')[0]?.trim();
  if (!firstLine) throw new Error(`${command} did not report a version`);
  return firstLine;
}

async function observedVersion(task: Promise<string>): Promise<string> {
  return task.catch((error: unknown) =>
    error instanceof Error ? `unavailable: ${error.message}` : `unavailable: ${String(error)}`,
  );
}

export async function collectRuntimeVersions(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeVersions> {
  const chromiumPath =
    env.PRODUCER_HEADLESS_SHELL_PATH ||
    env.PUPPETEER_EXECUTABLE_PATH ||
    '/usr/bin/chromium-headless-shell';
  const ffmpegPath = env.HYPERFRAMES_FFMPEG_PATH || env.FFMPEG_PATH || 'ffmpeg';

  const [service, producer, chromium, ffmpeg] = await Promise.all([
    observedVersion(packageVersion(new URL('../package.json', import.meta.url))),
    observedVersion(
      packageVersion(
        new URL('../node_modules/@hyperframes/producer/package.json', import.meta.url),
      ),
    ),
    observedVersion(commandVersion(chromiumPath, ['--version'])),
    observedVersion(commandVersion(ffmpegPath, ['-version'])),
  ]);

  return {
    service,
    producer,
    node: process.version,
    chromium,
    chromiumPath,
    ffmpeg,
    ffmpegPath,
    containerImage: env.RENDER_CONTAINER_IMAGE || null,
  };
}
