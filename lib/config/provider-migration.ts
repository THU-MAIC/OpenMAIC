export const PROVIDER_MIGRATION_URL =
  'https://github.com/THU-MAIC/OpenMAIC/blob/main/packages/docs/content/docs/configuration.mdx#migrating-from-the-legacy-configuration';

export const PROVIDER_MIGRATION_NOTICE = 'Deprecated provider settings detected:';
export const LEGACY_BEARER_TOKEN_ENV = 'AWS_BEARER_TOKEN_BEDROCK';

export const DEPRECATED_PROVIDER_HEADERS = [
  'x-api-key',
  'x-base-url',
  'x-model',
  'x-model-routes',
  'x-provider-type',
  'x-image-provider',
  'x-image-model',
  'x-video-provider',
  'x-video-model',
] as const;

export const ALIDOCMIND_LEGACY_SETTINGS = [
  'ALIDOCMIND_ACCESS_KEY_ID',
  'ALIDOCMIND_ACCESS_KEY_SECRET',
  'ALIDOCMIND_BASE_URL',
] as const;
