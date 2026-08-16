import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('render-service container contract', () => {
  it('resets HOME and the cache root before dropping privileges', () => {
    const entrypoint = read('docker-entrypoint.sh');
    expect(entrypoint).toContain('export HOME="${RENDER_HOME:-/app}"');
    expect(entrypoint).toContain('export XDG_CACHE_HOME="$HOME/.cache"');

    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('HOME=/app');
    expect(dockerfile).toContain('XDG_CACHE_HOME=/app/.cache');
    expect(dockerfile).toMatch(/mkdir -p \/tmp\/openmaic-renders \/app\/\.cache/);
  });

  it('uses the explicit standard single-job profile in Compose', () => {
    const compose = read('../docker-compose.yml');
    expect(compose).toContain('RENDER_MAX_CONCURRENCY=1');
    expect(compose).toContain('RENDER_MAX_CONCURRENT_EXTRACTIONS=1');
    expect(compose).toContain('RENDER_RESOURCE_PROFILE=${RENDER_RESOURCE_PROFILE:-standard}');
    expect(compose).toContain('PRODUCER_HEADLESS_SHELL_PATH=/usr/bin/chromium-headless-shell');
    expect(compose).toContain('PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS=900000');
    expect(compose).toContain('HF_STATIC_DEDUP=false');
    expect(compose).toContain('mem_limit: ${RENDER_SERVICE_MEMORY_LIMIT:-8g}');
  });

  it('configures a beginFrame-capable capture profile in the image', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('chromium-headless-shell');
    expect(dockerfile).toContain('PRODUCER_HEADLESS_SHELL_PATH=/usr/bin/chromium-headless-shell');
    expect(dockerfile).toContain('RENDER_RESOURCE_PROFILE=standard');
  });

  it('pins the browser, encoder, fonts, Node image, and producer dependency', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain(
      'node:22.22.2-bookworm-slim@sha256:f3a68cf41a855d227d1b0ab832bed9749469ef38cf4f58182fb8c893bc462383',
    );
    expect(dockerfile).toContain('CHROMIUM_VERSION=151.0.7922.71-1~deb12u1');
    expect(dockerfile).toContain('"chromium-common=${CHROMIUM_VERSION}"');
    expect(dockerfile).toContain('FFMPEG_VERSION=7:5.1.9-0+deb12u1');
    expect(dockerfile).toContain('FONTS_NOTO_CORE_VERSION=20201225-1');
    expect(dockerfile).toContain('DEBIAN_SNAPSHOT=20260731T162426Z');
    expect(dockerfile).toContain('http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}');
    expect(dockerfile).toContain(
      'http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}',
    );

    const packageJson = read('package.json');
    expect(packageJson).toContain('"@hyperframes/producer": "0.7.60"');
  });
});
