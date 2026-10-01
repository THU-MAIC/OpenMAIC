/**
 * Golden pins for every shipped schema migration of every store this
 * application provisions (storage package and app). A shipped migration's
 * checksum is recorded on every database it ran on, so editing one makes those
 * databases fail a development start and warn in production. A failure here
 * means a shipped migration changed: revert it and add a new migration. Only
 * a NEW migration (or a new store) adds a row here.
 */
import { schemaMigrationChecksum } from '@openmaic/storage/pg-migrations';
import { describe, expect, it } from 'vitest';

import { APP_SCHEMA_STORES } from '@/lib/persistence/schema-stores';

const SHIPPED: readonly (readonly [
  store: string,
  version: number,
  name: string,
  transaction: boolean,
  checksum: string,
])[] = [
  [
    'runtime',
    1,
    'baseline',
    false,
    '87e3a83d8a718e1e7420e7507ac7f4c7810162e610fdff01997a5549b309063d',
  ],
  [
    'document',
    1,
    'baseline',
    false,
    '78ce8d4c7509425716c587ae8dbd163d5b5f5c81c6075ad4a74efaebc5a43aa9',
  ],
  [
    'document',
    2,
    'retire_document_stages_owner_id',
    true,
    'e79a611f5f57f5bf61edb3bf166d6744be1cc2c26d763349bfff246530689c2f',
  ],
  [
    'stage-meta',
    1,
    'baseline',
    false,
    '37854e43cc676f8bc81f6b402b7b8d819470778bfb1f6846012c2e4a18998202',
  ],
  [
    'stage-meta',
    2,
    'adopt_legacy_document_owners',
    true,
    'd53921614f5337fb5f300e788e037968aa10c6d303a52d1e0b5a493468354834',
  ],
  [
    'owner-merges',
    1,
    'baseline',
    false,
    '48295bbd5b7a47515ef9df8677f451052111d4e6f8fd04ad36c5e536df1ff0bf',
  ],
  [
    'legacy-import-bindings',
    1,
    'baseline',
    false,
    '604cdd8de13dc8cb8b5f70a97d2e37deba1bc7eb67b687d6d7b3b3d59c631c79',
  ],
  [
    'owner-material',
    1,
    'baseline',
    false,
    '569a37fa4e863644041b6e47abd55538ee882cfa2ecc51696410bebb106705be',
  ],
  [
    'owner-material',
    2,
    'byte_store_key',
    true,
    'fd7c8d270394855d7c6a14470ff60311d69dff3ddf4ba23befe0fff8ba664661',
  ],
  [
    'asset',
    1,
    'baseline',
    false,
    'd440298e2262b7ce4688848c2a8e23ca7d26b29e2b75cfc7011c0e60308178c5',
  ],
  [
    'legacy-classroom-imports',
    1,
    'baseline',
    false,
    '500638ed89d4d005069da8d0ec8be834d0554217300dada43a4afd2aac1f7268',
  ],
  [
    'workspace-model-config',
    1,
    'baseline',
    false,
    '82f0e38e650d3c51fd99ce8c24dab05b499cf30040f67ade7672dec064af104a',
  ],
  [
    'owner-agents',
    1,
    'baseline',
    true,
    'c7eaf8e6df8b27b2cb1a4f38ad908e7d790a4f8af8ee865268df19ed543231c8',
  ],
  [
    'agent-session',
    1,
    'baseline',
    false,
    '303bc60b42134420f6fc819d065aa7beb58950bdaaab17a2c9e531c1a77e301a',
  ],
  [
    'agent-session',
    2,
    'owner_event_type_known_v2',
    false,
    '5ca438832108d37a5c62efc951cc02bc4d2806c8aba39f1bd3cab426540507d7',
  ],
  [
    'agent-session-material',
    1,
    'baseline',
    false,
    '0fb90c35c638f1bdfafc106909c6bc9985b457aa158ed29f3930cfadd3edb89b',
  ],
  [
    'user-skill',
    1,
    'baseline',
    false,
    'b5f3e25dec1e8ce841e7f9fda08502f1fdddea25fdef85ed0d8ad1ad5aeebbad',
  ],
  [
    'generation-runs',
    1,
    'baseline',
    false,
    'be1c2c6a13bb6c787e90549e65904ff94c60e05a3faac309b8951eeb2ce4994b',
  ],
  [
    'generation-runs',
    2,
    'media_pending',
    true,
    '7f6f57d0c4ca3056e8a01de8fa243bc20db5e300099275aee7b5a10de5387edf',
  ],
];

describe('shipped schema migrations', () => {
  it('are exactly the pinned (store, version, name, transaction, checksum) rows', async () => {
    const actual: (readonly [string, number, string, boolean, string])[] = [];
    for (const set of APP_SCHEMA_STORES) {
      for (const migration of set.migrations) {
        actual.push([
          set.store,
          migration.version,
          migration.name,
          migration.transaction !== false,
          await schemaMigrationChecksum(migration),
        ]);
      }
    }
    expect(actual).toEqual(SHIPPED);
  });
});
