// Run with node --import tsx so callbacks come from the production transform.
// The parent test process hosts the listener; this process only drives Chromium.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createFileServer } from '@hyperframes/producer';
import {
  ChromiumPreviewRenderer,
  buildPreviewHtml,
  installPreviewRequestGuard,
} from '../src/preview-renderer.ts';
import { hardenProjectDirectory } from '../src/project-html-hardening.ts';

const scenario = process.argv[2];
const httpUrl = process.env.CSP_TEST_HTTP_URL;
const wsUrl = process.env.CSP_TEST_WS_URL;
const executable =
  process.env.PRODUCER_HEADLESS_SHELL_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;

assert.ok(scenario, 'scenario argument is required');
assert.ok(httpUrl, 'CSP_TEST_HTTP_URL is required');
assert.ok(wsUrl, 'CSP_TEST_WS_URL is required');
assert.ok(executable, 'a Chromium executable is required');

// A 4x4 opaque red PNG, so a project-relative <img> has real bytes to load.
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR4nGP8z8Dwn4EIwESMokGtCAAx0wH1kq9nYwAAAABJRU5ErkJggg==',
  'base64',
);

const ATTACKER_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src * \'unsafe-inline\' \'unsafe-eval\'; connect-src *; img-src *; frame-src *">';

function launchBrowser() {
  return puppeteer.launch({
    executablePath: executable,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

/** Every network vector a malicious scene could use from inside the iframe. */
function payload({ navigation }) {
  const navigationBody = navigation
    ? `setTimeout(function () { try { location.href = ${JSON.stringify(`${httpUrl}/nav`)}; } catch (error) {} }, 50);`
    : '';
  return `
    try { fetch(${JSON.stringify(`${httpUrl}/fetch`)}, { mode: 'no-cors' }); } catch (error) {}
    try { var xhr = new XMLHttpRequest(); xhr.open('GET', ${JSON.stringify(`${httpUrl}/xhr`)}); xhr.send(); } catch (error) {}
    try { new WebSocket(${JSON.stringify(`${wsUrl}/ws`)}); } catch (error) {}
    try { var image = new Image(); image.src = ${JSON.stringify(`${httpUrl}/img`)}; document.body.appendChild(image); } catch (error) {}
    try { var frame = document.createElement('iframe'); frame.src = ${JSON.stringify(`${httpUrl}/frame`)}; document.body.appendChild(frame); } catch (error) {}
    window.__payloadRan = true;
    ${navigationBody}
  `;
}

function interactiveScene(html) {
  return {
    id: 'csp-boundary',
    stageId: 'stage',
    order: 1,
    title: 'CSP boundary',
    type: 'interactive',
    content: { type: 'interactive', html },
    actions: [],
  };
}

const viewport = { width: 640, height: 360, deviceScaleFactor: 1 };

function sceneHtml(placement, withAttackerMeta, navigation) {
  const script = `<script>${payload({ navigation })}</script>`;
  const attacker = withAttackerMeta ? ATTACKER_META : '';
  return placement === 'before-head'
    ? `<!doctype html>${attacker}${script}<html><head></head><body></body></html>`
    : `<!doctype html><html><head>${attacker}</head><body>${script}</body></html>`;
}

/**
 * Drive the real preview document (`buildPreviewHtml`) and the real request
 * guard without the renderer's post-load frame waits. A blocked `location.href`
 * navigation still replaces the frame with Chrome's error page, which is the
 * correct security outcome but destroys the frame context the renderer would
 * otherwise wait on, so this path asserts the network boundary directly.
 */
async function runPreviewDirect(placement, withAttackerMeta, leadingBytes = '') {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    await installPreviewRequestGuard(page);
    const html = buildPreviewHtml(
      interactiveScene(leadingBytes + sceneHtml(placement, withAttackerMeta, true)),
      { id: 'stage', name: 'Course' },
      viewport,
    );
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  } finally {
    await browser.close();
  }
}

/** Exercise the complete renderer path with a payload that does not navigate. */
async function runPreviewFullPath() {
  const renderer = new ChromiumPreviewRenderer();
  const png = await renderer.render({
    scene: interactiveScene(sceneHtml('after-head', false, false)),
    stage: { id: 'stage', name: 'Course' },
    viewport,
    signal: AbortSignal.timeout(30_000),
    deadlineMs: 30_000,
  });
  assert.ok(png.byteLength > 0, 'preview render returned no PNG');
}

/** Negative control: no injected policy and no request guard. */
async function runPreviewBypass() {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<!doctype html><html><head></head><body><script>${payload({ navigation: true })}</script></body></html>`,
      { waitUntil: 'domcontentloaded' },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  } finally {
    await browser.close();
  }
}

async function writeRenderProject(dir, { legit, harden }) {
  if (legit) {
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(
      join(dir, 'index.html'),
      `<!doctype html>
<html lang="en"><head><style>body{margin:0;background:#102030}#shape{position:absolute;left:40px;top:40px;width:240px;height:160px;background:#e11d48}</style>
<script src="assets/app.js"></script></head>
<body><div id="root" style="position:relative;width:640px;height:360px;background:#203040">
<div id="shape"></div><img id="pixel" src="assets/pixel.png" width="8" height="8" style="position:absolute;left:300px;top:40px">
<iframe id="scene" src="assets/scene.html" style="position:absolute;left:300px;top:120px;width:160px;height:120px;border:0"></iframe>
<script>window.__inlineOk = true;</script></div></body></html>`,
    );
    await writeFile(join(dir, 'assets', 'app.js'), 'window.__appScriptLoaded = true;\n');
    await writeFile(join(dir, 'assets', 'pixel.png'), PIXEL_PNG);
    await writeFile(
      join(dir, 'assets', 'scene.html'),
      '<!doctype html><html><head><style>html,body{margin:0;background:#22c55e}</style></head><body><div id="scene">scene</div><script>window.__sceneOk = true;</script></body></html>',
    );
  } else {
    await writeFile(
      join(dir, 'index.html'),
      `<!doctype html><html><head><style>body{margin:0;background:#203040}</style></head><body><script>${payload({ navigation: false })}</script></body></html>`,
    );
  }
  if (harden) await hardenProjectDirectory(dir);
}

/** A project whose `index.html` or nested scene starts with NBSP before the doctype. */
async function writeRenderPrefixProject(dir, target) {
  await mkdir(join(dir, 'assets'), { recursive: true });
  const payloadDocument = `<!doctype html><html><head><style>html,body{margin:0;background:#22c55e}</style></head><body><script>${payload({ navigation: false })}</script></body></html>`;
  if (target === 'index') {
    await writeFile(join(dir, 'index.html'), `\u00a0${payloadDocument}`);
    return;
  }
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><html><head><style>html,body{margin:0;background:#203040}</style></head><body><iframe id="scene" src="assets/scene.html" style="width:640px;height:360px;border:0"></iframe></body></html>',
  );
  await writeFile(join(dir, 'assets', 'scene.html'), `\u00a0${payloadDocument}`);
}

/** A project whose hardened `index.html` frames an SVG attack document. */
async function writeRenderSvgProject(dir) {
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><html><head><style>html,body{margin:0;background:#203040}</style></head><body><iframe id="svg" src="assets/x.svg" width="320" height="180" style="border:0"></iframe></body></html>',
  );
  await writeFile(
    join(dir, 'assets', 'x.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="320" height="180">
      <script>${payload({ navigation: false })}</script>
      <foreignObject width="100" height="100"><iframe xmlns="http://www.w3.org/1999/xhtml" src="${httpUrl}/svg-foreign" width="100" height="100"></iframe></foreignObject>
      <a xlink:href="javascript:fetch('${httpUrl}/svg-js-href')"><text x="2" y="12">x</text></a>
    </svg>`,
  );
}

/** A project whose hardened `index.html` frames an XHTML attack document. */
async function writeRenderXhtmlProject(dir) {
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><html><head><style>html,body{margin:0;background:#203040}</style></head><body><iframe id="x" src="assets/x.xhtml" width="320" height="180" style="border:0"></iframe></body></html>',
  );
  await writeFile(
    join(dir, 'assets', 'x.xhtml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>attack</title></head>
<body><script>${payload({ navigation: false })}</script></body></html>`,
  );
}

/** A project whose hardened index submits GET and POST forms to the listener. */
async function writeRenderFormProject(dir) {
  await writeFile(
    join(dir, 'index.html'),
    `<!doctype html><html><head><style>body{margin:0;background:#203040}</style></head><body>
    <form id="get" method="get" action="${httpUrl}/form-get"><input name="q" value="1"></form>
    <form id="post" method="post" action="${httpUrl}/form-post"><input name="q" value="1"></form>
    <script>document.getElementById('get').submit(); document.getElementById('post').submit();</script>
    </body></html>`,
  );
}

async function startProjectServer(dir) {
  return createFileServer({
    projectDir: dir,
    port: 0,
    preHeadScripts: [],
    headScripts: [],
    bodyScripts: [],
  });
}

/**
 * Serve the project the way the producer would if its MIME map ever listed
 * `.xhtml`: `.html` becomes text/html and `.xhtml` becomes application/xhtml+xml,
 * so the framed document is actually a scriptable XHTML document.
 */
async function startXhtmlServer(dir) {
  const server = createServer(async (request, response) => {
    const requestPath = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
    const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\//, '');
    const filePath = join(dir, relative);
    if (!filePath.startsWith(dir)) {
      response.writeHead(403).end();
      return;
    }
    let data;
    try {
      data = await readFile(filePath);
    } catch {
      response.writeHead(404).end();
      return;
    }
    const type =
      extname(filePath).toLowerCase() === '.xhtml'
        ? 'application/xhtml+xml'
        : 'text/html; charset=utf-8';
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': data.byteLength });
    response.end(data);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function loadAndWait(url, { evaluate } = {}) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return evaluate ? await page.evaluate(evaluate) : undefined;
  } finally {
    await browser.close();
  }
}

async function runRenderPayload(harden) {
  const dir = await mkdtemp(join(tmpdir(), 'openmaic-csp-render-'));
  try {
    await writeRenderProject(dir, { legit: false, harden });
    const server = await startProjectServer(dir);
    try {
      await loadAndWait(`${server.url.replace('localhost', '127.0.0.1')}/index.html`);
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runRenderPrefix(target) {
  const dir = await mkdtemp(join(tmpdir(), 'openmaic-csp-prefix-'));
  try {
    await writeRenderPrefixProject(dir, target);
    await hardenProjectDirectory(dir);
    const server = await startProjectServer(dir);
    try {
      await loadAndWait(`${server.url.replace('localhost', '127.0.0.1')}/index.html`);
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runRenderSvgProject({ sanitize }) {
  const dir = await mkdtemp(join(tmpdir(), 'openmaic-csp-svg-'));
  try {
    await writeRenderSvgProject(dir);
    if (sanitize) await hardenProjectDirectory(dir);
    const server = await startProjectServer(dir);
    try {
      await loadAndWait(`${server.url.replace('localhost', '127.0.0.1')}/index.html`);
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runRenderXhtmlProject({ sanitize }) {
  const dir = await mkdtemp(join(tmpdir(), 'openmaic-csp-xhtml-'));
  try {
    await writeRenderXhtmlProject(dir);
    if (sanitize) await hardenProjectDirectory(dir);
    const server = await startXhtmlServer(dir);
    try {
      await loadAndWait(`${server.url}/index.html`);
    } finally {
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runRenderFormProject() {
  const dir = await mkdtemp(join(tmpdir(), 'openmaic-csp-form-'));
  try {
    await writeRenderFormProject(dir);
    await hardenProjectDirectory(dir);
    const server = await startProjectServer(dir);
    try {
      await loadAndWait(`${server.url.replace('localhost', '127.0.0.1')}/index.html`);
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runRenderLegit() {
  const dir = await mkdtemp(join(tmpdir(), 'openmaic-csp-legit-'));
  try {
    await writeRenderProject(dir, { legit: true, harden: true });
    const server = await startProjectServer(dir);
    try {
      return await loadAndWait(`${server.url.replace('localhost', '127.0.0.1')}/index.html`, {
        evaluate: () => {
          const shape = document.getElementById('shape');
          const pixel = document.getElementById('pixel');
          const frame = document.getElementById('scene');
          let sceneOk = null;
          let sceneText = null;
          let sceneBackground = null;
          try {
            sceneOk = frame.contentWindow.__sceneOk === true;
            sceneText = frame.contentDocument.getElementById('scene').textContent.trim();
            sceneBackground = frame.contentWindow.getComputedStyle(
              frame.contentDocument.body,
            ).backgroundColor;
          } catch (error) {
            sceneText = `ERR:${error.message}`;
          }
          return {
            appScriptLoaded: window.__appScriptLoaded === true,
            inlineOk: window.__inlineOk === true,
            shapeBackground: getComputedStyle(shape).backgroundColor,
            shapeWidth: shape.getBoundingClientRect().width,
            pixelLoaded: pixel.naturalWidth > 0,
            sceneOk,
            sceneText,
            sceneBackground,
          };
        },
      });
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let result;
switch (scenario) {
  case 'preview-after-head':
    await runPreviewDirect('after-head', false);
    result = { ok: true };
    break;
  case 'preview-before-head':
    await runPreviewDirect('before-head', false);
    result = { ok: true };
    break;
  case 'preview-attacker-meta':
    await runPreviewDirect('after-head', true);
    result = { ok: true };
    break;
  case 'preview-prefix-nbsp':
    await runPreviewDirect('after-head', false, '\u00a0');
    result = { ok: true };
    break;
  case 'preview-prefix-bom':
    await runPreviewDirect('after-head', false, '\uFEFF');
    result = { ok: true };
    break;
  case 'preview-prefix-2bom':
    await runPreviewDirect('after-head', false, '\uFEFF\uFEFF');
    result = { ok: true };
    break;
  case 'preview-prefix-ideographic':
    await runPreviewDirect('after-head', false, '\u3000');
    result = { ok: true };
    break;
  case 'preview-full-path':
    await runPreviewFullPath();
    result = { ok: true };
    break;
  case 'preview-bypass':
    await runPreviewBypass();
    result = { ok: true };
    break;
  case 'render-payload':
    await runRenderPayload(true);
    result = { ok: true };
    break;
  case 'render-bypass':
    await runRenderPayload(false);
    result = { ok: true };
    break;
  case 'render-prefix-nbsp-index':
    await runRenderPrefix('index');
    result = { ok: true };
    break;
  case 'render-prefix-nbsp-scene':
    await runRenderPrefix('scene');
    result = { ok: true };
    break;
  case 'render-svg':
    await runRenderSvgProject({ sanitize: true });
    result = { ok: true };
    break;
  case 'render-svg-bypass':
    await runRenderSvgProject({ sanitize: false });
    result = { ok: true };
    break;
  case 'render-xhtml':
    await runRenderXhtmlProject({ sanitize: true });
    result = { ok: true };
    break;
  case 'render-xhtml-bypass':
    await runRenderXhtmlProject({ sanitize: false });
    result = { ok: true };
    break;
  case 'render-form':
    await runRenderFormProject();
    result = { ok: true };
    break;
  case 'render-legit':
    result = { ok: true, scene: await runRenderLegit() };
    break;
  default:
    throw new Error(`Unknown scenario: ${scenario}`);
}

console.log(JSON.stringify(result));
