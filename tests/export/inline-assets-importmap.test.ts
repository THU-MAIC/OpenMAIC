import { describe, it, expect } from 'vitest';
import { buildInlinedImportmap } from '@/lib/export/inline-assets-importmap';

const enc = (s: string) => ({ bytes: new TextEncoder().encode(s), contentType: 'text/javascript' });

describe('buildInlinedImportmap', () => {
  it('inlines a direct module entry to a data: URI', async () => {
    const fetchAsset = async (url: string) =>
      url === 'https://unpkg.com/three@0.160.0/build/three.module.js'
        ? enc('export const THREE=1')
        : null;
    const { imports, report } = await buildInlinedImportmap(
      { three: 'https://unpkg.com/three@0.160.0/build/three.module.js' },
      ["import * as THREE from 'three';"],
      fetchAsset,
    );
    expect(imports.three).toMatch(/^data:text\/javascript;base64,/);
    expect(report.inlined).toContain('https://unpkg.com/three@0.160.0/build/three.module.js');
  });

  it('expands a prefix entry (three/addons/) into explicit full-specifier data: entries and drops the prefix', async () => {
    const base = 'https://unpkg.com/three@0.160.0/examples/jsm/';
    const fetchAsset = async (url: string) => {
      if (url === 'https://unpkg.com/three@0.160.0/build/three.module.js')
        return enc('export const THREE=1');
      if (url === base + 'controls/OrbitControls.js')
        return enc("import * as THREE from 'three'; export class OrbitControls{}");
      return null;
    };
    const moduleBodies = [
      "import * as THREE from 'three'; import { OrbitControls } from 'three/addons/controls/OrbitControls.js';",
    ];
    const { imports } = await buildInlinedImportmap(
      { three: 'https://unpkg.com/three@0.160.0/build/three.module.js', 'three/addons/': base },
      moduleBodies,
      fetchAsset,
    );
    expect(imports['three']).toMatch(/^data:/);
    expect(imports['three/addons/controls/OrbitControls.js']).toMatch(/^data:/);
    expect(imports['three/addons/']).toBeUndefined();
  });

  it('recursively resolves nested addon imports', async () => {
    const base = 'https://unpkg.com/three@0.160.0/examples/jsm/';
    const fetchAsset = async (url: string) => {
      if (url === 'https://x/three.js') return enc('export const THREE=1');
      if (url === base + 'a.js') return enc("import 'three/addons/b.js'; export const a=1;");
      if (url === base + 'b.js') return enc("import * as THREE from 'three'; export const b=2;");
      return null;
    };
    const { imports } = await buildInlinedImportmap(
      { three: 'https://x/three.js', 'three/addons/': base },
      ["import 'three/addons/a.js';"],
      fetchAsset,
    );
    expect(imports['three/addons/a.js']).toMatch(/^data:/);
    expect(imports['three/addons/b.js']).toMatch(/^data:/);
  });

  it('records failures for unfetchable modules and leaves their specifier unmapped', async () => {
    const { imports, report } = await buildInlinedImportmap(
      { three: 'https://dead/three.js' },
      ["import 'three';"],
      async () => null,
    );
    expect(imports.three).toBeUndefined();
    expect(report.failed.map((f) => f.url)).toContain('https://dead/three.js');
  });

  it('ignores relative/bare specifiers not present in the importmap', async () => {
    const { imports } = await buildInlinedImportmap(
      { three: 'https://x/three.js' },
      ["import './local.js'; import 'react';"],
      async (url: string) => (url === 'https://x/three.js' ? enc('export const T=1') : null),
    );
    // only 'three' was imported among mapped specifiers? Actually 'three' is NOT imported here.
    // local.js and react are not in the importmap → no entries produced.
    expect(Object.keys(imports)).toEqual([]);
  });

  it('handles dynamic import() specifiers', async () => {
    const fetchAsset = async (url: string) =>
      url === 'https://x/three.js' ? enc('export const T=1') : null;
    const { imports } = await buildInlinedImportmap(
      { three: 'https://x/three.js' },
      ["const m = await import('three');"],
      fetchAsset,
    );
    expect(imports.three).toMatch(/^data:/);
  });
});
