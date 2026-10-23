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
    'owner-material',
    3,
    'extraction_lease',
    true,
    'f021eaa2d167d4db15d893787ca5f32ae4a8b8d55a2386c6d9fc2a1c916434dd',
  ],
  [
    'owner-material',
    4,
    'touched_at',
    true,
    '3acac29dc0790eee5fdd4831810f19864eba2e9cef251a8804b49f74f1c48609',
  ],
  [
    'asset',
    1,
    'baseline',
    false,
    'd440298e2262b7ce4688848c2a8e23ca7d26b29e2b75cfc7011c0e60308178c5',
  ],
  [
    'asset',
    2,
    'retained-document-assets',
    true,
    '69c2f4cfe961b9f95f745e7cd412426d5d42a365ee57aebd8d56209c6739b6d1',
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
  [
    'generation-runs',
    3,
    'run_report',
    true,
    '0280652b73aa1ec86924e6ef495705bb980f48781b851914571e10a60038de75',
  ],
  [
    'generation-runs',
    4,
    'outline_auto_confirm',
    true,
    '253db00a6eee8dfb35dc8aa435132be86e9e6039fde63eb07e66282a1d5f2866',
  ],
  [
    'generation-runs',
    5,
    'host_attributes',
    true,
    '73994d78d22a31a3b7c62f9ecb147a20bd70ffa17ab036f7bd6a75df682d9827',
  ],
  [
    'sandbox-environments',
    1,
    'baseline',
    false,
    'e86b769473cfb2ee694b40913e203344e4f6a9e1eb2f5a151b4d037bd1b81783',
  ],
  [
    'sandbox-environments',
    2,
    'commands',
    true,
    '3f82e91fb85a1a6a4114a201298b5c82b11fed7db191001fe0e4f5e3f4c113bb',
  ],
  [
    'sandbox-environments',
    3,
    'runtime-profiles',
    true,
    '47bc13e31048e4625a18da534b390a15f34fcbe49d16d98e650600ad16c10f71',
  ],
  [
    'sandbox-environments',
    4,
    'terminals',
    true,
    '720a88cc2c1f20062b869ec5d0a6a6cb80814bca15cfe8bc829796e0fcbb2298',
  ],
  [
    'sandbox-environments',
    5,
    'workspace-checkpoints',
    true,
    'db4f9fd3b1948e36c62e1bd8f01adb49669558fd13eeaa8121caccdf9391dda6',
  ],
  [
    'sandbox-environments',
    6,
    'session-tool-grants',
    true,
    '6b5ce730e3c7c48e5f16dd1f1d9aade8a3717d93e56ac90b9c0f3677bbd1ca20',
  ],
  [
    'sandbox-environments',
    7,
    'external-checkpoint-bytes',
    true,
    'a9d9e9dbb4ba55af2ff677735dd0512a2bc271bd850fcb52ff906043bd8a6fcc',
  ],
  [
    'sandbox-environments',
    8,
    'installation-settings',
    true,
    '4a953692f696b55858f10f3d02391c5d7e825df54f12f8db96a4b85919d5e75f',
  ],
  [
    'sandbox-environments',
    9,
    'remove-development-checkpoint-blobs',
    true,
    '5e9cf4ab91fc2db5388bde7140533c74f4aece46bab33173fa66ba7dba63bb13',
  ],
  [
    'pbl-projects',
    1,
    'validated-project-assets',
    true,
    '8ce2ab0cdf1a49271d597e22cd293be301794be34715ccd11ef9a9497f574180',
  ],
  [
    'pbl-v3',
    1,
    'learning-runtime',
    true,
    '6d7c92c1ee0d4947cb6343b8b07448e37cbfab1eb5d3dfe1ce792b1e112e9019',
  ],
  [
    'pbl-v3',
    2,
    'learning-environment-recovery',
    true,
    '46120b3270d0e3340c0324a58b5ed8fc7370602ab1a5cff7caed71f4e43a87da',
  ],
  [
    'pbl-v3',
    3,
    'pin-project-template',
    true,
    'b9bce0aeb8dff49dd070b7d7d38a4365a2769f69f41efdcc2c63764f99eaeb29',
  ],
  [
    'pbl-v3',
    4,
    'retain-study-project-assets',
    true,
    '7ea873bfa8467cdee69fa265661802fc4517323d0ea91cc5ecabea331a52549f',
  ],
  [
    'pbl-v3',
    5,
    'learning-evidence-and-reports',
    true,
    'de9e2193669d71579d6eb3eb2bade9b337e48c7866c94eac2b0bdf841c53ec6e',
  ],
  [
    'pbl-v3',
    6,
    'workspace-lifecycle',
    true,
    '489a1b92aac26796d92ccd2ba5d4329d4f6552566d0dde75f2ea309f90b0c3cc',
  ],
  [
    'pbl-v3',
    7,
    'teaching-turn-deadline',
    true,
    '39cf33b2c1b45853f7bde1ffb8152d8011570386c9a1d50e81b9d7cacbbdac9c',
  ],
  [
    'pbl-v3',
    8,
    'bounded-checkpoint-failure',
    true,
    '94c649267d2ea6b140ea15e093ea3d7e94ef28e2b47199cbbee6556a09051d2e',
  ],
];

/**
 * Stores no release provisions any more. A database may still record their
 * versions (the tables are left in place), so a new store must not take one
 * of these names: it would inherit those recorded versions.
 * - `classroom-generation-jobs`: the headless API's job table of pre-release
 *   builds, replaced by generation runs.
 */
const RETIRED_STORES: readonly string[] = ['classroom-generation-jobs'];

describe('shipped schema migrations', () => {
  it('reuse no retired store name', () => {
    for (const set of APP_SCHEMA_STORES) expect(RETIRED_STORES).not.toContain(set.store);
  });

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
