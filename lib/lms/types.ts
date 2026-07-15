/**
 * LMS integration types (LearnWorlds via MCP).
 *
 * The LearnWorlds MCP server (https://github.com/ohneben/Learnworlds-MCP)
 * exposes the LearnWorlds public API as MCP tools. OpenMAIC talks to it
 * through a Next.js API route acting as an MCP client, supporting both
 * stdio (local process) and streamable HTTP transports.
 */

/** Transport used to reach the LearnWorlds MCP server. */
export type LmsMcpTransport = 'stdio' | 'http';

/** User-facing configuration for the LearnWorlds MCP integration. */
export interface LearnWorldsMcpConfig {
  /** Master switch; when false the export option is hidden. */
  enabled: boolean;
  /** Transport used to reach the MCP server. */
  transport: LmsMcpTransport;
  /** stdio: executable to launch (e.g. "node"). */
  command: string;
  /** stdio: arguments (e.g. ["/abs/path/Learnworlds-MCP/dist/index.js"]). */
  args: string[];
  /** http: base URL of the streamable HTTP MCP endpoint. */
  httpUrl: string;
  /** http: optional bearer token (MCP_AUTH_TOKEN). */
  httpAuthToken: string;
  /** LEARNWORLDS_BASE_URL, e.g. https://my-school.learnworlds.com/admin/api */
  baseUrl: string;
  /** LEARNWORLDS_API_TOKEN (bearer access token). */
  apiToken: string;
  /** LEARNWORLDS_CLIENT_ID (sent as Lw-Client header). */
  clientId: string;
}

export const DEFAULT_LEARNWORLDS_CONFIG: LearnWorldsMcpConfig = {
  enabled: false,
  transport: 'stdio',
  command: 'node',
  args: [],
  httpUrl: '',
  httpAuthToken: '',
  baseUrl: '',
  apiToken: '',
  clientId: '',
};

/** Request body accepted by POST /api/lms/learnworlds. */
export interface LearnWorldsApiRequest {
  action: 'test' | 'publish';
  config: LearnWorldsMcpConfig;
  /** Only for action === 'publish'. */
  course?: LearnWorldsPublishPayload;
}

/** Course structure sent to the LMS when publishing. */
export interface LearnWorldsPublishPayload {
  title: string;
  titleId: string;
  description: string;
  access: 'draft' | 'private' | 'free' | 'paid' | 'coming_soon';
  sections: Array<{
    title: string;
    /** Scene kind for context (slide | quiz | interactive | pbl). */
    kind: string;
    /** Section description shown in LearnWorlds; references the SCORM file to upload. */
    description?: string;
  }>;
}

/** Result of a connection test. */
export interface LearnWorldsTestResult {
  ok: boolean;
  serverName?: string;
  serverVersion?: string;
  toolCount?: number;
  /** Sample of relevant tool names found (course management). */
  courseTools?: string[];
  error?: string;
}

/** Result of a publish operation. */
export interface LearnWorldsPublishResult {
  ok: boolean;
  courseId?: string;
  courseTitleId?: string;
  /** Direct link to the course admin page in the LearnWorlds school. */
  adminUrl?: string;
  sectionsCreated: number;
  sectionsFailed: number;
  warnings: string[];
  error?: string;
}

/**
 * Parse a Claude-Desktop-style `mcpServers` JSON blob and extract the
 * LearnWorlds server configuration. Returns null when the blob does not
 * contain a usable entry.
 *
 * Accepted shapes:
 * - { "mcpServers": { "learnworlds": { command, args, env } } }
 * - { "learnworlds": { command, args, env } }
 * - { command, args, env }
 */
export function parseMcpServersJson(raw: string): Partial<LearnWorldsMcpConfig> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const root = parsed as Record<string, unknown>;
  const servers = (root.mcpServers ?? root) as Record<string, unknown>;

  // Find the learnworlds entry (exact key, or single entry, or entry whose
  // env mentions LEARNWORLDS_*).
  let entry: Record<string, unknown> | null = null;
  if (servers.learnworlds && typeof servers.learnworlds === 'object') {
    entry = servers.learnworlds as Record<string, unknown>;
  } else if (typeof root.command === 'string' || typeof root.url === 'string') {
    entry = root;
  } else {
    for (const value of Object.values(servers)) {
      if (!value || typeof value !== 'object') continue;
      const candidate = value as Record<string, unknown>;
      const env = (candidate.env ?? {}) as Record<string, unknown>;
      if (Object.keys(env).some((k) => k.startsWith('LEARNWORLDS_'))) {
        entry = candidate;
        break;
      }
    }
  }
  if (!entry) return null;

  const env = (entry.env ?? {}) as Record<string, string>;
  const result: Partial<LearnWorldsMcpConfig> = {};

  if (typeof entry.command === 'string') {
    result.transport = 'stdio';
    result.command = entry.command;
    result.args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  }
  if (typeof entry.url === 'string') {
    result.transport = 'http';
    result.httpUrl = entry.url;
  }
  if (env.MCP_TRANSPORT === 'http' && typeof env.MCP_HTTP_URL === 'string') {
    result.transport = 'http';
    result.httpUrl = env.MCP_HTTP_URL;
  }
  if (typeof env.LEARNWORLDS_BASE_URL === 'string') result.baseUrl = env.LEARNWORLDS_BASE_URL;
  if (typeof env.LEARNWORLDS_API_TOKEN === 'string') result.apiToken = env.LEARNWORLDS_API_TOKEN;
  if (typeof env.LEARNWORLDS_CLIENT_ID === 'string') result.clientId = env.LEARNWORLDS_CLIENT_ID;
  if (typeof env.MCP_AUTH_TOKEN === 'string') result.httpAuthToken = env.MCP_AUTH_TOKEN;

  const hasAny =
    result.command !== undefined ||
    result.httpUrl !== undefined ||
    result.baseUrl !== undefined ||
    result.apiToken !== undefined ||
    result.clientId !== undefined;
  return hasAny ? result : null;
}

/**
 * Derive the school admin URL for a course from the API base URL.
 * https://my-school.learnworlds.com/admin/api -> https://my-school.learnworlds.com/admin/courses/{id}
 */
export function learnWorldsAdminCourseUrl(baseUrl: string, courseId: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    return `${url.origin}/admin/courses/${encodeURIComponent(courseId)}`;
  } catch {
    return undefined;
  }
}

/** Validate that a config has the minimum required fields for its transport. */
export function validateLearnWorldsConfig(config: LearnWorldsMcpConfig): string[] {
  const errors: string[] = [];
  if (!config.baseUrl.trim()) errors.push('baseUrl');
  if (!config.apiToken.trim()) errors.push('apiToken');
  if (!config.clientId.trim()) errors.push('clientId');
  if (config.transport === 'stdio') {
    if (!config.command.trim()) errors.push('command');
    if (config.args.length === 0 || !config.args.some((a) => a.trim())) errors.push('args');
  } else if (!config.httpUrl.trim()) {
    errors.push('httpUrl');
  }
  return errors;
}
