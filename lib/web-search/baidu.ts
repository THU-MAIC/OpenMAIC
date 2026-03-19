/**
 * Baidu Unified Search Integration
 *
 * Aggregates search results from three Baidu services:
 * 1. Web Search — Qianfan AI Search API (general web results)
 * 2. Baike      — Baidu Baike API (encyclopedia entries)
 * 3. Scholar    — Baidu Scholar API (academic papers)
 *
 * All share the same BAIDU_API_KEY (Bearer token).
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';
import { createLogger } from '@/lib/logger';
import { normalizeWebSearchQuery } from './utils';

const log = createLogger('BaiduSearch');

// ── API Endpoints ──────────────────────────────────────────────
const BAIDU_WEB_SEARCH_URL = 'https://qianfan.baidubce.com/v2/ai_search/web_search';
const BAIDU_BAIKE_URL = 'https://appbuilder.baidu.com/v2/baike/lemma/get_content';
const BAIDU_SCHOLAR_URL = 'https://qianfan.baidubce.com/v2/tools/baidu_scholar/search';

// ── Common Auth Headers ────────────────────────────────────────
function baiduHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'X-Appbuilder-From': 'openclaw',
    'Content-Type': 'application/json',
  };
}

// ── Response Types ─────────────────────────────────────────────
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
  url?: string;
  publishYear?: string;
  keyword?: string;
}

interface BaiduScholarResponse {
  code?: number;
  message?: string;
  results?: BaiduScholarPaper[];
}

// ── Individual Source Fetchers ──────────────────────────────────

/** 1. Baidu Web Search */
async function fetchWebSearch(
  query: string,
  apiKey: string,
  maxResults: number,
): Promise<WebSearchSource[]> {
  try {
    const res = await proxyFetch(BAIDU_WEB_SEARCH_URL, {
      method: 'POST',
      headers: baiduHeaders(apiKey),
      body: JSON.stringify({
        messages: [{ content: query, role: 'user' }],
        search_source: 'baidu_search_v2',
        resource_type_filter: [{ type: 'web', top_k: maxResults }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log.warn(`[Baidu Web] HTTP ${res.status}: ${errText}`);
      return [];
    }

    const data = (await res.json()) as BaiduWebResponse;
    if (data.code) {
      log.warn(`[Baidu Web] API error ${data.code}: ${data.message}`);
      return [];
    }

    return (data.references || []).map((ref, i) => ({
      title: ref.title || ref.site_name || '',
      url: ref.url || '',
      content: ref.content || '',
      score: 0.9 - i * 0.05,
    }));
  } catch (err) {
    log.warn('[Baidu Web] Failed:', err);
    return [];
  }
}

/** 2. Baidu Baike (encyclopedia) */
async function fetchBaike(query: string, apiKey: string): Promise<WebSearchSource[]> {
  try {
    const url = `${BAIDU_BAIKE_URL}?search_type=lemmaTitle&search_key=${encodeURIComponent(query)}`;
    const res = await proxyFetch(url, {
      method: 'GET',
      headers: baiduHeaders(apiKey),
    });

    if (!res.ok) return [];

    const data = (await res.json()) as BaiduBaikeResponse;
    if (data.errno && data.errno !== 0) return [];
    if (!data.result) return [];

    const r = data.result;
    return [
      {
        title: `📖 ${r.lemma_title || query} — 百度百科`,
        url: r.lemma_url || `https://baike.baidu.com/item/${encodeURIComponent(query)}`,
        content: r.abstract_text || r.lemma_desc || '',
        score: 0.95, // High relevance — authoritative source
      },
    ];
  } catch (err) {
    log.warn('[Baidu Baike] Failed:', err);
    return [];
  }
}

/** 3. Baidu Scholar (academic papers) */
async function fetchScholar(
  query: string,
  apiKey: string,
  maxResults: number,
): Promise<WebSearchSource[]> {
  try {
    const url = `${BAIDU_SCHOLAR_URL}?wd=${encodeURIComponent(query)}&pageNum=0&enable_abstract=true`;
    const res = await proxyFetch(url, {
      method: 'GET',
      headers: baiduHeaders(apiKey),
    });

    if (!res.ok) return [];

    const data = (await res.json()) as BaiduScholarResponse;
    if (data.code) return [];

    return (data.results || []).slice(0, maxResults).map((paper, i) => ({
      title: `🔬 ${paper.title || ''}`,
      url: paper.url || '',
      content: [
        paper.abstract || '',
        paper.publishYear ? `(${paper.publishYear})` : '',
        paper.keyword ? `Keywords: ${paper.keyword}` : '',
      ]
        .filter(Boolean)
        .join(' '),
      score: 0.85 - i * 0.05,
    }));
  } catch (err) {
    log.warn('[Baidu Scholar] Failed:', err);
    return [];
  }
}

// ── Main Entry Point ───────────────────────────────────────────

/**
 * Unified Baidu Search — aggregates results from Web, Baike, and Scholar.
 * Sources are fetched in parallel for speed. Individual failures are
 * swallowed so the overall search still returns partial results.
 */
export async function searchWithBaidu(params: {
  query: string;
  apiKey: string;
  maxResults?: number;
  subSources?: { webSearch?: boolean; baike?: boolean; scholar?: boolean };
}): Promise<WebSearchResult> {
  const { query: rawQuery, apiKey, maxResults = 10 } = params;
  const query = normalizeWebSearchQuery(rawQuery);
  const sub = {
    webSearch: params.subSources?.webSearch ?? true,
    baike: params.subSources?.baike ?? true,
    scholar: params.subSources?.scholar ?? true,
  };

  const startTime = Date.now();

  // Fire enabled sources in parallel
  const [webResults, baikeResults, scholarResults] = await Promise.all([
    sub.webSearch ? fetchWebSearch(query, apiKey, maxResults) : Promise.resolve([]),
    sub.baike ? fetchBaike(query, apiKey) : Promise.resolve([]),
    sub.scholar ? fetchScholar(query, apiKey, 3) : Promise.resolve([]),
  ]);

  const responseTime = (Date.now() - startTime) / 1000;

  // Merge: Baike first (authoritative), then web, then scholar
  const allSources = [...baikeResults, ...webResults, ...scholarResults];

  // De-duplicate by URL
  const seen = new Set<string>();
  const sources = allSources.filter((s) => {
    if (!s.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  return {
    answer: '',
    sources,
    query,
    responseTime,
  };
}
