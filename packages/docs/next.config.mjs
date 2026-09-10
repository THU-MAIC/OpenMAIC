import { createMDX } from 'fumadocs-mdx/next';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_BASE_PATH } from './lib/locales.mjs';

const withMDX = createMDX();
const docsRoot = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Static export: served as plain files by nginx, no Node server.
  output: 'export',
  // Target deploy path: open.maic.chat/docs
  basePath: DOCS_BASE_PATH,
  // This package is a standalone Next.js app with its own lockfile and alias
  // map. Without an explicit boundary, Turbopack walks up to the repository
  // root and compiles the product middleware as part of the docs application.
  turbopack: {
    root: docsRoot,
  },
  // Static export cannot optimize images at runtime.
  images: {
    unoptimized: true,
  },
};

export default withMDX(config);
