import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  INTERACTIVE_ASSET_PATH,
  INTERACTIVE_LIBRARIES,
  interactiveAssetBaseUrl,
} from '../../packages/@openmaic/generation/src/interactive-libraries.js';
import { config } from './config.js';

export const INTERACTIVE_PREVIEW_ORIGIN = 'https://openmaic-preview.invalid';

const CONTENT_TYPES: Record<string, string> = {
  '.cjs': 'text/javascript',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

const LIBRARY_DIRECTORIES = new Set<string>(
  INTERACTIVE_LIBRARIES.map(({ package: name, version }) => `${name}@${version}`),
);

function libraryBases(assetBase: string): string[] {
  const local = new URL(`${INTERACTIVE_ASSET_PATH}/`, INTERACTIVE_PREVIEW_ORIGIN).href;
  try {
    const mirror = new URL(`${assetBase.replace(/\/$/, '')}/`, INTERACTIVE_PREVIEW_ORIGIN);
    if (
      !['http:', 'https:'].includes(mirror.protocol) ||
      mirror.username ||
      mirror.password ||
      mirror.search ||
      mirror.hash ||
      /[;,]/.test(mirror.pathname)
    ) {
      return [local];
    }
    return [...new Set([local, mirror.href])];
  } catch {
    return [local];
  }
}

export class HostedInteractiveLibraries {
  readonly bases: readonly string[];

  constructor(
    private readonly directory = config.interactiveLibraryDir,
    assetBase = interactiveAssetBaseUrl(),
  ) {
    this.bases = libraryBases(assetBase);
  }

  /** Match the hosted library namespace before attempting any disk access. */
  match(url: string): { library: string; file: string } | undefined {
    try {
      const parsed = new URL(url, INTERACTIVE_PREVIEW_ORIGIN);
      if (parsed.search || parsed.hash) return;
      const base = this.bases.find((candidate) => parsed.href.startsWith(candidate));
      if (!base) return;
      const match = /^((?:@[^/]+\/)?[^/@]+@[^/]+)\/(.+)$/.exec(
        decodeURIComponent(parsed.href.slice(base.length)),
      );
      if (!match) return;
      const [, library, file] = match;
      if (
        !LIBRARY_DIRECTORIES.has(library!) ||
        /[\\\0]/.test(file!) ||
        file!.split('/').some((part) => !part || part === '.' || part === '..')
      ) {
        return;
      }
      return { library: library!, file: file! };
    } catch {
      // A malformed URL or percent escape has no local counterpart.
    }
  }

  async read(url: string, signal?: AbortSignal) {
    const match = this.match(url);
    if (!match || signal?.aborted) return;
    try {
      const libraryRoot = path.join(await realpath(this.directory), match.library);
      const target = await realpath(path.resolve(libraryRoot, match.file));
      if (!target.startsWith(`${libraryRoot}${path.sep}`) || !(await stat(target)).isFile()) return;
      const body = await readFile(target, { signal });
      const contentType = CONTENT_TYPES[path.extname(match.file).toLowerCase()];
      return { body, contentType: contentType ?? 'application/octet-stream' };
    } catch {
      // Missing assets are left to the request guard to abort.
    }
  }
}

export const hostedInteractiveLibraries = new HostedInteractiveLibraries();
