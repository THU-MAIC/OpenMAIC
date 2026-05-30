import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Static export: served as plain files by nginx, no Node server.
  output: 'export',
  // Target deploy path: open.maic.chat/docs
  basePath: '/docs',
  // Static export cannot optimize images at runtime.
  images: {
    unoptimized: true,
  },
};

export default withMDX(config);
