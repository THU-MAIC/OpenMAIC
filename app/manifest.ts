import type { MetadataRoute } from 'next';

// Honour BASE_PATH so the manifest works both standalone (root) and when the
// app is mounted under a path prefix behind a reverse proxy.
const base = process.env.BASE_PATH?.trim() || '';

export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'OpenMAIC',
    short_name: 'OpenMAIC',
    description:
      'The open-source AI interactive classroom. Works on slow networks; lessons you have already opened stay available offline.',
    start_url: `${base}/`,
    scope: `${base}/`,
    display: 'standalone',
    background_color: '#0d1117',
    theme_color: '#1e293b',
    icons: [
      { src: `${base}/openmaic-mark.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${base}/apple-icon.png`, sizes: '180x180', type: 'image/png' },
    ],
  };
}
