'use client';

/**
 * Packaging — assemble the emitted text project + collected asset bytes +
 * vendored GSAP into the self-contained export ZIP.
 *
 * The emitter ({@link emitHyperframes}) produced every text file (index.html,
 * manifest, subtitles, README) and the collection layer ({@link collectVideoAssets})
 * produced the binary bytes keyed by the compiler's asset-plan paths. This layer
 * lays them out under `assets/`, adds the vendored GSAP (determinism: shipped in
 * the zip, never a CDN), and streams the archive to a Blob. JSZip is imported
 * lazily so it stays out of the main app bundle.
 *
 * App-side / impure: does IO (fetch for GSAP) and dynamic-imports JSZip.
 */
import { assetUrl, type EmittedProject } from '@/lib/video-export';

/** Default location the app serves the vendored GSAP from (committed at public/vendor). */
const GSAP_PUBLIC_URL = '/vendor/gsap.min.js';

export interface PackageOptions {
  /**
   * The vendored GSAP source text. Defaults to fetching {@link GSAP_PUBLIC_URL}
   * (served from `public/vendor/gsap.min.js`). Passing it explicitly avoids the
   * fetch (e.g. in tests).
   */
  gsapSource?: string;
  onProgress?: (message: string) => void;
}

/** Fetch the app's committed, vendored GSAP so the export bundles it (no CDN at render). */
async function loadGsapSource(): Promise<string> {
  const res = await fetch(GSAP_PUBLIC_URL);
  if (!res.ok)
    throw new Error(`Failed to load vendored GSAP from ${GSAP_PUBLIC_URL} (${res.status})`);
  return res.text();
}

/**
 * Build the export ZIP blob from an emitted project and its collected assets.
 * Text files land at the project root; asset blobs land under `assets/<planPath>`
 * (matching the URLs the emitted HTML references); GSAP is vendored at the
 * project's `gsapVendorPath`.
 */
export async function packageVideoZip(
  project: EmittedProject,
  assetBlobs: Map<string, Blob>,
  options: PackageOptions = {},
): Promise<Blob> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  // Emitted text files (index.html, manifest, subtitles, README) at the root.
  for (const file of project.files) {
    zip.file(file.path, file.content);
  }

  // Collected binary assets under assets/<planPath>.
  for (const [planPath, blob] of assetBlobs) {
    zip.file(assetUrl(planPath), blob);
  }

  // Vendored GSAP at the path the HTML loads it from.
  options.onProgress?.('Bundling GSAP runtime');
  const gsapSource = options.gsapSource ?? (await loadGsapSource());
  zip.file(project.gsapVendorPath, gsapSource);

  options.onProgress?.('Compressing archive');
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}
