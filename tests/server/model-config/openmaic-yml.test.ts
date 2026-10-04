import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ConfigEnv,
  ModelConfigError,
  loadModelConfigFile,
  parseModelConfig,
} from '@/lib/server/model-config/openmaic-yml';

const env = { MINIMAX_API_KEY: 'sk-test' };

function issuesOf(text: string, overrides: ConfigEnv = env): readonly string[] {
  try {
    parseModelConfig(text, { env: overrides });
  } catch (error) {
    expect(error).toBeInstanceOf(ModelConfigError);
    return (error as ModelConfigError).issues;
  }
  throw new Error('expected the configuration to be refused');
}

const EXAMPLE = `
providers:
  minimax:
    preset: minimax
    apiKey: \${MINIMAX_API_KEY}
  local:
    preset: openai-compatible
    baseUrl: http://ollama:11434/v1

slots:
  llm: minimax:MiniMax-M3
  course.content.slide:
    model: minimax:MiniMax-M3
    thinking: { enabled: false }
    fallback: minimax:MiniMax-M2.7
  classroom: local:qwen3:8b
  tts: minimax:speech-2.8-turbo
  video: null

policy:
  allowWorkspaceProviders: false
`;

describe('parseModelConfig', () => {
  it('accepts the RFC example and interpolates secrets', () => {
    const config = parseModelConfig(EXAMPLE, { env });
    expect(config.providers?.minimax.apiKey).toBe('sk-test');
    expect(config.slots?.video).toBeNull();
    expect(config.slots?.classroom).toBe('local:qwen3:8b');
    expect(config.policy?.allowWorkspaceProviders).toBe(false);
  });

  it('treats an empty file as no configuration', () => {
    expect(parseModelConfig('', { env })).toEqual({});
    expect(parseModelConfig('# nothing yet\n', { env })).toEqual({});
  });

  it('refuses an unset environment variable, naming the field and the variable', () => {
    const issues = issuesOf(EXAMPLE, {});
    expect(issues).toContainEqual(
      'providers.minimax.apiKey: environment variable MINIMAX_API_KEY is not set',
    );
  });

  it('refuses invalid YAML', () => {
    expect(issuesOf('providers: [unclosed')[0]).toMatch(/^not valid YAML/);
  });

  it('refuses unknown keys, slots and presets', () => {
    expect(issuesOf('models: {}\n')).toHaveLength(1);
    expect(issuesOf('slots:\n  course.summary: null\n')).toEqual([
      'slots.course.summary: unknown slot',
    ]);
    expect(issuesOf('providers:\n  x:\n    preset: nope\n')).toEqual([
      'providers.x.preset: unknown preset "nope"',
    ]);
  });

  it('refuses an OpenAI-compatible provider without a base URL', () => {
    expect(issuesOf('providers:\n  local:\n    preset: openai-compatible\n')).toEqual([
      'providers.local.baseUrl: preset "openai-compatible" needs a baseUrl',
    ]);
  });

  it('refuses assignments to undeclared providers or capabilities the preset lacks', () => {
    expect(issuesOf('slots:\n  llm: ghost:model\n')).toEqual([
      'slots.llm: provider "ghost" is not declared under providers',
    ]);
    const kimi =
      'providers:\n  kimi:\n    preset: kimi-coding-plan\n    apiKey: k\nslots:\n  tts: kimi:voice\n';
    expect(issuesOf(kimi)).toEqual([
      'slots.tts: provider "kimi" (preset "kimi-coding-plan") does not offer tts',
    ]);
  });

  it('checks the fallback model like the primary one', () => {
    const text = `${EXAMPLE}\n`.replace('fallback: minimax:MiniMax-M2.7', 'fallback: ghost:model');
    expect(issuesOf(text)).toEqual([
      'slots.course.content.slide.fallback: provider "ghost" is not declared under providers',
    ]);
  });

  it('refuses a fallback on every slot whose calls never use one', () => {
    const base = 'providers:\n  m:\n    preset: minimax\n    apiKey: k\nslots:\n';
    for (const slot of ['tts', 'asr', 'image', 'video', 'webSearch', 'document']) {
      expect(issuesOf(`${base}  ${slot}:\n    model: m\n    fallback: m\n`)).toContain(
        `slots.${slot}.fallback: only language model slots use a fallback`,
      );
    }
  });

  it('keeps agent driver parameters on the agent slot', () => {
    const base = 'providers:\n  m:\n    preset: minimax\n    apiKey: k\nslots:\n';
    expect(() =>
      parseModelConfig(
        `${base}  agent:\n    model: m:MiniMax-M3\n    api: openai-completions\n    contextWindow: 128000\n`,
        {
          env,
        },
      ),
    ).not.toThrow();
    expect(issuesOf(`${base}  llm:\n    model: m:MiniMax-M3\n    contextWindow: 128000\n`)).toEqual(
      ['slots.llm: api and contextWindow only apply to the agent slot'],
    );
  });

  it('refuses a thinking effort on the agent slot but not its other thinking settings', () => {
    const base = 'providers:\n  m:\n    preset: minimax\n    apiKey: k\nslots:\n';
    expect(
      issuesOf(`${base}  agent:\n    model: m:MiniMax-M3\n    thinking: { effort: high }\n`),
    ).toEqual([
      'slots.agent.thinking.effort: the agent slot cannot set a thinking effort, because its ' +
        'tool calls cannot be combined with a reasoning effort; set thinking.mode instead',
    ]);
    expect(() =>
      parseModelConfig(
        `${base}  agent:\n    model: m:MiniMax-M3\n    thinking: { mode: enabled }\n`,
        {
          env,
        },
      ),
    ).not.toThrow();
    // An effort on llm stays valid: the agent drops it when it inherits.
    expect(() =>
      parseModelConfig(`${base}  llm:\n    model: m:MiniMax-M3\n    thinking: { effort: high }\n`, {
        env,
      }),
    ).not.toThrow();
  });

  it('validates thinking options strictly', () => {
    const text = EXAMPLE.replace('thinking: { enabled: false }', 'thinking: { mode: sometimes }');
    expect(issuesOf(text)).toHaveLength(1);
    expect(issuesOf(text)[0]).toMatch(/^slots\.course\.content\.slide\.thinking\.mode:/);
  });

  it('does not take inherited object keys for declared providers', () => {
    expect(issuesOf('slots:\n  llm: constructor:m\n')).toEqual([
      'slots.llm: provider "constructor" is not declared under providers',
    ]);
    const fallback =
      'providers:\n  m:\n    preset: minimax\n    apiKey: k\nslots:\n  llm:\n    model: m:MiniMax-M3\n    fallback: constructor:x\n';
    expect(issuesOf(fallback)).toEqual([
      'slots.llm.fallback: provider "constructor" is not declared under providers',
    ]);
  });

  it('refuses YAML values that are not mappings where mappings are expected', () => {
    expect(issuesOf('policy: 2026-01-01\n')).toEqual([
      'policy: unsupported YAML value; quote it to use it as text',
    ]);
    expect(issuesOf('2026-01-01\n')).toEqual([
      '(root): unsupported YAML value; quote it to use it as text',
    ]);
  });

  it('refuses a YAML alias that refers back to itself', () => {
    const issues = issuesOf('providers: &p\n  loop: *p\n');
    expect(issues).toContainEqual('providers.loop: a YAML alias refers back to itself');
  });

  it('accepts lowercase variable names and keeps secrets that contain "${"', () => {
    const text = 'providers:\n  m:\n    preset: minimax\n    apiKey: ${lower_key}\n';
    const config = parseModelConfig(text, { env: { lower_key: 'a${b}c' } });
    expect(config.providers?.m.apiKey).toBe('a${b}c');
  });

  it('refuses a placeholder with no closing brace', () => {
    const text = 'providers:\n  m:\n    preset: minimax\n    apiKey: "${SECRET"\n';
    expect(issuesOf(text, { SECRET: 'x' })).toEqual([
      'providers.m.apiKey: "${" has no closing "}"',
    ]);
  });

  it('only reads variables the environment really has', () => {
    const text = 'providers:\n  m:\n    preset: minimax\n    apiKey: ${constructor}\n';
    expect(issuesOf(text, {})).toEqual([
      'providers.m.apiKey: environment variable constructor is not set',
    ]);
    expect(() => parseModelConfig(text)).toThrow(/environment variable constructor is not set/);
    // An inherited string value is not a variable of this environment either.
    const inherited = Object.create({ INHERITED: 'from-prototype' }) as Record<string, string>;
    expect(
      issuesOf('providers:\n  m:\n    preset: minimax\n    apiKey: ${INHERITED}\n', inherited),
    ).toEqual(['providers.m.apiKey: environment variable INHERITED is not set']);
  });

  it('reports every reference problem together once the document is valid', () => {
    const text = 'providers:\n  a:\n    preset: nope\nslots:\n  llm: ghost:m\n  tts: phantom:v\n';
    expect([...issuesOf(text)].sort()).toEqual(
      [
        'providers.a.preset: unknown preset "nope"',
        'slots.llm: provider "ghost" is not declared under providers',
        'slots.tts: provider "phantom" is not declared under providers',
      ].sort(),
    );
  });

  it('checks references only after the document itself is valid', () => {
    const text =
      'providers:\n  a:\n    preset: nope\n  b:\n    preset: minimax\n    extra: 1\nslots:\n  llm:\n    model: ghost:m\n    thinking: { mode: wrong }\n  course.summary: 123\n';
    const issues = issuesOf(text);
    expect(issues).toContainEqual('providers.b: Unrecognized key: "extra"');
    expect(issues).toContainEqual('slots.course.summary: unknown slot');
    expect(issues.some((issue) => issue.startsWith('slots.llm.thinking.mode:'))).toBe(true);
    expect(issues).toHaveLength(3); // one diagnostic per path
    expect(issues.join('\n')).not.toMatch(/unknown preset|not declared/);
  });

  it('does not check references built from a failed placeholder', () => {
    expect(issuesOf('slots:\n  llm: missing${M}:m\n', {})).toEqual([
      'slots.llm: environment variable M is not set',
    ]);
  });

  it('refuses __proto__ as a slot or provider id', () => {
    expect(issuesOf('slots:\n  __proto__: null\n')).toEqual(['slots.__proto__: unknown slot']);
    expect(issuesOf('providers:\n  __proto__:\n    preset: minimax\n')).toContainEqual(
      'providers.__proto__: invalid provider id',
    );
  });

  it('never prints a substituted secret or YAML source in diagnostics', () => {
    const secret = 'sk-do-not-print-7f3a';
    const preset = issuesOf('providers:\n  m:\n    preset: ${S}\n', { S: secret });
    expect(preset).toEqual([
      'providers.m.preset: unknown preset (value from an environment variable)',
    ]);
    const ref = issuesOf('slots:\n  llm: ${S}:model\n', { S: 'ghostprovider' });
    expect(ref.join('\n')).not.toContain('ghostprovider');
    const broken = issuesOf(`providers:\n  m:\n    apiKey: ${secret}\n    bad: [\n`);
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatch(/^not valid YAML at line \d+, column \d+$/);
    expect(broken[0]).not.toContain(secret);
    for (const text of [`apiKey: *${secret}\n`, `apiKey: !${secret} x\n`]) {
      const issues = issuesOf(text);
      expect(issues.join('\n')).not.toContain(secret);
    }
  });

  it.each([
    ['searxng', 'webSearch'],
    ['azure', 'chat'],
    ['mineru', 'document'],
  ])('requires a baseUrl for %s', (preset) => {
    expect(issuesOf(`providers:\n  p:\n    preset: ${preset}\n`)).toEqual([
      `providers.p.baseUrl: preset "${preset}" needs a baseUrl`,
    ]);
    expect(() =>
      parseModelConfig(`providers:\n  p:\n    preset: ${preset}\n    baseUrl: http://host:8080\n`, {
        env,
      }),
    ).not.toThrow();
  });
});

describe('provider-only references', () => {
  it('name the default model of a provider without models to pick', () => {
    const config = parseModelConfig(
      'providers:\n  tv:\n    preset: tavily\n    apiKey: k\nslots:\n  webSearch: tv\n',
      { env: {} },
    );
    expect(config.slots).toEqual({ webSearch: 'tv' });
  });

  it('are refused for a chat slot', () => {
    expect(() =>
      parseModelConfig(
        'providers:\n  mm:\n    preset: minimax\n    apiKey: k\nslots:\n  llm: mm\n',
        { env: {} },
      ),
    ).toThrow('slots.llm: a chat model needs "providerId:modelId"');
  });
});

describe('loadModelConfigFile', () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmaic-yml-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when there is no file', () => {
    expect(loadModelConfigFile({}, tempDir())).toBeNull();
  });

  it('reads openmaic.yml from the working directory', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'openmaic.yml'), EXAMPLE);
    expect(loadModelConfigFile(env, dir)?.slots?.llm).toBe('minimax:MiniMax-M3');
  });

  it('reads the file named by OPENMAIC_CONFIG, and refuses a missing one', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'models.yml'), 'slots:\n  video: null\n');
    expect(loadModelConfigFile({ OPENMAIC_CONFIG: 'models.yml' }, dir)?.slots?.video).toBeNull();
    expect(() => loadModelConfigFile({ OPENMAIC_CONFIG: 'missing.yml' }, dir)).toThrow(
      ModelConfigError,
    );
  });
});
