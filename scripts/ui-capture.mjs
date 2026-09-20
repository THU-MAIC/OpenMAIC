#!/usr/bin/env node

// Saves a screenshot of a running page to a FILE, for `capture.ui` in
// _acceptance/config.yaml. The Gate-2 evidence slideshow reads frames off disk
// (evidence/E{id}-step{n}.png); browser tools that return an inline image
// cannot feed it.
//
// Driven by Playwright rather than the kit's puppeteer-core reference: this
// repo already depends on @playwright/test for e2e, so reusing it costs no new
// dependency and captures the same browser the e2e suite proves against.
//
// Prefers Playwright's own Chromium, which is what e2e asserts on and what CI
// already caches. Falls back to an installed Google Chrome so a developer whose
// browser cache is empty or stale (Playwright pins an exact build per version)
// gets a frame instead of a download prompt. Set CAPTURE_CHANNEL to force one.
//
// Usage: node scripts/ui-capture.mjs <url> <out.png> [--wait ms] [--full] [--w px] [--h px]

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { chromium } from '@playwright/test';

const VALUE_FLAGS = new Set(['--wait', '--w', '--h']);
const BARE_FLAGS = new Set(['--full']);

function parseArgs(argv) {
  const flags = new Map();
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Expected a value after ${arg}`);
      }
      flags.set(arg, value);
      index += 1;
      continue;
    }
    if (BARE_FLAGS.has(arg)) {
      flags.set(arg, true);
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
    positional.push(arg);
  }

  const [url, out] = positional;
  if (!url || !out) {
    throw new Error('usage: ui-capture <url> <out.png> [--wait ms] [--full] [--w px] [--h px]');
  }

  // A viewport wide enough for the desktop layout the workbench and editor are
  // built for. Pass --w/--h for a mobile persona.
  const number = (flag, fallback) => {
    if (!flags.has(flag)) return fallback;
    const value = Number(flags.get(flag));
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${flag} expects a positive number, got: ${flags.get(flag)}`);
    }
    return value;
  };

  return {
    url,
    out,
    waitMs: number('--wait', 600),
    width: number('--w', 1440),
    height: number('--h', 900),
    fullPage: flags.has('--full'),
  };
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`ui-capture: ${error.message}`);
  process.exit(2);
}

mkdirSync(dirname(options.out), { recursive: true });

// `channel: 'chrome'` drives the Chrome already on the machine; the default
// (no channel) uses Playwright's pinned Chromium build.
async function launch() {
  const forced = process.env.CAPTURE_CHANNEL;
  if (forced) return chromium.launch({ channel: forced === 'chromium' ? undefined : forced });
  try {
    return await chromium.launch();
  } catch (error) {
    if (!/Executable doesn't exist|please run.*install/is.test(String(error?.message))) throw error;
    console.warn("ui-capture: Playwright's Chromium is missing; falling back to system Chrome.");
    return chromium.launch({ channel: 'chrome' });
  }
}

const browser = await launch();
try {
  const page = await browser.newPage({
    viewport: { width: options.width, height: options.height },
  });
  // `networkidle` rather than `load`: these pages stream generated content in
  // after first paint, and a frame captured mid-stream is evidence of nothing.
  await page.goto(options.url, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(options.waitMs);
  await page.screenshot({ path: options.out, fullPage: options.fullPage });
  console.log(`saved ${options.out}`);
} finally {
  await browser.close();
}
