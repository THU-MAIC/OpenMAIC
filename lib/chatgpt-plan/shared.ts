import type { AccountModel } from '@/lib/model-settings/account-models';
import type en from '@/lib/i18n/locales/en-US.json';

/**
 * ChatGPT plan provider (preview): what the browser and the server share.
 * The server side lives in `lib/server/chatgpt-plan`.
 */

/** The provider's registry id (`lib/ai/providers.ts`). */
export const CHATGPT_PLAN_PROVIDER_ID = 'chatgpt-plan';

/** Where the user reviews this app's usage limit or disconnects it in ChatGPT. */
export const CHATGPT_USAGE_SETTINGS_URL = 'https://chatgpt.com/settings/usage';

/**
 * The OAuth redirect path. A client registered with it keeps it: only the port
 * of the loopback redirect may change between sign-ins.
 */
export const CHATGPT_PLAN_CALLBACK_PATH = '/auth/callback';

export const CHATGPT_PLAN_API = {
  status: '/api/chatgpt-plan/status',
  signIn: '/api/chatgpt-plan/sign-in',
  callback: '/api/chatgpt-plan/callback',
  notice: '/api/chatgpt-plan/notice',
  attempt: '/api/chatgpt-plan/attempt',
  forget: '/api/chatgpt-plan/forget-registration',
  disconnect: '/api/chatgpt-plan/disconnect',
  models: '/api/chatgpt-plan/models',
} as const;

/** Why the provider cannot be offered here. */
export type ChatGPTPlanUnavailableReason = 'disabled' | 'not-personal-installation';

/**
 * - `disconnected`: no account is connected.
 * - `connected`: an account is connected and allowed plan usage.
 * - `sharing-disabled`: signed in, but plan usage was not allowed on the
 *   consent screen; signing in again offers it.
 * - `reauth-required`: the connection expired or was revoked in ChatGPT.
 */
export type ChatGPTPlanConnectionState =
  | 'disconnected'
  | 'connected'
  | 'sharing-disabled'
  | 'reauth-required';

export interface ChatGPTPlanStatus {
  available: boolean;
  reason?: ChatGPTPlanUnavailableReason;
  state: ChatGPTPlanConnectionState;
  /** The verified account email, when ChatGPT returned one. */
  email?: string;
  /** Whether the one-time notice about plan usage was acknowledged. */
  noticeAcknowledged: boolean;
  /** A disconnected registration the owner may explicitly forget. */
  canForgetRegistration?: true;
}

/** The result of one sign-in, including retries that leave the connection unchanged. */
export type ChatGPTPlanAttemptOutcome =
  | 'pending'
  | 'connected'
  | 'sharing-disabled'
  | 'sign-in-expired'
  | 'sign-in-denied'
  | 'account-mismatch'
  | 'sign-in-failed'
  | 'invalid-callback';

export type ChatGPTPlanMessageKey = keyof typeof en.settings.chatgptPlan;

/** Localized connection messages shared by settings and the loopback callback page. */
export const CHATGPT_PLAN_ERROR_KEYS: Partial<Record<string, ChatGPTPlanMessageKey>> = {
  'sign-in-expired': 'errorExpired',
  'sign-in-denied': 'errorDenied',
  'account-mismatch': 'errorAccountMismatch',
  'invalid-callback': 'errorInvalidCallback',
  'sign-in-failed': 'errorFailed',
  'sharing-disabled': 'sharingDisabled',
  'reauth-required': 'reauthRequired',
  'not-connected': 'connectInSettings',
  upstream: 'errorFailed',
};

/**
 * A loopback sign-in completes on this server's own `127.0.0.1` callback.
 * A remote server waits for the user to paste the redirect URL.
 */
export interface ChatGPTPlanSignInStart {
  /** Settings can check or cancel this attempt without sending OAuth state. */
  attemptId: string;
  authorizationUrl: string;
  flow: 'loopback' | 'paste';
  /** Epoch ms after which the pending sign-in is discarded. */
  expiresAt: number;
}

export type ChatGPTPlanModel = AccountModel;
