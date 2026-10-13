import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deriveGiteaUsername,
  embedCloneCredentials,
  LEARNER_REPO_NAME,
  provisionLearnerRepo,
} from '@/lib/pbl/v2/git-bridge/provision';
import {
  createAccessToken,
  createFork,
  createUser,
  createWebhook,
  getRepo,
  getUser,
} from '@/lib/pbl/v2/git-bridge/gitea-client';
import type { GiteaConfig, GiteaRepo } from '@/lib/pbl/v2/git-bridge/types';

vi.mock('@/lib/pbl/v2/git-bridge/gitea-client', () => ({
  createAccessToken: vi.fn(),
  createFork: vi.fn(),
  createUser: vi.fn(),
  createWebhook: vi.fn(),
  getRepo: vi.fn(),
  getUser: vi.fn(),
}));

const config: GiteaConfig = {
  baseUrl: 'http://gitea.local:3000',
  token: 'admin-token',
  templateFullName: 'goking/arkts-pbl-template',
  webhookSecret: 'webhook-secret',
  webhookUrl: 'http://openmaic.local:3001/api/pbl/v2/git/webhook',
};

const OWNER_ID = 'anon:abc';
const STAGE_ID = 'stage-A';
const username = deriveGiteaUsername(OWNER_ID, STAGE_ID);

const fork: GiteaRepo = {
  id: 1,
  full_name: `${username}/${LEARNER_REPO_NAME}`,
  clone_url: `http://gitea.local:3000/${username}/${LEARNER_REPO_NAME}.git`,
  html_url: `http://gitea.local:3000/${username}/${LEARNER_REPO_NAME}`,
};

describe('deriveGiteaUsername', () => {
  it('mints a stable stu-<owner8>-<stage8> service account per (learner, project)', () => {
    const name = deriveGiteaUsername('anon:00000000-0000-4000-8000-000000000000', 'stage-0');
    expect(name).toMatch(/^stu-[0-9a-f]{8}-[0-9a-f]{8}$/);
    expect(deriveGiteaUsername('same-owner', 'same-stage')).toBe(
      deriveGiteaUsername('same-owner', 'same-stage'),
    );
  });

  it('gives one learner a distinct account per project', () => {
    expect(deriveGiteaUsername('owner', 'stage-1')).not.toBe(
      deriveGiteaUsername('owner', 'stage-2'),
    );
  });

  it('gives two learners distinct accounts even for the same project', () => {
    expect(deriveGiteaUsername('owner-a', 'stage-1')).not.toBe(
      deriveGiteaUsername('owner-b', 'stage-1'),
    );
  });
});

describe('embedCloneCredentials', () => {
  it('embeds username:token into an http(s) clone URL', () => {
    expect(embedCloneCredentials('http://gitea.local/u/repo.git', 'stu', 'tok')).toBe(
      'http://stu:tok@gitea.local/u/repo.git',
    );
  });

  it('leaves non-http(s) URLs unchanged', () => {
    expect(embedCloneCredentials('git@host:u/repo.git', 'stu', 'tok')).toBe('git@host:u/repo.git');
  });
});

describe('provisionLearnerRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates account + fork + webhook and returns a credentialed clone URL', async () => {
    vi.mocked(getUser).mockResolvedValue(undefined);
    vi.mocked(createUser).mockResolvedValue({ id: 7, login: username });
    vi.mocked(createAccessToken).mockResolvedValue({ token: 'learner-token', lastEight: 'en' });
    vi.mocked(getRepo).mockResolvedValue(undefined);
    vi.mocked(createFork).mockResolvedValue(fork);

    const result = await provisionLearnerRepo({ config, ownerId: OWNER_ID, stageId: STAGE_ID });

    expect(createUser).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createUser).mock.calls[0]![1].username).toBe(username);
    // The fork runs under the learner's own token (Gitea forks into the caller),
    // and always takes the readable template name under the per-project account.
    expect(vi.mocked(createFork).mock.calls[0]![0].token).toBe('learner-token');
    expect(vi.mocked(createFork).mock.calls[0]![1]).toEqual({ name: LEARNER_REPO_NAME });
    expect(createWebhook).toHaveBeenCalledTimes(1);
    expect(result.giteaUsername).toBe(username);
    expect(result.repoFullName).toBe(`${username}/${LEARNER_REPO_NAME}`);
    expect(result.cloneUrl).toContain('learner-token');
    expect(result.token).toBe('learner-token');
  });

  it('reuses an existing account and fork without re-creating them', async () => {
    vi.mocked(getUser).mockResolvedValue({ id: 7, login: username });
    vi.mocked(createAccessToken).mockResolvedValue({ token: 'learner-token', lastEight: 'en' });
    vi.mocked(getRepo).mockResolvedValue(fork);

    await provisionLearnerRepo({ config, ownerId: OWNER_ID, stageId: STAGE_ID });

    expect(createUser).not.toHaveBeenCalled();
    expect(createFork).not.toHaveBeenCalled();
  });

  it('skips webhook registration when no webhook URL is configured', async () => {
    vi.mocked(getUser).mockResolvedValue({ id: 7, login: username });
    vi.mocked(createAccessToken).mockResolvedValue({ token: 'learner-token', lastEight: 'en' });
    vi.mocked(getRepo).mockResolvedValue(fork);

    await provisionLearnerRepo({
      config: { ...config, webhookUrl: undefined },
      ownerId: 'a',
      stageId: 'a',
    });

    expect(createWebhook).not.toHaveBeenCalled();
  });

  it('provisions a distinct account + fork for each of the learner’s projects', async () => {
    // Regression: Gitea allows one fork of a source repo per user, so two
    // projects for one learner must resolve to two distinct accounts (both
    // still fork the same readable repo name).
    const createdUsernames: string[] = [];
    vi.mocked(getUser).mockResolvedValue(undefined);
    vi.mocked(createUser).mockImplementation(async (_config, input) => {
      createdUsernames.push(input.username);
      return { id: 1, login: input.username };
    });
    vi.mocked(createAccessToken).mockResolvedValue({ token: 'learner-token', lastEight: 'en' });
    vi.mocked(getRepo).mockResolvedValue(undefined);
    vi.mocked(createFork).mockImplementation(async () => {
      const name = createdUsernames.at(-1)!;
      return {
        id: 1,
        full_name: `${name}/${LEARNER_REPO_NAME}`,
        clone_url: `http://gitea.local:3000/${name}/${LEARNER_REPO_NAME}.git`,
        html_url: `http://gitea.local:3000/${name}/${LEARNER_REPO_NAME}`,
      };
    });

    const first = await provisionLearnerRepo({ config, ownerId: OWNER_ID, stageId: 'stage-1' });
    const second = await provisionLearnerRepo({ config, ownerId: OWNER_ID, stageId: 'stage-2' });

    const u1 = deriveGiteaUsername(OWNER_ID, 'stage-1');
    const u2 = deriveGiteaUsername(OWNER_ID, 'stage-2');
    expect(u1).not.toBe(u2);
    expect(createdUsernames).toEqual([u1, u2]);
    expect(vi.mocked(createFork).mock.calls[0]![1]).toEqual({ name: LEARNER_REPO_NAME });
    expect(vi.mocked(createFork).mock.calls[1]![1]).toEqual({ name: LEARNER_REPO_NAME });
    expect(first.repoFullName).toBe(`${u1}/${LEARNER_REPO_NAME}`);
    expect(second.repoFullName).toBe(`${u2}/${LEARNER_REPO_NAME}`);
  });
});
