import { afterEach, expect, it, vi } from 'vitest';
import { configureOwnerAuthentication, singleUserAuthMethod } from '@/lib/server/identity';
import { resetOwnerAuthenticationForTests } from '@/lib/server/identity/registry';
import { chatGPTPlanAvailability } from '@/lib/server/chatgpt-plan/availability';

afterEach(() => {
  resetOwnerAuthenticationForTests();
  vi.unstubAllEnvs();
});

it('offers the plan when a host registers only its personal owner', () => {
  vi.stubEnv('OPENMAIC_CHATGPT_PLAN_ENABLED', 'true');
  vi.stubEnv('OWNER_SINGLE_USER', 'true');
  configureOwnerAuthentication({ methods: [singleUserAuthMethod()] });
  expect(chatGPTPlanAvailability()).toEqual({ available: true });
});

it('withholds the installation account when the host can authenticate additional owners', () => {
  vi.stubEnv('OPENMAIC_CHATGPT_PLAN_ENABLED', 'true');
  vi.stubEnv('OWNER_SINGLE_USER', 'true');
  configureOwnerAuthentication({
    methods: [
      { name: 'host-session', authenticate: async () => ({ status: 'not-applicable' }) },
      singleUserAuthMethod(),
    ],
  });
  expect(chatGPTPlanAvailability()).toEqual({
    available: false,
    reason: 'not-personal-installation',
  });
});
