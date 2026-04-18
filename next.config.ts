import type { NextConfig } from 'next';
import { execSync } from 'child_process';

const nextConfig: NextConfig = {
  output: process.env.VERCEL ? undefined : 'standalone',
  transpilePackages: ['mathml2omml', 'pptxgenjs'],
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
    ];
  },
};

export default nextConfig;
