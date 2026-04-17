import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: process.env.VERCEL ? undefined : 'standalone',
  devIndicators: false,
  transpilePackages: ['mathml2omml', 'pptxgenjs'],
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],
  experimental: {
    proxyClientMaxBodySize: '200mb',
  },
};

export default nextConfig;
