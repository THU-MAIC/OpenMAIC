import { parse, type BlockStatement, type Literal, type Node, type Program } from 'acorn';
import {
  analyzeHtmlAssetInventory,
  applySourcePatches,
  replaceAttributePatch,
  type HtmlTextElement,
  type SourcePatch,
} from '@/lib/export/html-asset-inventory';
import { toDataUri, type FetchAsset } from '@/lib/export/inline-assets-shared';

// Pyodide's core WebAssembly alone can exceed the regular 8 MiB asset limit.
export const MAX_VIDEO_CAPTURE_ASSET_BYTES = 12 * 1024 * 1024;
const PYODIDE_ENTRY =
  /^https:\/\/cdn\.jsdelivr\.net\/(?:pyodide\/v\d+\.\d+\.\d+\/full|npm\/pyodide@\d+\.\d+\.\d+)\/pyodide\.js$/;
const PYODIDE_BOOT_FILES = [
  ['pyodide.js', 'text/javascript'],
  ['pyodide.asm.js', 'text/javascript'],
  ['pyodide.asm.wasm', 'application/wasm'],
  ['python_stdlib.zip', 'application/zip'],
  ['pyodide-lock.json', 'application/json'],
] as const;

function scriptSourcesInBody(body: Program['body'] | BlockStatement['body']): Literal[] {
  const sources: Literal[] = [];
  for (let i = 0; i + 1 < body.length; i++) {
    const declaration = body[i];
    const statement = body[i + 1];
    if (
      declaration.type !== 'VariableDeclaration' ||
      declaration.declarations.length !== 1 ||
      statement.type !== 'ExpressionStatement' ||
      statement.expression.type !== 'AssignmentExpression'
    ) {
      continue;
    }
    const { id, init } = declaration.declarations[0];
    const { operator, left, right } = statement.expression;
    if (
      id.type === 'Identifier' &&
      init?.type === 'CallExpression' &&
      init.callee.type === 'MemberExpression' &&
      !init.callee.computed &&
      init.callee.object.type === 'Identifier' &&
      init.callee.object.name === 'document' &&
      init.callee.property.type === 'Identifier' &&
      init.callee.property.name === 'createElement' &&
      init.arguments[0]?.type === 'Literal' &&
      init.arguments[0].value === 'script' &&
      operator === '=' &&
      left.type === 'MemberExpression' &&
      !left.computed &&
      left.object.type === 'Identifier' &&
      left.object.name === id.name &&
      left.property.type === 'Identifier' &&
      left.property.name === 'src' &&
      right.type === 'Literal'
    ) {
      sources.push(right);
    }
  }
  return sources;
}

function dynamicScriptSources(script: HtmlTextElement): Literal[] {
  if (!script.content.includes('createElement')) return [];
  let tree: Program;
  try {
    tree = parse(script.content, {
      ecmaVersion: 'latest',
      sourceType: script.attributes.type?.trim().toLowerCase() === 'module' ? 'module' : 'script',
    });
  } catch {
    // The browser reports authoring errors during capture.
    return [];
  }

  const sources: Literal[] = [];
  const work: unknown[] = [tree];
  while (work.length) {
    const candidate = work.pop();
    if (Array.isArray(candidate)) {
      for (const child of candidate) work.push(child);
    } else if (candidate && typeof candidate === 'object' && 'type' in candidate) {
      const node = candidate as Node;
      if (node.type === 'Program' || node.type === 'BlockStatement') {
        sources.push(...scriptSourcesInBody((node as Program | BlockStatement).body));
      }
      for (const child of Object.values(node)) work.push(child);
    }
  }
  return sources;
}

async function inlinePyodide(url: string, fetcher: FetchAsset) {
  const files = await Promise.all(
    PYODIDE_BOOT_FILES.map(async ([filename, mime]) => ({
      filename,
      mime,
      asset: await fetcher(new URL(filename, url).href),
    })),
  );
  if (files.some(({ asset }) => !asset)) return;

  const upstreamRoot = new URL('.', url);
  const rootPath = upstreamRoot.pathname;
  const localRoot = 'https://openmaic.invalid' + rootPath;
  const payloadId = 'openmaic-pyodide:' + rootPath;
  const [entry, factory, ...dataFiles] = files;
  const embedded = Object.fromEntries(
    dataFiles.map(({ filename, mime, asset }) => {
      const dataUri = toDataUri(asset!.bytes, mime);
      return [localRoot + filename, [mime, dataUri.slice(dataUri.indexOf(',') + 1)]];
    }),
  );
  const decoder = new TextDecoder();
  // The source replacement runs the factory, entry, and shim together, keeping
  // the original script's execution timing and load handlers.
  const source = `
(function () {
  ${decoder.decode(factory.asset!.bytes)}
  ;
  ${decoder.decode(entry.asset!.bytes)}
  ;
  const files = JSON.parse(document.getElementById(${JSON.stringify(payloadId)}).textContent);
  const fetchOriginal = window.fetch.bind(window);
  const load = window.loadPyodide;
  window.fetch = function (input, options) {
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : input instanceof URL ? input.href : input;
    const method = (options?.method ?? request?.method ?? 'GET').toUpperCase();
    const originalRoot = ${JSON.stringify(upstreamRoot.href)};
    const key = typeof url === 'string' && url.startsWith(originalRoot)
      ? ${JSON.stringify(localRoot)} + url.slice(originalRoot.length)
      : url;
    if (method === 'GET' && typeof key === 'string' && Object.hasOwn(files, key)) {
      const [mime, base64] = files[key];
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return Promise.resolve(new Response(bytes, { headers: { 'Content-Type': mime } }));
    }
    return fetchOriginal(input, options);
  };
  window.loadPyodide = function (options) {
    return window.__openmaicWaitForStaticRuntime(
      load({ ...options, indexURL: ${JSON.stringify(localRoot)} })
    );
  };
})();`;
  const payload = `<script type="application/json" id="${payloadId}" data-openmaic-pyodide-runtime>${JSON.stringify(embedded)}</script>`;
  return { src: toDataUri(new TextEncoder().encode(source), 'text/javascript'), payload };
}

export async function prepareCaptureAssets(html: string, fetcher: FetchAsset): Promise<string> {
  const inventory = analyzeHtmlAssetInventory(html);
  const patches: SourcePatch[] = [];
  const runtimes = new Map<string, Awaited<ReturnType<typeof inlinePyodide>>>();
  for (const asset of inventory.attributeAssets) {
    if (!asset.elementRange) continue;
    if (asset.kind === 'link') {
      const relationships = asset.attributes.rel?.trim().toLowerCase().split(/\s+/) ?? [];
      if (
        relationships.length &&
        relationships.every((rel) => rel === 'preconnect' || rel === 'dns-prefetch')
      ) {
        patches.push({ range: asset.elementRange, replacement: '' });
      }
    } else if (
      asset.kind === 'script' &&
      asset.attributes.nomodule === undefined &&
      !asset.attributes.integrity?.trim() &&
      (!asset.attributes.type ||
        /^(?:application|text)\/(?:java|ecma)script$/i.test(asset.attributes.type.trim())) &&
      PYODIDE_ENTRY.test(asset.url)
    ) {
      if (!runtimes.has(asset.url)) {
        const runtime = await inlinePyodide(asset.url, fetcher);
        runtimes.set(asset.url, runtime);
        if (runtime) {
          const { start } = asset.elementRange;
          patches.push({ range: { start, end: start }, replacement: runtime.payload });
        }
      }
      const runtime = runtimes.get(asset.url);
      const patch = runtime && replaceAttributePatch(asset, runtime.src);
      if (patch) patches.push(patch);
    }
  }

  // Only transform a literal src assignment directly following its script
  // declaration in the same block. Computed URLs still follow the capture CSP.
  for (const script of [...inventory.classicScripts, ...inventory.moduleScripts]) {
    if (!script.contentRange || script.attributes.src !== undefined) continue;
    const start = script.contentRange.start;
    for (const source of dynamicScriptSources(script)) {
      const url = source.value;
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
      const asset = await fetcher(url);
      // The script may belong to an unneeded fallback branch. If it cannot be
      // fetched, let the capture's CSP and error handling govern actual use.
      if (!asset) continue;
      patches.push({
        range: { start: start + source.start, end: start + source.end },
        replacement: JSON.stringify(toDataUri(asset.bytes, asset.contentType)).replace(
          /</g,
          '\\u003c',
        ),
      });
    }
  }
  return applySourcePatches(html, patches);
}
