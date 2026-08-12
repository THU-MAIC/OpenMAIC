import { beforeEach, describe, expect, it, vi } from 'vitest';

const bedrockMock = vi.hoisted(() => ({
  languageModel: vi.fn((modelId: string) => ({ endpoint: 'bedrock', modelId })),
  createAmazonBedrock: vi.fn(),
  fromNodeProviderChain: vi.fn(),
  credentialProvider: vi.fn(),
}));

vi.mock('@ai-sdk/amazon-bedrock', () => ({
  createAmazonBedrock: bedrockMock.createAmazonBedrock,
}));

vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: bedrockMock.fromNodeProviderChain,
}));

import { getModel, getModelInfo, getProvider, isProviderKeyRequired } from '@/lib/ai/providers';

describe('Bedrock provider defaults', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    bedrockMock.languageModel.mockClear();
    bedrockMock.createAmazonBedrock.mockReset();
    bedrockMock.createAmazonBedrock.mockReturnValue(bedrockMock.languageModel);
    bedrockMock.fromNodeProviderChain.mockReset();
    bedrockMock.credentialProvider.mockReset();
    bedrockMock.credentialProvider.mockResolvedValue({
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
      sessionToken: 'token',
      expiration: new Date('2030-01-01T00:00:00.000Z'),
    });
    bedrockMock.fromNodeProviderChain.mockReturnValue(bedrockMock.credentialProvider);
  });

  it('registers Bedrock as a built-in keyless LLM provider', () => {
    expect(getProvider('bedrock')).toMatchObject({
      id: 'bedrock',
      name: 'Amazon Bedrock',
      type: 'bedrock',
      requiresApiKey: false,
      icon: '/logos/bedrock.svg',
    });
    expect(isProviderKeyRequired('bedrock')).toBe(false);
    expect(getModelInfo('bedrock', 'us.anthropic.claude-sonnet-5')).toMatchObject({
      id: 'us.anthropic.claude-sonnet-5',
      name: 'Claude Sonnet 5 (Bedrock)',
      contextWindow: 1000000,
      outputWindow: 128000,
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
      },
    });
    for (const modelId of [
      'us.amazon.nova-pro-v1:0',
      'us.amazon.nova-lite-v1:0',
      'us.amazon.nova-micro-v1:0',
    ]) {
      expect(getModelInfo('bedrock', modelId)?.outputWindow).toBe(10000);
    }
  });

  it('ignores whitespace-only BEDROCK_REGION when resolving the AWS region', () => {
    vi.stubEnv('BEDROCK_REGION', '   ');
    vi.stubEnv('AWS_REGION', 'us-east-2');

    getModel({
      providerId: 'bedrock',
      modelId: 'us.anthropic.claude-sonnet-5',
      apiKey: '',
    });

    expect(bedrockMock.createAmazonBedrock).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us-east-2' }),
    );
  });

  it('rejects a provider type that conflicts with the built-in provider ID', () => {
    expect(() =>
      getModel({
        providerId: 'ollama',
        modelId: 'llama3.3',
        apiKey: '',
        providerType: 'bedrock',
      }),
    ).toThrow(/Provider type mismatch/);
    expect(bedrockMock.createAmazonBedrock).not.toHaveBeenCalled();
  });

  it('creates a Bedrock language model with the AWS credential provider chain', async () => {
    vi.stubEnv('BEDROCK_REGION', 'us-west-2');

    const { model } = getModel({
      providerId: 'bedrock',
      modelId: 'us.anthropic.claude-sonnet-5',
      apiKey: '',
    });

    expect(bedrockMock.createAmazonBedrock).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-west-2',
        apiKey: undefined,
        credentialProvider: expect.any(Function),
      }),
    );
    expect(bedrockMock.languageModel).toHaveBeenCalledWith('us.anthropic.claude-sonnet-5');
    expect(model).toEqual({
      endpoint: 'bedrock',
      modelId: 'us.anthropic.claude-sonnet-5',
    });

    const options = bedrockMock.createAmazonBedrock.mock.calls[0]?.[0] as {
      credentialProvider: () => Promise<{
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
        expiration?: Date;
      }>;
    };
    await expect(options.credentialProvider()).resolves.toEqual({
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
      sessionToken: 'token',
      expiration: new Date('2030-01-01T00:00:00.000Z'),
    });
    await options.credentialProvider();
    expect(bedrockMock.fromNodeProviderChain).toHaveBeenCalledTimes(1);
    expect(bedrockMock.credentialProvider).toHaveBeenCalledTimes(2);
  });

  it('passes a Bedrock bearer token when an API key is configured', () => {
    getModel({
      providerId: 'bedrock',
      modelId: 'us.anthropic.claude-opus-4-8',
      apiKey: 'bedrock-bearer',
    });

    expect(bedrockMock.createAmazonBedrock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'bedrock-bearer',
      }),
    );
  });
});
