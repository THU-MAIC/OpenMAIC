/**
 * The provider prompt prefix must survive a material change (issue #1858).
 *
 * The system prompt is the head of every request. It stays byte-identical
 * when the set changes. Stored transcripts are sent as stored: a later
 * request's provider messages extend the earlier ones, and a tool receipt
 * is not glued to a materials listing.
 */
import type { Message as PiMessage } from '@earendil-works/pi-ai';
import type { AgentSessionMaterial } from '@openmaic/storage';
import { describe, expect, it, vi } from 'vitest';

import { toModelMessages } from '@/lib/agent/runtime/stream-fn';
import type { OwnerMaterialEntry } from '@/lib/persistence/session-material-links';
import { buildFetchUrlTool, type ExtractedWebPage } from '@/lib/server/agent-runtime/fetch-url';
import { materialsPromptBlock } from '@/lib/server/agent-runtime/material-prompt';
import type { ResolvedMaterial } from '@/lib/server/agent-runtime/material-resolver';
import { buildRunnerCoursePrompt } from '@/lib/server/agent-runtime/runner-contract';
import { composeFollowUpText } from '@/lib/server/agent-runtime/runner';

function sessionRow(overrides: Partial<AgentSessionMaterial>): ResolvedMaterial {
  return {
    origin: 'session',
    record: {
      id: 'mat_web',
      sessionId: 'ses_1',
      kind: 'web',
      title: 'Fetched page',
      sourceUrl: 'https://example.com/a',
      textAssetId: 'materials/ses_1/mat_web/text.md',
      rawAssetId: null,
      textChars: 42,
      derivedFrom: null,
      extraction: { status: 'done', attempts: 0 },
      createdAt: new Date(0).toISOString(),
      ...overrides,
    },
  };
}

function ownerSource(
  status: 'idle' | 'running' | 'done',
  overrides: Partial<OwnerMaterialEntry> = {},
): ResolvedMaterial {
  return {
    origin: 'owner',
    entry: {
      id: 'src_lesson',
      ownerId: 'user:alice',
      kind: 'source',
      derivedFrom: null,
      mime: 'application/pdf',
      bytes: 3,
      originalName: 'lesson.pdf',
      ossKey: 'objects/secret-key',
      assetId: 'ast_secret_pool',
      sha256: 'digest',
      status: 'ready',
      extraction: { status },
      createdAt: 0,
      deletedAt: null,
      folderId: null,
      displayName: null,
      extractionError: null,
      extractionResult: null,
      lineage: null,
      ...overrides,
    },
  };
}

const materialSets: Record<string, readonly ResolvedMaterial[]> = {
  none: [],
  attached: [
    sessionRow({ id: 'mat_pdf', kind: 'source', title: 'lecture.pdf', textAssetId: null }),
  ],
  web: [sessionRow({})],
  extractionIdle: [ownerSource('idle')],
  extractionDone: [ownerSource('done', { originalName: 'lesson.pdf' })],
  pptx: [
    sessionRow({
      id: 'mat_ppt',
      kind: 'source',
      title: 'deck.pptx',
      textAssetId: null,
      extraction: { status: 'idle', attempts: 0 },
    }),
  ],
};

/** The runner's system prompt for one resolved set. Other blocks stay fixed. */
function systemPrompt(materials: readonly ResolvedMaterial[]): string {
  return buildRunnerCoursePrompt({
    curriculum: 'curriculum-block',
    untrustedContent: 'untrusted-block',
    materials: materialsPromptBlock(materials),
    roster: 'roster-block',
    voice: 'voice-block',
  });
}

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string): PiMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 } as PiMessage;
}

/** A preload turn: user, then assistant `read`, then the SKILL.md body. */
function preloadTranscript(skillBody: string): PiMessage[] {
  return [
    user('Build a lesson'),
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'read-skill',
          name: 'read',
          arguments: { path: 'skills/pptx-import/SKILL.md', limit: 2 },
        },
      ],
      api: 'openai-completions',
      provider: 'openai',
      model: 'test',
      usage,
      stopReason: 'toolUse',
      timestamp: 2,
    } as PiMessage,
    {
      role: 'toolResult',
      toolCallId: 'read-skill',
      toolName: 'read',
      content: [{ type: 'text', text: skillBody }],
      isError: false,
      timestamp: 3,
    } as PiMessage,
  ];
}

function providerRequest(materials: readonly ResolvedMaterial[], transcript: PiMessage[]) {
  return {
    system: systemPrompt(materials),
    messages: toModelMessages(transcript),
  };
}

function toolReceipt(messages: ReturnType<typeof toModelMessages>): string {
  const tool = messages.find((message) => message.role === 'tool');
  const content = (tool as { content: Array<{ output: { value: string } }> }).content;
  return content[0]!.output.value;
}

describe('system prompt prefix cache', () => {
  it('keeps the system prompt byte-identical when the material set changes', () => {
    const baseline = systemPrompt(materialSets.none!);
    for (const [name, materials] of Object.entries(materialSets)) {
      expect(systemPrompt(materials), name).toBe(baseline);
    }
    expect(systemPrompt(materialSets.extractionIdle!)).toBe(
      systemPrompt(materialSets.extractionDone!),
    );
  });

  it('names nothing from the set and still points at list_materials and the knowledge base', () => {
    const prompt = systemPrompt(materialSets.none!);
    expect(prompt).toContain('## Materials and the knowledge base');
    expect(prompt).toContain('`list_materials` lists what this conversation has');
    expect(prompt).toContain("scope: 'library'");
    expect(prompt).toContain(
      'call `extract_material` with its id, then `wait_for_materials`, then `read_material` with the same id',
    );
    expect(prompt).toContain('Read a `web` material directly');
    expect(prompt).toContain('read through the `extraction` material');
    expect(prompt).toContain('import_pptx');
    expect(prompt).toContain('layout-preserving');
    expect(prompt).not.toContain('Nothing is attached');
    expect(prompt).not.toContain('Attached to this conversation');
    expect(prompt).not.toContain('was already fetched');
    for (const leaked of [
      'Fetched page',
      'lecture.pdf',
      'lesson.pdf',
      'deck.pptx',
      'mat_web',
      'mat_pdf',
      'src_lesson',
      'extraction idle',
      'extraction running',
      'extraction done',
      'secret',
      'ast_secret',
    ]) {
      expect(prompt, leaked).not.toContain(leaked);
    }
  });

  it('leaves discovery to list_materials, the attachment note, and the fetch_url result', async () => {
    const prompt = systemPrompt([
      ownerSource('running', { originalName: 'lesson.pdf', id: 'src_lesson' }),
      sessionRow({ title: 'Fetched page', id: 'mat_web' }),
    ]);
    expect(prompt).not.toContain('lesson.pdf');
    expect(prompt).not.toContain('Fetched page');
    expect(prompt).not.toContain('src_lesson');
    expect(prompt).not.toContain('mat_web');
    expect(prompt).toContain('`list_materials` lists what this conversation has');

    const followUp = composeFollowUpText({
      text: 'Use this recording',
      materials: [
        {
          materialId: 'src_lesson',
          originalName: 'lesson.pdf',
          mime: 'application/pdf',
          bytes: 3,
        },
      ],
    });
    expect(followUp).toContain('"lesson.pdf" (application/pdf, 3 bytes)');
    expect(followUp).toContain('use use_material_media');
    expect(followUp).not.toContain('objects/secret-key');

    const page: ExtractedWebPage = {
      sourceUrl: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      title: 'Fetched page',
      markdown: 'page body',
      fetchedAt: '2026-08-16T08:00:00.000Z',
      contentType: 'text/html',
      truncated: false,
      downloadedBytes: 9,
    };
    const fetchUrl = buildFetchUrlTool({
      sessionId: 'ses_1',
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      fetchUrl: vi.fn().mockResolvedValue(page),
      saveWebMaterial: vi.fn().mockResolvedValue({
        id: 'mat_web',
        sessionId: 'ses_1',
        kind: 'web',
        title: 'Fetched page',
        sourceUrl: page.finalUrl,
        textAssetId: 'ast_text',
        rawAssetId: null,
        textChars: page.markdown.length,
        createdAt: page.fetchedAt,
      }),
    });
    const result = await fetchUrl.execute('call_1', { url: page.finalUrl } as never, undefined);
    const receipt = (result.content[0] as { text: string }).text;
    expect(receipt).toContain('mat_web');
    expect(receipt).toContain('Fetched page');
    expect(prompt).not.toContain(receipt);
  });
});

describe('stored transcripts stay a provider-message prefix', () => {
  it('extends [user] with a preload tool result without rewriting the earlier request', () => {
    const skillBody = '# Import the uploaded deck';
    expect(skillBody.endsWith('\n')).toBe(false);

    const opening = [user('Build a lesson')];
    const preloaded = preloadTranscript(skillBody);
    const continued = [...preloaded, user('Now add a quiz')];

    const first = providerRequest(materialSets.none!, opening);
    const second = providerRequest(materialSets.web!, preloaded);
    const third = providerRequest(materialSets.extractionDone!, continued);

    expect(second.system).toBe(first.system);
    expect(third.system).toBe(first.system);
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(third.messages.slice(0, second.messages.length)).toEqual(second.messages);
    expect(second.messages).toHaveLength(first.messages.length + 2);
    expect(third.messages).toHaveLength(second.messages.length + 1);

    expect(toolReceipt(second.messages)).toBe(skillBody);
    expect(toolReceipt(second.messages)).not.toContain('Registered session materials');
    expect(toolReceipt(second.messages)).not.toContain('## Materials');
    expect(first.messages[0]).toEqual({ role: 'user', content: 'Build a lesson' });
  });
});
