import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readProjectFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('Layer 1 Taluss rebrand', () => {
  it('uses Taluss metadata and German HTML lang', () => {
    const layout = readProjectFile('app/layout.tsx');

    expect(layout).toContain("title: 'Taluss'");
    expect(layout).toContain("'Medizin lernen. Interaktiv statt passiv.'");
    expect(layout).toContain('<html lang="de"');
  });

  it('uses Taluss brand colors in globals css', () => {
    const globals = readProjectFile('app/globals.css');

    expect(globals).toContain('--primary: #D96C4B;');
    expect(globals).toContain('--secondary: #A16959;');
    expect(globals).toContain('--accent: #009C97;');
    expect(globals).toContain('--background: #F5F0E8;');
    expect(globals).toContain('--radius: 0.875rem;');

    expect(globals).not.toContain('#722ed1');
    expect(globals).not.toContain('#8b47ea');
  });

  it('removes OpenMAIC branding from the key landing surfaces', () => {
    const homePage = readProjectFile('app/page.tsx');
    const sceneSidebar = readProjectFile('components/stage/scene-sidebar.tsx');

    expect(homePage).toContain('Taluss Open Source Project');
    expect(homePage).not.toContain('OpenMAIC');
    expect(sceneSidebar).not.toContain('OpenMAIC');
  });
});
