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

  it('validates thinking options strictly', () => {
    const text = EXAMPLE.replace('thinking: { enabled: false }', 'thinking: { mode: sometimes }');
    expect(issuesOf(text)).toHaveLength(1);
    expect(issuesOf(text)[0]).toMatch(/^slots\.course\.content\.slide\.thinking\.mode:/);
  });

  it('reports every problem at once', () => {
    const text =
      'providers:\n  a:\n    preset: nope\nslots:\n  llm: ghost:m\n  course.summary: null\n';
    expect(issuesOf(text)).toHaveLength(3);
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
