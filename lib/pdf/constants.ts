/**
 * PDF Provider Constants
 * Separated from pdf-providers.ts to avoid importing sharp in client components
 */

import type { PDFProviderId, PDFProviderConfig } from './types';

export const MINERU_CLOUD_DEFAULT_BASE = 'https://mineru.net/api/v4';
export const ALIDOCMIND_DEFAULT_BASE = 'https://docmind-api.cn-hangzhou.aliyuncs.com';
/**
 * The hosted MiniCPM-OCR document parsing API. A self-hosted MiniCPM-OCR web
 * demo serves the same job routes under `/api`, so the base URL stays
 * configurable (`PDF_MINICPM_OCR_BASE_URL` or openmaic.yml `baseUrl`).
 */
export const MINICPM_OCR_DEFAULT_BASE = 'https://api.modelbest.cn/v1';

/**
 * PDF Provider Registry
 */
export const PDF_PROVIDERS: Record<PDFProviderId, PDFProviderConfig> = {
  unpdf: {
    id: 'unpdf',
    name: 'unpdf',
    requiresApiKey: false,
    icon: '/logos/unpdf.svg',
    features: ['text', 'images', 'metadata'],
    legacyEnv: { prefix: 'PDF_UNPDF' },
  },

  mineru: {
    id: 'mineru',
    name: 'MinerU',
    requiresApiKey: false,
    icon: '/logos/mineru.png',
    features: ['text', 'images', 'tables', 'formulas', 'layout-analysis'],
    legacyEnv: { prefix: 'PDF_MINERU' },
  },

  'mineru-cloud': {
    id: 'mineru-cloud',
    name: 'MinerU (Cloud)',
    requiresApiKey: true,
    icon: '/logos/mineru.png',
    features: ['text', 'images', 'tables', 'formulas', 'layout-analysis'],
    legacyEnv: { prefix: 'PDF_MINERU_CLOUD', baseUrlOptional: true },
  },

  alidocmind: {
    id: 'alidocmind',
    name: 'AliDocMind',
    requiresApiKey: true,
    requiresCredentials: true,
    icon: '/logos/aliyun.svg',
    features: ['text', 'images', 'tables', 'formulas', 'layout-analysis', 'ocr'],
  },

  'minicpm-ocr': {
    id: 'minicpm-ocr',
    name: 'MiniCPM-OCR',
    requiresApiKey: true,
    baseUrl: MINICPM_OCR_DEFAULT_BASE,
    icon: '/logos/minicpm-ocr.png',
    features: ['text', 'tables', 'formulas', 'layout-analysis', 'ocr'],
    // The hosted API needs a key; a self-hosted web demo usually does not.
    apiKeyOptionalWithBaseUrl: true,
    legacyEnv: { prefix: 'PDF_MINICPM_OCR', baseUrlOptional: true, keyless: true },
  },
};

/**
 * Get all available PDF providers
 */
export function getAllPDFProviders(): PDFProviderConfig[] {
  return Object.values(PDF_PROVIDERS);
}

/**
 * Get PDF provider by ID
 */
export function getPDFProvider(providerId: PDFProviderId): PDFProviderConfig | undefined {
  return PDF_PROVIDERS[providerId];
}
