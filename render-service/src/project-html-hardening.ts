/**
 * Harden every untrusted same-origin document in an extracted project.
 *
 * The uploaded export ZIP never passes through the app packager, so the
 * producer would otherwise serve the project's authored `index.html` (and every
 * other HTML/scene file) with no policy at all, and `.svg`/`.xhtml` files with
 * no policy and removable scripting. Harden the files once, after extraction
 * and before the render pipeline reads them.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  UNTRUSTED_RENDER_CSP,
  injectUntrustedHtmlCsp,
  injectUntrustedHtmlCspBytes,
} from './untrusted-html-csp.js';
import { sanitizeSvgDocument, sanitizeXhtmlDocument } from './untrusted-document-sanitizer.js';

const HTML_EXTENSION = /\.html?$/i;
const SVG_EXTENSION = /\.svg$/i;
const XHTML_EXTENSION = /\.xhtml$/i;

/**
 * Inject the render policy into one HTML document unless it is already present.
 *
 * The `<meta charset>` decode trick is not exploitable on this path today: the
 * producer serves `.html` with a fixed `Content-Type: text/html; charset=utf-8`
 * (which outranks any in-document charset) and the preview `srcDoc` inherits
 * the parent document's UTF-8 decoding. A producer change that stops forcing
 * the charset would require revisiting this placement.
 */
export function hardenProjectHtml(html: string): string {
  return injectUntrustedHtmlCsp(html, UNTRUSTED_RENDER_CSP);
}

function hardenProjectHtmlBytes(bytes: Uint8Array): Uint8Array {
  return injectUntrustedHtmlCspBytes(bytes, UNTRUSTED_RENDER_CSP);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Harden every `.html`/`.htm`, `.svg` and `.xhtml` file under `projectDir`.
 * HTML files get the CSP `<meta>` inserted on their byte image; `.svg`/
 * `.xhtml` are re-serialized with active content removed. Files are only
 * rewritten when their bytes actually change.
 */
export async function hardenProjectDirectory(projectDir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(projectDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const path = join(projectDir, entry.name);
      if (entry.isDirectory()) {
        await hardenProjectDirectory(path);
        return;
      }
      if (!entry.isFile()) return;

      let transform: ((bytes: Uint8Array) => Uint8Array) | undefined;
      if (HTML_EXTENSION.test(entry.name)) transform = hardenProjectHtmlBytes;
      else if (SVG_EXTENSION.test(entry.name)) transform = sanitizeSvgDocument;
      else if (XHTML_EXTENSION.test(entry.name)) transform = sanitizeXhtmlDocument;
      if (!transform) return;

      const bytes = await readFile(path);
      const hardened = transform(bytes);
      if (!bytesEqual(bytes, hardened)) await writeFile(path, hardened);
    }),
  );
}
