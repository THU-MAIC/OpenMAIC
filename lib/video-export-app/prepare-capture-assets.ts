import { parse, type AnyNode, type BlockStatement, type Literal, type Program } from 'acorn';
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
const PYODIDE_PAYLOAD_END = '}</script>';

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

function* scriptNodes(content: string, type?: string, isHandler = false): Generator<AnyNode> {
  let tree: Program;
  try {
    tree = parse(content, {
      ecmaVersion: 'latest',
      sourceType: type?.trim().toLowerCase() === 'module' ? 'module' : 'script',
      allowReturnOutsideFunction: isHandler,
    });
  } catch {
    // The browser reports authoring errors during capture.
    return;
  }

  const work: unknown[] = [tree];
  while (work.length) {
    const candidate = work.pop();
    if (Array.isArray(candidate)) {
      for (let index = candidate.length - 1; index >= 0; index--) work.push(candidate[index]);
    } else if (candidate && typeof candidate === 'object' && 'type' in candidate) {
      const node = candidate as AnyNode;
      yield node;
      for (const child of Object.values(node).reverse()) work.push(child);
    }
  }
}

function dynamicScriptSources(script: HtmlTextElement): Literal[] {
  if (!script.content.includes('createElement')) return [];
  const sources: Literal[] = [];
  for (const node of scriptNodes(script.content, script.attributes.type)) {
    if (node.type === 'Program' || node.type === 'BlockStatement') {
      sources.push(...scriptSourcesInBody(node.body));
    }
  }
  return sources;
}

function staticPropertyName(node: AnyNode, computed = false): string | undefined {
  if (!computed && node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
}

function callName(callee: AnyNode): string | undefined {
  return callee.type === 'MemberExpression'
    ? staticPropertyName(callee.property, callee.computed)
    : staticPropertyName(callee);
}

const INTERACTION_EVENT =
  /^(?:click|dblclick|contextmenu|input|change|submit|wheel|key(?:down|up|press)|(?:pointer|mouse|touch)(?:down|up|move|start|end|enter|leave|over|out|cancel)|drag(?:start|end|over|enter|leave)?|drop)$/i;

function interactionHandler(node: AnyNode): AnyNode | undefined {
  if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
    const property = staticPropertyName(node.left.property, node.left.computed);
    if (property?.startsWith('on') && INTERACTION_EVENT.test(property.slice(2))) return node.right;
  }
  if (node.type === 'CallExpression' && callName(node.callee) === 'addEventListener') {
    const event = node.arguments[0];
    if (
      event?.type === 'Literal' &&
      typeof event.value === 'string' &&
      INTERACTION_EVENT.test(event.value)
    ) {
      return node.arguments[1];
    }
  }
}

type PyodidePackageNames = { startup: Set<string>; interactions: Set<string> };

function addPyodidePackageNames(
  names: PyodidePackageNames,
  content: string,
  type?: string,
  isHandler = false,
): void {
  if (!content.includes('loadPackage') && !content.includes('loadPyodide')) return;
  const handlers: AnyNode[] = [];
  for (const node of scriptNodes(content, type, isHandler)) {
    const handler = interactionHandler(node);
    if (handler?.type === 'ArrowFunctionExpression' || handler?.type === 'FunctionExpression')
      handlers.push(handler);
    if (node.type !== 'CallExpression') continue;
    const name = callName(node.callee);
    let arg: (typeof node.arguments)[number] | undefined = node.arguments[0];
    if (name === 'loadPyodide' && arg?.type === 'ObjectExpression') {
      const packages = arg.properties.find(
        (property) =>
          property.type === 'Property' &&
          staticPropertyName(property.key, property.computed) === 'packages',
      );
      arg = packages?.type === 'Property' ? packages.value : undefined;
    } else if (name !== 'loadPackage') {
      continue;
    }
    // Give initialization packages first claim on the capture size budget.
    const namesForCall = handlers.some(({ start, end }) => node.start >= start && node.end <= end)
      ? names.interactions
      : names.startup;
    for (const value of arg?.type === 'ArrayExpression' ? arg.elements : [arg]) {
      if (
        value?.type === 'Literal' &&
        typeof value.value === 'string' &&
        /^[a-z0-9][\w.-]*$/i.test(value.value)
      ) {
        namesForCall.add(value.value);
      }
    }
  }
}

type PyodidePackage = { file_name: string; depends: string[]; sha256?: string };
type PyodideFile = {
  filename: string;
  mime: string;
  asset: Awaited<ReturnType<FetchAsset>>;
};

async function fetchPyodidePackageFiles(
  archiveRoot: URL,
  lockBytes: Uint8Array,
  requested: ReadonlySet<string>,
  fetcher: FetchAsset,
  remainingBytes: number,
): Promise<PyodideFile[]> {
  if (!requested.size) return [];
  const lockfile = JSON.parse(new TextDecoder().decode(lockBytes)) as {
    packages: Record<string, PyodidePackage>;
  };
  const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');
  const available = new Map(
    Object.entries(lockfile.packages).map(([name, pkg]) => [normalize(name), pkg]),
  );
  const pending = Array.from(requested, normalize).reverse();
  const visited = new Set<string>();
  const files = new Map<string, PyodideFile>();
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (visited.has(name)) continue;
    visited.add(name);
    const pkg = available.get(name);
    if (!pkg) continue;
    const { file_name: filename, depends, sha256 } = pkg;
    // Lock entries must stay in the versioned CDN directory for this distribution.
    if (typeof filename !== 'string' || !/^[a-z0-9][\w.-]*\.(?:whl|tar|zip)$/i.test(filename)) {
      continue;
    }
    for (let index = depends.length - 1; index >= 0; index--)
      pending.push(normalize(depends[index]));
    if (files.has(filename)) continue;
    const asset = await fetcher(new URL(filename, archiveRoot).href);
    // A static call may sit in a branch or click handler the capture never runs.
    if (!asset) continue;
    const size = 4 * Math.ceil(asset.bytes.length / 3);
    if (size > remainingBytes) continue;
    // The capture fetch shim serves a Response directly, so check the hash
    // here instead of relying on the browser to enforce fetch integrity.
    if (sha256) {
      const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(asset.bytes));
      const hex = Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      if (hex !== sha256) continue;
    }
    files.set(filename, { filename, mime: 'application/octet-stream', asset });
    remainingBytes -= size;
  }
  return [...files.values()];
}

async function inlinePyodide(
  url: string,
  fetcher: FetchAsset,
  requested: ReadonlySet<string>,
  maxHtmlBytes: number,
) {
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
  // The npm distribution contains the boot files but not the package archives.
  const npmVersion = /^\/npm\/pyodide@(\d+\.\d+\.\d+)\/$/.exec(rootPath)?.[1];
  const archiveRoot = npmVersion
    ? new URL(`/pyodide/v${npmVersion}/full/`, upstreamRoot)
    : upstreamRoot;
  const localRoot = 'https://openmaic.invalid' + rootPath;
  const payloadId = 'openmaic-pyodide:' + rootPath;
  const [entry, factory, wasm, stdlib, lockfile] = files;
  const bootSize = files.reduce(
    (size, { asset }) => size + 4 * Math.ceil(asset!.bytes.length / 3),
    0,
  );
  const archives = await fetchPyodidePackageFiles(
    archiveRoot,
    lockfile.asset!.bytes,
    requested,
    fetcher,
    maxHtmlBytes - bootSize,
  );
  function encodeFile({ filename, mime, asset }: PyodideFile): [string, [string, string]] {
    const dataUri = toDataUri(asset!.bytes, mime);
    return [localRoot + filename, [mime, dataUri.slice(dataUri.indexOf(',') + 1)]];
  }
  const embedded = Object.fromEntries([wasm, stdlib, lockfile].map(encodeFile));
  const archiveEntries = archives.map((archive) => {
    const [filename, data] = encodeFile(archive);
    return `,${JSON.stringify(filename)}:${JSON.stringify(data)}`;
  });
  const decoder = new TextDecoder();
  // The source replacement runs the factory, entry, and shim together, keeping
  // the original script's execution timing and load handlers.
  const source = `
(function () {
  ${decoder.decode(factory.asset!.bytes)}
  ;
  ${decoder.decode(entry.asset!.bytes)}
  ;
  const localRoot = ${JSON.stringify(localRoot)};
  const originalRoot = ${JSON.stringify(upstreamRoot.href)};
  const files = JSON.parse(document.getElementById(${JSON.stringify(payloadId)}).textContent);
  const fetchOriginal = window.fetch.bind(window);
  const load = window.loadPyodide;
  function decode(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  let packages;
  function loadWithEmbeddedPackages(names, start) {
    return window.__openmaicWaitForStaticRuntime(Promise.resolve().then(function () {
      const requested = typeof names === 'string' ? [names] : names;
      if (Array.isArray(requested) && requested.length) {
        const normalize = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');
        if (!packages) {
          const lock = JSON.parse(new TextDecoder().decode(decode(files[localRoot + 'pyodide-lock.json'][1])));
          packages = new Map(Object.entries(lock.packages).map(([name, pkg]) => [normalize(name), pkg]));
        }
        const pending = new Set(requested.filter((name) => typeof name === 'string').map(normalize));
        for (const name of pending) {
          const pkg = packages.get(name);
          if (!pkg) continue;
          if (!Object.hasOwn(files, localRoot + pkg.file_name)) {
            throw new Error('Pyodide package unavailable offline: ' + name);
          }
          for (const dependency of pkg.depends) pending.add(normalize(dependency));
        }
      }
      return start();
    }));
  }
  window.fetch = function (input, options) {
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : input instanceof URL ? input.href : input;
    const method = (options?.method ?? request?.method ?? 'GET').toUpperCase();
    const key = typeof url === 'string' && url.startsWith(originalRoot)
      ? localRoot + url.slice(originalRoot.length)
      : url;
    if (method === 'GET' && typeof key === 'string' && Object.hasOwn(files, key)) {
      const [mime, base64] = files[key];
      return Promise.resolve(new Response(decode(base64), { headers: { 'Content-Type': mime } }));
    }
    return fetchOriginal(input, options);
  };
  window.loadPyodide = function (options) {
    return loadWithEmbeddedPackages(options?.packages, async function () {
      const pyodide = await load({ ...options, indexURL: localRoot });
      if (typeof pyodide?.loadPackage === 'function') {
        const loadPackage = pyodide.loadPackage;
        pyodide.loadPackage = function (names, ...args) {
          // Keep Pyodide's own error reporting when the widget handles it.
          const checkedNames = typeof args[0]?.errorCallback === 'function' ? undefined : names;
          return loadWithEmbeddedPackages(checkedNames, () => loadPackage.call(this, names, ...args));
        };
      }
      return pyodide;
    });
  };
})();`;
  const payloadStart = `<script type="application/json" id="${payloadId}" data-openmaic-pyodide-runtime>${JSON.stringify(embedded).slice(0, -1)}`;
  return {
    src: toDataUri(new TextEncoder().encode(source), 'text/javascript'),
    payloadStart,
    archiveEntries,
  };
}

export async function prepareCaptureAssets(
  html: string,
  fetcher: FetchAsset,
  maxHtmlBytes: number,
) {
  const inventory = analyzeHtmlAssetInventory(html);
  const patches: SourcePatch[] = [];
  const scripts = [...inventory.classicScripts, ...inventory.moduleScripts];
  let requestedPackages: Set<string> | undefined;
  const runtimeSources = new Map<string, string | undefined>();
  const runtimeScripts = new Map<string, string>();
  const runtimePayloads = new Map<string, NonNullable<Awaited<ReturnType<typeof inlinePyodide>>>>();
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
      if (!runtimeSources.has(asset.url)) {
        if (!requestedPackages) {
          const names: PyodidePackageNames = { startup: new Set(), interactions: new Set() };
          for (const script of scripts) {
            const { src, nomodule, type } = script.attributes;
            if (
              src === undefined &&
              (nomodule === undefined || type?.trim().toLowerCase() === 'module')
            ) {
              addPyodidePackageNames(names, script.content, type);
            }
          }
          for (const { kind, attributes } of inventory.attributeAssets) {
            if (attributes.onload && !(kind === 'script' && attributes.nomodule !== undefined)) {
              addPyodidePackageNames(names, attributes.onload, undefined, true);
            }
          }
          requestedPackages = new Set([...names.startup, ...names.interactions]);
        }
        const runtime = await inlinePyodide(asset.url, fetcher, requestedPackages, maxHtmlBytes);
        let source: string | undefined;
        if (runtime) {
          // Keep the large runtime out of the HTML parsing and rewrite passes.
          const marker = `openmaic-capture-${crypto.randomUUID()}`;
          source = `data:text/javascript,${marker}`;
          const payload = `<!--${marker}-->`;
          runtimeScripts.set(source, runtime.src);
          runtimePayloads.set(payload, runtime);
          const { start } = asset.elementRange;
          patches.push({ range: { start, end: start }, replacement: payload });
        }
        runtimeSources.set(asset.url, source);
      }
      const source = runtimeSources.get(asset.url);
      const patch = source && replaceAttributePatch(asset, source);
      if (patch) patches.push(patch);
    }
  }

  // Only transform a literal src assignment directly following its script
  // declaration in the same block. Computed URLs still follow the capture CSP.
  for (const script of scripts) {
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
  return {
    html: applySourcePatches(html, patches),
    embedRuntimes(packaged: string) {
      if (!runtimePayloads.size) return packaged;
      for (const [marker, runtime] of runtimeScripts) {
        packaged = packaged.replaceAll(marker, () => runtime);
      }
      // Account for the exact processed HTML and the core payload before the
      // optional archives. The payload and its placeholders are ASCII.
      let remainingBytes = maxHtmlBytes - new TextEncoder().encode(packaged).byteLength;
      for (const [marker, { payloadStart }] of runtimePayloads) {
        remainingBytes -= payloadStart.length + PYODIDE_PAYLOAD_END.length - marker.length;
      }
      for (const [marker, { payloadStart, archiveEntries }] of runtimePayloads) {
        const included: string[] = [];
        for (const archive of archiveEntries) {
          if (archive.length > remainingBytes) continue;
          remainingBytes -= archive.length;
          included.push(archive);
        }
        packaged = packaged.replace(
          marker,
          () => payloadStart + included.join('') + PYODIDE_PAYLOAD_END,
        );
      }
      return packaged;
    },
  };
}
