/** Single source of truth for prompt URLs, CDN compatibility, and copied assets. */
export const INTERACTIVE_ASSET_PATH = '/vendor/interactive';

export const INTERACTIVE_LIBRARIES = [
  {
    package: 'katex',
    license: 'LICENSE',
    version: '0.16.38',
    // Pre-1.0 releases are compatible only within this minor version.
    compatibility: 'minor',
    entry: 'dist/katex.min.js',
    files: [
      'dist/katex.min.js',
      'dist/katex.min.css',
      'dist/contrib/auto-render.min.js',
      'dist/fonts',
    ],
    aliases: {},
    cdnjs: 'KaTeX',
  },
  {
    package: 'three',
    license: 'LICENSE',
    version: '0.160.0',
    compatibility: 'minor',
    entry: 'build/three.module.js',
    files: ['build', 'examples/jsm'],
    aliases: {},
    cdnjs: 'three.js',
  },
  {
    package: 'chart.js',
    license: 'LICENSE.md',
    version: '4.4.8',
    compatibility: 'major',
    entry: 'dist/chart.umd.js',
    files: ['dist/chart.umd.js'],
    aliases: {
      'dist/chart.umd.min.js': 'dist/chart.umd.js',
      'chart.umd.js': 'dist/chart.umd.js',
      'chart.umd.min.js': 'dist/chart.umd.js',
    },
    cdnjs: 'Chart.js',
  },
  {
    package: '@tailwindcss/browser',
    license: 'LICENSE',
    version: '4.1.18',
    compatibility: 'major',
    entry: 'dist/index.global.js',
    files: ['dist/index.global.js'],
    aliases: {},
    cdnjs: undefined,
  },
] as const;

export function interactiveAssetBaseUrl(): string {
  // Next.js exposes this public setting to browser consumers at build time.
  try {
    return process.env.INTERACTIVE_ASSET_BASE_URL?.trim() || INTERACTIVE_ASSET_PATH;
  } catch {
    return INTERACTIVE_ASSET_PATH;
  }
}

export function interactiveLibraryUrl(
  name: string,
  file?: string,
  baseUrl = interactiveAssetBaseUrl(),
): string {
  const library = INTERACTIVE_LIBRARIES.find((entry) => entry.package === name);
  if (!library) throw new Error(`Unknown interactive library: ${name}`);
  return `${baseUrl.replace(/\/$/, '')}/${name}@${library.version}/${file ?? library.entry}`;
}

export function interactiveLibraryPrompt(): string {
  return [
    '## Available libraries',
    'Use only the deployment-hosted URLs below, exactly as written. Load only libraries you need. Do not use public CDNs, Google Fonts, or other external libraries; use system fonts. Initialize classic-script libraries after their load event or DOMContentLoaded when using defer.',
    ...INTERACTIVE_LIBRARIES.map(
      (library) =>
        `- ${library.package} ${library.version}: ${interactiveLibraryUrl(library.package)}`,
    ),
    `- Three.js addons import-map prefix: ${interactiveLibraryUrl('three', 'examples/jsm/')}`,
    'For Three.js use an import map with "three" and "three/addons/" set to the URLs above. Tailwind uses the v4 browser runtime, not the legacy v3 Play CDN API. The platform handles KaTeX automatically when math delimiters occur in page text; do not load or call KaTeX yourself.',
  ].join('\n');
}
