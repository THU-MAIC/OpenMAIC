import type { NextConfig } from 'next';
import { execSync } from 'child_process';

const nextConfig: NextConfig = {
  output: process.env.VERCEL ? undefined : 'standalone',
  serverExternalPackages: [],
  experimental: {
    proxyClientMaxBodySize: '200mb',
  },

  // Use the git commit SHA as the build ID so every deploy gets unique
  // JS chunk URLs — stale cached HTML pointing at old chunks becomes invalid.
  generateBuildId: async () => {
    try {
      return execSync('git rev-parse HEAD').toString().trim();
    } catch {
      return `build-${Date.now()}`;
    }
  },

  async headers() {
    const extraAncestors = process.env.ALLOWED_FRAME_ANCESTORS?.trim();
    const frameAncestors = extraAncestors ? `'self' ${extraAncestors}` : "'self'";

    return [
      {
        // HTML documents must always revalidate. Excludes content-hashed
        // static assets (_next/static) and public images which are immutable.
        source: '/((?!_next/static|_next/image|avatars|logos).*)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-cache, must-revalidate',
          },
        ],
      },
      {
        source: '/(.*)',
        headers: [
          // X-Frame-Options only supports SAMEORIGIN (no allow-list),
          // so we omit it when custom ancestors are configured.
          ...(!extraAncestors ? [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }] : []),
          {
            key: 'Content-Security-Policy',
            value: `frame-ancestors ${frameAncestors}`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
