import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: process.env.VERCEL ? undefined : 'standalone',
  transpilePackages: ['mathml2omml', 'pptxgenjs'],
  serverExternalPackages: [],
  experimental: {
    proxyClientMaxBodySize: '200mb',
  },
  env: {
    HTTPS_ENABLE: process.env.HTTPS_ENABLE,
    HTTP_PORT: process.env.HTTP_PORT,
    HTTPS_PORT: process.env.HTTPS_PORT,
    HTTPS_CERT_PATH: process.env.HTTPS_CERT_PATH,
    HTTPS_KEY_PATH: process.env.HTTPS_KEY_PATH,
    HOST: process.env.HOST,
  },
};

export default nextConfig;
