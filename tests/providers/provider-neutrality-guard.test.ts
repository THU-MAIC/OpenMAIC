import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

interface RegistrySource {
  file: string;
  declarations: readonly string[];
}

interface VendorLeak {
  file: string;
  line: number;
  column: number;
  vendor: string;
  token: string;
}

interface AllowedLeak {
  file: string;
  vendor: string;
  token: string;
  count: number;
  reason: string;
}

interface AllowedVendorDebt {
  file: string;
  vendor: string;
  count: number;
  reason: string;
}

/** Catalogs and adapter registries are composition roots, so their keys are authoritative vocabulary. */
const REGISTRY_SOURCES: readonly RegistrySource[] = [
  { file: 'lib/ai/providers.ts', declarations: ['PROVIDERS'] },
  { file: 'lib/audio/constants.ts', declarations: ['TTS_PROVIDERS', 'ASR_PROVIDERS'] },
  { file: 'lib/media/image-providers.ts', declarations: ['IMAGE_PROVIDERS'] },
  { file: 'lib/media/video-providers.ts', declarations: ['VIDEO_PROVIDERS'] },
  { file: 'lib/web-search/constants.ts', declarations: ['WEB_SEARCH_PROVIDERS'] },
  { file: 'lib/pdf/constants.ts', declarations: ['PDF_PROVIDERS'] },
  {
    file: 'lib/document/extractors/manifest.ts',
    declarations: ['DOCUMENT_EXTRACTOR_MANIFEST', 'MEDIA_EXTRACTOR_MANIFEST'],
  },
  { file: 'lib/audio/voice-registration.ts', declarations: ['VOICE_REGISTRATION_ADAPTERS'] },
] as const;

const PACKAGE_EXPORT_SOURCES = [
  { file: 'packages/@openmaic/storage/package.json', prefix: './asset/', suffix: '-bytes' },
] as const;

/**
 * Explicit provider-neutral surface. Catalogs, composition roots, and modules below
 * `adapters/` or `providers/` are deliberately outside this list: those are the
 * places where concrete provider knowledge belongs.
 */
const PROVIDER_NEUTRAL_FILES = [
  // LLM stage routing and agent driver
  'lib/server/model-routes.ts',
  'lib/server/resolve-model.ts',
  'lib/server/provider-config.ts',
  // NOTE: lib/server/agent-runtime/agent-driver-model.ts is not on main yet.
  // Add it back here the moment the agent driver lands on main so the neutral
  // driver surface is guarded from day one.
  'lib/orchestration/ai-sdk-adapter.ts',
  // Capability routes
  'app/api/generate/tts/route.ts',
  'app/api/generate/voice/route.ts',
  'app/api/transcription/route.ts',
  'app/api/generate/image/route.ts',
  'app/api/generate/video/route.ts',
  'app/api/verify-image-provider/route.ts',
  'app/api/verify-video-provider/route.ts',
  'app/api/web-search/route.ts',
  'app/api/extract-document/route.ts',
  'app/api/parse-pdf/route.ts',
  'lib/audio/voice-registration-client.ts',
  'lib/web-search/index.ts',
  'lib/server/web-search-config.ts',
  // Registry-based document dispatch
  'lib/document/extractors/registry.ts',
  'lib/document/extractors/media-registry.ts',
  // Object-storage contract and dispatch. The lib/storage barrel and types
  // entry points were removed by the provider audit; client.ts is the
  // surviving module.
  'lib/storage/client.ts',
  'lib/persistence/asset-byte-store.ts',
  'lib/persistence/server-provider.ts',
] as const;

/**
 * Existing debt only. Entries match an exact scanner token and occurrence count;
 * another use of an already-allowed vendor therefore still fails the guard.
 */
const TEMPORARY_ALLOWLIST: readonly AllowedLeak[] = [
  {
    file: 'lib/server/resolve-model.ts',
    vendor: 'bedrock',
    token: "'bedrock'",
    count: 2,
    reason: 'Temporary: server-managed credential policy is still encoded in model resolution.',
  },
  {
    file: 'lib/server/resolve-model.ts',
    vendor: 'bedrock',
    token: "'Amazon Bedrock must be enabled by the server operator before it can be used.'",
    count: 1,
    reason: 'Temporary: the matching provider-specific policy error has not moved to an adapter.',
  },
  {
    file: 'app/api/generate/voice/route.ts',
    vendor: 'qwen',
    token: 'resolveQwenVoiceCloneModel',
    count: 2,
    reason: 'Temporary: clone-model resolution belongs on VoiceRegistrationAdapter.',
  },
  {
    file: 'app/api/generate/voice/route.ts',
    vendor: 'qwen',
    token: 'QwenVoiceCloneError',
    count: 2,
    reason: 'Temporary: provider error classification belongs on VoiceRegistrationAdapter.',
  },
  {
    file: 'app/api/generate/voice/route.ts',
    vendor: 'qwen',
    token: 'qwenVoiceCloneErrorMessage',
    count: 2,
    reason: 'Temporary: provider error presentation belongs on VoiceRegistrationAdapter.',
  },
  {
    file: 'app/api/generate/voice/route.ts',
    vendor: 'qwen',
    token: "'@/lib/audio/qwen-voice-clone'",
    count: 1,
    reason: 'Temporary: the neutral route still imports a concrete provider error module.',
  },
  {
    file: 'app/api/generate/voice/route.ts',
    vendor: 'qwen',
    token: "'qwen-tts'",
    count: 1,
    reason: 'Temporary: clone-model selection belongs on VoiceRegistrationAdapter.',
  },
  {
    file: 'app/api/generate/voice/route.ts',
    vendor: 'qwen',
    token: "'QWEN_VC_TIMEOUT'",
    count: 1,
    reason: 'Temporary: timeout errors need a provider-neutral route error code.',
  },
] as const;

function groupedDebt(
  file: string,
  reason: string,
  entries: readonly (readonly [vendor: string, count: number])[],
): AllowedVendorDebt[] {
  return entries.map(([vendor, count]) => ({ file, vendor, count, reason }));
}

/** Existing broad seams, pinned by file, derived vendor, and exact occurrence count. */
const TEMPORARY_VENDOR_DEBT: readonly AllowedVendorDebt[] = [
  ...groupedDebt(
    'lib/server/provider-config.ts',
    'Temporary: provider configuration is still a mixed catalog and resolver composition root.',
    [
      ['qwen', 20],
      ['openai', 23],
      ['azure', 6],
      ['atlascloud', 2],
      ['anthropic', 2],
      ['google', 2],
      ['deepseek', 2],
      ['kimi', 2],
      ['minimax', 13],
      ['glm', 4],
      ['siliconflow', 2],
      ['doubao', 6],
      ['openrouter', 2],
      ['grok', 6],
      ['tencent', 4],
      ['hunyuan', 3],
      ['xiaomi', 3],
      ['ollama', 3],
      ['lemonade', 12],
      ['bedrock', 29],
      ['voxcpm', 3],
      ['elevenlabs', 2],
      ['whisper', 1],
      ['funasr', 3],
      ['unpdf', 2],
      ['mineru', 5],
      ['seedream', 2],
      ['banana', 2],
      ['nano', 2],
      ['seedance', 2],
      ['kling', 2],
      ['veo', 2],
      ['happyhorse', 2],
      ['tavily', 7],
      ['bocha', 5],
      ['brave', 3],
      ['baidu', 5],
      ['claude', 5],
      ['searxng', 3],
      ['browser-native-tts', 2],
      ['browser-native', 3],
      ['comfyui', 2],
      ['alidocmind', 14],
    ],
  ),
  ...groupedDebt(
    'app/api/generate/tts/route.ts',
    'Temporary: TTS request preparation and error behavior have not moved behind adapters.',
    [
      ['qwen', 14],
      ['voxcpm', 12],
      ['browser-native-tts', 2],
      ['browser-native', 2],
    ],
  ),
  ...groupedDebt(
    'app/api/web-search/route.ts',
    'Temporary: web-search credentials and request options have not moved behind adapters.',
    [
      ['baidu', 9],
      ['claude', 8],
      ['tavily', 3],
      ['searxng', 5],
      ['bocha', 2],
      ['brave', 2],
      ['minimax', 2],
      ['doubao', 2],
    ],
  ),
  ...groupedDebt(
    'app/api/generate/voice/route.ts',
    'Temporary: local-only voice deletion status remains in the neutral route.',
    [['local', 3]],
  ),
  ...groupedDebt(
    'app/api/extract-document/route.ts',
    'Temporary: managed document-provider configuration and fallback policy remain in the route.',
    [
      ['alidocmind', 6],
      ['mineru', 15],
      ['ffmpeg', 2],
      ['local', 2],
    ],
  ),
  ...groupedDebt(
    'app/api/generate/voice/route.ts',
    'Temporary: local-profile deletion semantics have not moved behind the registration adapter.',
    [['local', 3]],
  ),
  ...groupedDebt(
    'lib/document/extractors/media-registry.ts',
    'Temporary: the media-extractor fallback chain still names concrete providers in registry and operator guidance.',
    [
      ['local', 4],
      ['ffmpeg', 1],
      ['alidocmind', 1],
    ],
  ),
  ...groupedDebt(
    'app/api/parse-pdf/route.ts',
    'Temporary: the legacy PDF route retains a concrete local default.',
    [['unpdf', 1]],
  ),
  ...groupedDebt(
    'lib/web-search/index.ts',
    'Temporary: web-search execution still uses a central provider switch.',
    [
      ['baidu', 9],
      ['bocha', 4],
      ['brave', 4],
      ['claude', 7],
      ['doubao', 4],
      ['minimax', 4],
      ['searxng', 4],
      ['tavily', 4],
    ],
  ),
  ...groupedDebt(
    'lib/server/web-search-config.ts',
    'Temporary: web-search URL and option validation are still provider-specific.',
    [
      ['baidu', 11],
      ['tavily', 3],
      ['bocha', 7],
      ['brave', 4],
      ['claude', 5],
      ['anthropic', 2],
      ['minimax', 9],
      ['doubao', 1],
      ['searxng', 2],
    ],
  ),
  ...groupedDebt(
    'lib/persistence/asset-byte-store.ts',
    'Temporary: asset-byte-store selection still switches between concrete storage implementations.',
    [
      ['pg', 12],
      ['s3', 16],
    ],
  ),
  ...groupedDebt(
    'lib/persistence/server-provider.ts',
    'Temporary: server persistence composition still imports concrete storage implementations.',
    [
      ['pg', 13],
      ['s3', 1],
    ],
  ),
] as const;

const GENERIC_ID_PARTS = new Set([
  'api',
  'asr',
  'browser',
  'cloud',
  'custom',
  'document',
  'image',
  'media',
  'native',
  'pdf',
  'plain',
  'search',
  'text',
  'tts',
  'video',
]);

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function registryIds(source: string, declarations: readonly string[]): string[] {
  const sourceFile = ts.createSourceFile('registry.ts', source, ts.ScriptTarget.Latest, true);
  const wanted = new Set(declarations);
  const found = new Set<string>();
  const ids: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      wanted.has(node.name.text) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      found.add(node.name.text);
      for (const property of node.initializer.properties) {
        if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
          const id = propertyNameText(property.name);
          if (id) ids.push(id.toLowerCase());
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const declaration of declarations) {
    if (!found.has(declaration)) {
      throw new Error(
        `Provider vocabulary source is missing object-literal declaration ${declaration}`,
      );
    }
  }
  return ids;
}

function deriveVendorVocabulary(readSource: (file: string) => string): string[] {
  const providerIds = REGISTRY_SOURCES.flatMap(({ file, declarations }) =>
    registryIds(readSource(file), declarations),
  );
  for (const { file, prefix, suffix } of PACKAGE_EXPORT_SOURCES) {
    const exports = JSON.parse(readSource(file)).exports as Record<string, unknown>;
    for (const key of Object.keys(exports)) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        providerIds.push(key.slice(prefix.length, -suffix.length));
      }
    }
  }
  const terms = new Set<string>();

  for (const providerId of providerIds) {
    const distinctiveParts = providerId
      .split(/[^a-z0-9]+/u)
      .filter((part) => part.length >= 3 && !GENERIC_ID_PARTS.has(part));
    if (distinctiveParts.length === 0) terms.add(providerId);
    else for (const part of distinctiveParts) terms.add(part);
  }

  return [...terms].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function findVendorLeaks(file: string, source: string, vendors: readonly string[]): VendorLeak[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const leaks: VendorLeak[] = [];

  const inspect = (node: ts.Node): void => {
    if (
      !ts.isIdentifier(node) &&
      !ts.isStringLiteralLike(node) &&
      !ts.isTemplateHead(node) &&
      !ts.isTemplateMiddle(node) &&
      !ts.isTemplateTail(node)
    ) {
      ts.forEachChild(node, inspect);
      return;
    }

    const token = node.getText(sourceFile);
    const normalized = token.toLowerCase();
    for (const vendor of vendors) {
      if (!normalized.includes(vendor)) continue;
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      leaks.push({
        file,
        line: position.line + 1,
        column: position.character + 1,
        vendor,
        token,
      });
    }
  };
  inspect(sourceFile);
  return leaks;
}

function leakFingerprint(leak: Pick<VendorLeak, 'file' | 'vendor' | 'token'>): string {
  return JSON.stringify([leak.file, leak.vendor, leak.token]);
}

function unexpectedLeaks(
  leaks: readonly VendorLeak[],
  allowlist: readonly AllowedLeak[],
  vendorDebt: readonly AllowedVendorDebt[],
): VendorLeak[] {
  const remaining = new Map<string, number>();
  for (const allowed of allowlist) {
    remaining.set(leakFingerprint(allowed), allowed.count);
  }
  const remainingDebt = new Map<string, number>();
  for (const allowed of vendorDebt) {
    remainingDebt.set(JSON.stringify([allowed.file, allowed.vendor]), allowed.count);
  }

  const unexpected: VendorLeak[] = [];
  for (const leak of leaks) {
    const key = leakFingerprint(leak);
    const allowance = remaining.get(key) ?? 0;
    if (allowance > 0) remaining.set(key, allowance - 1);
    else {
      const debtKey = JSON.stringify([leak.file, leak.vendor]);
      const debtAllowance = remainingDebt.get(debtKey) ?? 0;
      if (debtAllowance > 0) remainingDebt.set(debtKey, debtAllowance - 1);
      else unexpected.push(leak);
    }
  }

  for (const allowed of allowlist) {
    const unused = remaining.get(leakFingerprint(allowed)) ?? 0;
    if (unused > 0) {
      throw new Error(
        `Stale provider-neutral allowlist entry in ${allowed.file}: ${allowed.vendor} / ${allowed.token}. Remove it now that the leak is gone.`,
      );
    }
  }
  for (const allowed of vendorDebt) {
    const unused = remainingDebt.get(JSON.stringify([allowed.file, allowed.vendor])) ?? 0;
    if (unused > 0) {
      throw new Error(
        `Stale provider-neutral debt entry in ${allowed.file}: ${allowed.vendor}. Remove or reduce it now that ${unused} occurrence(s) are gone.`,
      );
    }
  }
  return unexpected;
}

function failureMessage(leaks: readonly VendorLeak[]): string {
  return leaks
    .map(
      ({ file, line, column, vendor, token }) =>
        `${file}:${line}:${column} contains vendor token "${vendor}" in ${JSON.stringify(token)}. ` +
        'Move vendor behavior into an adapter, or add a provider-neutral contract method.',
    )
    .join('\n');
}

describe('provider-neutral layer guard', () => {
  const readSource = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
  const vendors = deriveVendorVocabulary(readSource);

  it('derives vendor terms from every declared registry source', () => {
    expect(vendors).toContain('qwen');
    expect(vendors).toContain('openai');
    expect(vendors).toContain('alidocmind');
  });

  it('keeps the declared provider-neutral surface free of new vendor knowledge', () => {
    const leaks = PROVIDER_NEUTRAL_FILES.flatMap((file) =>
      findVendorLeaks(file, readSource(file), vendors),
    );
    const unexpected = unexpectedLeaks(leaks, TEMPORARY_ALLOWLIST, TEMPORARY_VENDOR_DEBT);
    expect(unexpected, failureMessage(unexpected)).toEqual([]);
  });

  it('takes the red path for an injected vendor leak', () => {
    const fixture = `export function resolveProvider(id: string) {
  return id === 'qwen-tts' ? resolveQwenModel() : resolveModel(id);
}`;
    const leaks = findVendorLeaks('fixtures/injected-neutral-route.ts', fixture, vendors);
    expect(leaks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'fixtures/injected-neutral-route.ts',
          vendor: 'qwen',
          token: "'qwen-tts'",
        }),
      ]),
    );
    const message = failureMessage(leaks);
    expect(message).toContain('fixtures/injected-neutral-route.ts:2');
    expect(message).toContain('vendor token "qwen"');
    expect(message).toContain(
      'Move vendor behavior into an adapter, or add a provider-neutral contract method.',
    );
  });
});
