/**
 * LearnWorlds MCP integration — unit tests.
 *
 * Covers the pure helpers in lib/lms/types.ts, the tool-result parsing in
 * lib/server/learnworlds-mcp.ts and the titleId slug builder used by the
 * export hook.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LEARNWORLDS_CONFIG,
  parseMcpServersJson,
  learnWorldsAdminCourseUrl,
  validateLearnWorldsConfig,
  type LearnWorldsMcpConfig,
} from '@/lib/lms/types';
import { parseToolResult, extractCourseId } from '@/lib/server/learnworlds-mcp';
import { buildTitleId } from '@/lib/lms/use-export-learnworlds';

function completeConfig(overrides: Partial<LearnWorldsMcpConfig> = {}): LearnWorldsMcpConfig {
  return {
    ...DEFAULT_LEARNWORLDS_CONFIG,
    enabled: true,
    transport: 'stdio',
    command: 'node',
    args: ['/abs/path/Learnworlds-MCP/dist/index.js'],
    baseUrl: 'https://my-school.learnworlds.com/admin/api',
    apiToken: 'token-123',
    clientId: 'client-456',
    ...overrides,
  };
}

describe('parseMcpServersJson', () => {
  it('parses the Claude-Desktop mcpServers format from the README', () => {
    const raw = JSON.stringify({
      mcpServers: {
        learnworlds: {
          command: 'node',
          args: ['/ABSOLUTE/PATH/Learnworlds-MCP/dist/index.js'],
          env: {
            MCP_TRANSPORT: 'stdio',
            LEARNWORLDS_BASE_URL: 'https://your-school.learnworlds.com/admin/api',
            LEARNWORLDS_API_TOKEN: 'your-access-token',
            LEARNWORLDS_CLIENT_ID: 'your-client-id',
          },
        },
      },
    });
    const parsed = parseMcpServersJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.transport).toBe('stdio');
    expect(parsed?.command).toBe('node');
    expect(parsed?.args).toEqual(['/ABSOLUTE/PATH/Learnworlds-MCP/dist/index.js']);
    expect(parsed?.baseUrl).toBe('https://your-school.learnworlds.com/admin/api');
    expect(parsed?.apiToken).toBe('your-access-token');
    expect(parsed?.clientId).toBe('your-client-id');
  });

  it('parses a bare server entry without the mcpServers wrapper', () => {
    const raw = JSON.stringify({
      command: 'node',
      args: ['/x/index.js'],
      env: { LEARNWORLDS_API_TOKEN: 't' },
    });
    const parsed = parseMcpServersJson(raw);
    expect(parsed?.command).toBe('node');
    expect(parsed?.apiToken).toBe('t');
  });

  it('finds a learnworlds entry under a different server key via env vars', () => {
    const raw = JSON.stringify({
      mcpServers: {
        'my-lms': {
          command: 'node',
          args: ['/y/index.js'],
          env: { LEARNWORLDS_CLIENT_ID: 'cid' },
        },
      },
    });
    const parsed = parseMcpServersJson(raw);
    expect(parsed?.clientId).toBe('cid');
    expect(parsed?.args).toEqual(['/y/index.js']);
  });

  it('detects HTTP transport from a url field', () => {
    const raw = JSON.stringify({
      mcpServers: { learnworlds: { url: 'http://localhost:3900/mcp' } },
    });
    const parsed = parseMcpServersJson(raw);
    expect(parsed?.transport).toBe('http');
    expect(parsed?.httpUrl).toBe('http://localhost:3900/mcp');
  });

  it('returns null for invalid JSON or unrelated content', () => {
    expect(parseMcpServersJson('not json')).toBeNull();
    expect(parseMcpServersJson('{"foo": 1}')).toBeNull();
    expect(parseMcpServersJson('{"mcpServers": {"other": {"env": {"X": "1"}}}}')).toBeNull();
  });
});

describe('validateLearnWorldsConfig', () => {
  it('accepts a complete stdio config', () => {
    expect(validateLearnWorldsConfig(completeConfig())).toEqual([]);
  });

  it('accepts a complete http config', () => {
    const config = completeConfig({
      transport: 'http',
      command: '',
      args: [],
      httpUrl: 'http://localhost:3900/mcp',
    });
    expect(validateLearnWorldsConfig(config)).toEqual([]);
  });

  it('reports missing credentials', () => {
    const config = completeConfig({ baseUrl: '', apiToken: '', clientId: '' });
    const missing = validateLearnWorldsConfig(config);
    expect(missing).toContain('baseUrl');
    expect(missing).toContain('apiToken');
    expect(missing).toContain('clientId');
  });

  it('reports missing stdio command/args', () => {
    const config = completeConfig({ command: '', args: [] });
    const missing = validateLearnWorldsConfig(config);
    expect(missing).toContain('command');
    expect(missing).toContain('args');
  });

  it('reports missing http url', () => {
    const config = completeConfig({ transport: 'http', httpUrl: '' });
    expect(validateLearnWorldsConfig(config)).toContain('httpUrl');
  });
});

describe('learnWorldsAdminCourseUrl', () => {
  it('derives the admin course URL from the API base URL', () => {
    expect(learnWorldsAdminCourseUrl('https://my-school.learnworlds.com/admin/api', 'abc123')).toBe(
      'https://my-school.learnworlds.com/admin/courses/abc123',
    );
  });

  it('returns undefined for invalid base URLs', () => {
    expect(learnWorldsAdminCourseUrl('not-a-url', 'abc')).toBeUndefined();
  });
});

describe('parseToolResult', () => {
  it('parses an HTTP 200 OK JSON payload', () => {
    const result = parseToolResult({
      content: [{ type: 'text', text: 'HTTP 200 OK\n{"data": {"id": "c1"}}' }],
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ data: { id: 'c1' } });
  });

  it('flags HTTP 4xx as not ok', () => {
    const result = parseToolResult({
      content: [{ type: 'text', text: 'HTTP 401 ERROR\n{"error": "unauthorized"}' }],
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('respects the MCP isError flag', () => {
    const result = parseToolResult({
      isError: true,
      content: [{ type: 'text', text: 'connection refused' }],
    });
    expect(result.ok).toBe(false);
    expect(result.body).toBe('connection refused');
  });
});

describe('extractCourseId', () => {
  it('extracts id and titleId from a data-wrapped response', () => {
    expect(extractCourseId({ data: { id: 'x1', titleId: 'my-course' } })).toEqual({
      id: 'x1',
      titleId: 'my-course',
    });
  });

  it('extracts from a flat response', () => {
    expect(extractCourseId({ id: 'x2' })).toEqual({ id: 'x2', titleId: undefined });
  });

  it('handles non-object bodies gracefully', () => {
    expect(extractCourseId('oops')).toEqual({});
    expect(extractCourseId(null)).toEqual({});
  });
});

describe('buildTitleId', () => {
  it('slugifies titles with diacritics and spaces', () => {
    const id = buildTitleId('Entornos de IA Colaborativos: ¡Édición 2026!');
    expect(id).toMatch(/^entornos-de-ia-colaborativos-edicion-2026-[a-z0-9]{4}$/);
  });

  it('falls back to a generic slug for empty titles', () => {
    expect(buildTitleId('¡¡¡')).toMatch(/^openmaic-course-[a-z0-9]{4}$/);
  });

  it('caps slug length', () => {
    const id = buildTitleId('x'.repeat(200));
    expect(id.length).toBeLessThanOrEqual(53);
  });
});
