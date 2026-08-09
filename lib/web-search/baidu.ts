/**
 * Baidu unified search integration.
 *
 * Aggregates the Qianfan web search API, Baidu Baike, and Baidu Scholar behind
 * one provider while allowing each sub-source to be toggled independently.
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import { createLogger } from '@/lib/logger';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';
import type { BaiduSubSources } from './types';
import { normalizeWebSearchQuery } from './utils';

const log = createLogger('BaiduSearch');

const BAIDU_QIANFAN_BASE_URL = 'https://qianfan.baidubce.com';
const BAIDU_BAIKE_BASE_URL = 'https://appbuilder.baidu.com';

const BAIDU_WEB_SEARCH_PATH = '/v2/ai_search/web_search';
const BAIDU_BAIKE_PATH = '/v2/baike/lemma/get_content';
const BAIDU_SCHOLAR_PATH = '/v2/tools/baidu_scholar/search';

function baiduHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'X-Appbuilder-From': 'openmaic',
    'Content-Type': 'application/json',
  };
}

function buildQianfanUrl(path: string, baseUrl?: string): string {
  return `${(baseUrl || BAIDU_QIANFAN_BASE_URL).replace(/\/+$/, '')}${path}`;
}

function buildBaikeUrl(query: string): string {
  const url = new URL(`${BAIDU_BAIKE_BASE_URL}${BAIDU_BAIKE_PATH}`);
  url.searchParams.set('search_type', 'lemmaTitle');
  url.searchParams.set('search_key', query);
  return url.toString();
}

function buildScholarUrl(query: string, baseUrl?: string): string {
  const url = new URL(buildQianfanUrl(BAIDU_SCHOLAR_PATH, baseUrl));
  url.searchParams.set('wd', query);
  url.searchParams.set('pageNum', '0');
  url.searchParams.set('enable_ai_abstract', 'true');
  return url.toString();
}

function normalizeSubSources(subSources?: Partial<BaiduSubSources>): BaiduSubSources {
  return {
    webSearch: subSources?.webSearch ?? true,
    baike: subSources?.baike ?? true,
    scholar: subSources?.scholar ?? true,
  };
}

async function fetchWebSearch(
  query: string,
  apiKey: string,
  maxResults: number,
  baseUrl?: string,
): Promise<WebSearchSource[]> {
  try {
    const res = await proxyFetch(buildQianfanUrl(BAIDU_WEB_SEARCH_PATH, baseUrl), {
      method: 'POST',
      headers: baiduHeaders(apiKey),
      body: JSON.stringify({
        messages: [{ content: query, role: 'user' }],
        search_source: 'baidu_search_v2',
        resource_type_filter: [{ type: 'web', top_k: maxResults }],
      }),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      log.warn(`[Baidu Web] HTTP ${res.status}: ${errorText || res.statusText}`);
      return [];
    }

    const data = (await res.json()) as BaiduWebResponse;
    if (data.code && data.code !== 0) {
      log.warn(`[Baidu Web] API error ${data.code}: ${data.message || 'Request failed'}`);
      return [];
    }

    return (data.references || [])
      .filter((ref) => ref.url)
      .slice(0, maxResults)
      .map((ref, index) => ({
        title: ref.title || ref.site_name || ref.url || '',
        url: ref.url || '',
        content: ref.content || '',
        score: Number((0.9 - index * 0.05).toFixed(2)),
      }));
  } catch (error) {
    log.warn('[Baidu Web] Failed:', error);
    return [];
  }
}

async function fetchBaike(query: string, apiKey: string): Promise<WebSearchSource[]> {
  try {
    const res = await proxyFetch(buildBaikeUrl(query), {
      method: 'GET',
      headers: baiduHeaders(apiKey),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      log.warn(`[Baidu Baike] HTTP ${res.status}: ${errorText || res.statusText}`);
      return [];
    }

    const data = (await res.json()) as BaiduBaikeResponse;
    if ((data.errno !== undefined && data.errno !== 0) || !data.result) return [];

    const result = data.result;
    const title = result.lemma_title || query;
    return [
      {
        title: `${title} - Baidu Baike`,
        url: result.lemma_url || `https://baike.baidu.com/item/${encodeURIComponent(query)}`,
        content: result.abstract_text || result.lemma_desc || '',
        score: 0.95,
      },
    ];
  } catch (error) {
    log.warn('[Baidu Baike] Failed:', error);
    return [];
  }
}

async function fetchScholar(
  query: string,
  apiKey: string,
  maxResults: number,
  baseUrl?: string,
): Promise<WebSearchSource[]> {
  try {
    const res = await proxyFetch(buildScholarUrl(query, baseUrl), {
      method: 'GET',
      headers: baiduHeaders(apiKey),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      log.warn(`[Baidu Scholar] HTTP ${res.status}: ${errorText || res.statusText}`);
      return [];
    }

    const data = (await res.json()) as BaiduScholarResponse;
    if (data.code && data.code !== '0') return [];

    return (data.data || [])
      .filter((paper) => paper.url)
      .slice(0, maxResults)
      .map((paper, index) => ({
        title: paper.title || paper.url || '',
        url: paper.url || '',
        content: [
          paper.abstract,
          paper.aiAbstract,
          paper.publishYear ? `(${paper.publishYear})` : '',
          paper.keyword,
        ]
          .filter(Boolean)
          .join(' '),
        score: Number((0.85 - index * 0.05).toFixed(2)),
      }));
  } catch (error) {
    log.warn('[Baidu Scholar] Failed:', error);
    return [];
  }
}

export async function searchWithBaidu(params: {
  query: string;
  apiKey: string;
  maxResults?: number;
  baseUrl?: string;
  subSources?: Partial<BaiduSubSources>;
}): Promise<WebSearchResult> {
  const { query: rawQuery, apiKey, maxResults = 10, baseUrl } = params;
  if (!apiKey) throw new Error('Baidu API key is required');

  const query = normalizeWebSearchQuery(rawQuery);
  const subSources = normalizeSubSources(params.subSources);
  const startedAt = Date.now();

  const [webResults, baikeResults, scholarResults] = await Promise.all([
    subSources.webSearch ? fetchWebSearch(query, apiKey, maxResults, baseUrl) : Promise.resolve([]),
    subSources.baike ? fetchBaike(query, apiKey) : Promise.resolve([]),
    subSources.scholar ? fetchScholar(query, apiKey, 3, baseUrl) : Promise.resolve([]),
  ]);

  const seen = new Set<string>();
  const sources = [...baikeResults, ...webResults, ...scholarResults].filter((source) => {
    if (!source.url || seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });

  return {
    answer: '',
    sources,
    query,
    responseTime: (Date.now() - startedAt) / 1000,
  };
}

interface BaiduWebReference {
  title?: string;
  url?: string;
  site_name?: string;
  content?: string;
}

interface BaiduWebResponse {
  code?: number;
  message?: string;
  references?: BaiduWebReference[];
}

interface BaiduBaikeResult {
  lemma_title?: string;
  lemma_desc?: string;
  lemma_url?: string;
  abstract_text?: string;
}

interface BaiduBaikeResponse {
  errno?: number;
  errmsg?: string;
  result?: BaiduBaikeResult;
}

interface BaiduScholarPaper {
  title?: string;
  abstract?: string;
  aiAbstract?: string;
  url?: string;
  publishYear?: number;
  keyword?: string;
  doi?: string;
  paperId?: string;
  publishInfo?: { journalName?: string };
}

interface BaiduScholarResponse {
  code?: string;
  message?: string;
  requestId?: string;
  hasMore?: boolean;
  data?: BaiduScholarPaper[];
}
