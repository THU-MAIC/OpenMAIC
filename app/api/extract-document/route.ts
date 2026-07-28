import { NextRequest } from 'next/server';
import {
  isServerConfiguredProvider,
  resolvePDFApiKey,
  resolvePDFBaseUrl,
} from '@/lib/server/provider-config';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import {
  documentArtifactToParsedPdfContent,
  getDocumentExtractorProvider,
  selectDocumentExtractorProvider,
} from '@/lib/document';
import { normalizeDocumentMimeType } from '@/lib/document/mime';
import { fetchCourseMaterialFromStorage, MaterialFetchError } from '@/lib/server/course-asset-storage';
import { getServerSupabase } from '@/lib/supabase/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { MAX_PDF_CONTENT_CHARS } from '@/lib/constants/generation';

const log = createLogger('Extract Document');

function isPdfProviderId(providerId: string): providerId is PDFProviderId {
  return providerId in PDF_PROVIDERS;
}

function supportsMimeType(provider: { supportedMimeTypes: string[] }, mimeType: string): boolean {
  return provider.supportedMimeTypes.map((type) => type.toLowerCase()).includes(mimeType);
}

function isSelfHostedMinerUProvider(
  providerId: string,
): providerId is Extract<PDFProviderId, 'mineru'> {
  return providerId === 'mineru';
}

function requestedTypeLabel(mimeType: string): string {
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return 'DOCX';
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
    return 'PPTX';
  }
  return mimeType;
}

/**
 * POST /api/extract-document
 *
 * 两种请求模式:
 *   - 直传模式(content-type: multipart/form-data,带 file 字段):客户端先走 sign-upload
 *     直传失败/不可用时的回退路径,仍受 Vercel 4.5MB 限制。**保留向后兼容。**
 *   - path 模式(content-type: application/json,带 { courseId, path }):从 Supabase Storage
 *     服务端拉取,不受 4.5MB 限制。
 */
export async function POST(req: NextRequest) {
  let fileName: string | undefined;
  let resolvedProviderId: string | undefined;
  try {
    const contentType = req.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      // ── path 模式 ──
      // path 模式必须登录:任意 path 都可能指向 pending/{userId}/...,如果允许匿名
      // 调用,userId 比对形同虚设(无登录用户就没 userId 可传)。
      const session = await getServerSupabase();
      const { data: { user: sessionUser } } = await session.auth.getUser();
      if (!sessionUser) {
        return apiError('UNAUTHORIZED', 401, '请先登录后再使用 path 模式提取材料');
      }
      const callerUserId = sessionUser.id;

      const body = (await req.json()) as {
        courseId?: string;
        path?: string;
        providerId?: string;
        apiKey?: string;
        baseUrl?: string;
      };
      const { courseId, path, providerId, apiKey, baseUrl } = body;
      if (!courseId || !path) {
        return apiError('MISSING_REQUIRED_FIELD', 400, '请提供 courseId 和 path');
      }
      const effectiveProviderId = (providerId as PDFProviderId | undefined) || ('unpdf' as PDFProviderId);
      fileName = path.split('/').pop() || 'document';

      let material;
      try {
        material = await fetchCourseMaterialFromStorage(courseId, path, callerUserId);
      } catch (e) {
        if (e instanceof MaterialFetchError) {
          // pending 越权 → 403(不暴露路径存在性);其他 → 404
          if (e.code === 'FORBIDDEN') {
            return apiError('FORBIDDEN', 403, e.message);
          }
          if (e.code === 'UNAUTHORIZED') {
            return apiError('UNAUTHORIZED', 401, e.message);
          }
          return apiError('STORAGE_FETCH_FAILED', 404, e.message);
        }
        return apiError('STORAGE_FETCH_FAILED', 404, e instanceof Error ? e.message : '拉取文件失败');
      }
      fileName = material.fileName;
      const mimeType = normalizeDocumentMimeType({
        mimeType: material.contentType,
        fileName: material.fileName,
      });
      if (!mimeType) {
        return apiError('INVALID_REQUEST', 400, `不支持的课程材料类型:"${material.contentType}"`);
      }
      resolvedProviderId = effectiveProviderId;

      return await runExtraction({
        mimeType,
        buffer: material.buffer,
        fileName: material.fileName,
        fileSize: material.size,
        providerId: effectiveProviderId,
        apiKey,
        baseUrl,
        resolvedProviderIdHolder: { current: undefined },
      });
    }

    if (!contentType.includes('multipart/form-data')) {
      log.error('Invalid Content-Type for document upload:', contentType);
      return apiError(
        'INVALID_REQUEST',
        400,
        `Invalid Content-Type: expected multipart/form-data or application/json, got "${contentType}"`,
      );
    }

    // ── 直传模式(legacy,受 4.5MB 限制) ──
    const formData = await req.formData();
    const documentFile = (formData.get('file') || formData.get('pdf')) as File | null;
    const preferredProviderId = formData.get('providerId') as string | null;
    const apiKey = formData.get('apiKey') as string | null;
    const baseUrl = formData.get('baseUrl') as string | null;

    if (!documentFile) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'No course material file provided');
    }

    fileName = documentFile.name;
    const mimeType = normalizeDocumentMimeType({
      mimeType: documentFile.type,
      fileName: documentFile.name,
    });
    if (!mimeType) {
      return apiError('INVALID_REQUEST', 400, `Unsupported course material type for "${documentFile.name}"`);
    }

    let provider = preferredProviderId
      ? getDocumentExtractorProvider(preferredProviderId)
      : undefined;
    if (preferredProviderId && !provider) {
      return apiError('INVALID_REQUEST', 400, `Unknown document extractor provider: ${preferredProviderId}`);
    }
    if (provider && !supportsMimeType(provider, mimeType)) provider = undefined;

    try {
      provider = provider || selectDocumentExtractorProvider({ mimeType, requiredCapabilities: { text: true } });
    } catch (error) {
      return apiError(
        'INVALID_REQUEST',
        400,
        error instanceof Error ? error.message : `Unsupported course material type "${mimeType}"`,
      );
    }
    resolvedProviderId = provider.id;

    let managed = isPdfProviderId(provider.id) && isServerConfiguredProvider('pdf', provider.id);
    let clientBaseUrl = managed ? undefined : baseUrl || undefined;
    if (isSelfHostedMinerUProvider(provider.id) && !managed && !clientBaseUrl) {
      const cloudProvider = getDocumentExtractorProvider('mineru-cloud');
      const cloudManaged = isServerConfiguredProvider('pdf', 'mineru-cloud');
      const cloudApiKey = resolvePDFApiKey('mineru-cloud', cloudManaged ? undefined : apiKey || undefined);
      if (cloudProvider && supportsMimeType(cloudProvider, mimeType) && cloudApiKey) {
        provider = cloudProvider;
        managed = cloudManaged;
        clientBaseUrl = managed ? undefined : baseUrl || undefined;
        resolvedProviderId = provider.id;
      }
    }
    if (isSelfHostedMinerUProvider(provider.id) && !managed && !clientBaseUrl) {
      return apiError(
        'INVALID_REQUEST',
        422,
        `${requestedTypeLabel(mimeType)} extraction requires a configured MinerU document extractor. Configure a self-hosted MinerU base URL or a MinerU Cloud API key in PDF provider settings.`,
      );
    }
    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const config = {
      providerId: provider.id,
      apiKey: isPdfProviderId(provider.id)
        ? resolvePDFApiKey(provider.id, managed ? undefined : apiKey || undefined)
        : apiKey || undefined,
      baseUrl: isPdfProviderId(provider.id)
        ? resolvePDFBaseUrl(provider.id, clientBaseUrl)
        : clientBaseUrl,
    };

    const arrayBuffer = await documentFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const artifact = await provider.extract({
      buffer,
      fileName: documentFile.name,
      fileSize: documentFile.size,
      mimeType,
      config,
    });
    const result = documentArtifactToParsedPdfContent(artifact);
    return apiSuccess({
      data: trimAndWrap(result, documentFile.name, documentFile.size, mimeType, provider.id),
    });
  } catch (error) {
    log.error(
      `Document extraction failed [provider=${resolvedProviderId ?? 'unknown'}, file="${fileName ?? 'unknown'}"]:`,
      error,
    );
    return apiError('PARSE_FAILED', 500, error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * path 模式专用:解析 provider / 配置 / SSRF,然后 extract。
 * 服务端截断文本到 MAX_PDF_CONTENT_CHARS,确保响应体永远 < 4.5MB。
 */
async function runExtraction(opts: {
  mimeType: string;
  buffer: Buffer;
  fileName: string;
  fileSize: number;
  providerId: PDFProviderId;
  apiKey?: string;
  baseUrl?: string;
  resolvedProviderIdHolder: { current: PDFProviderId | undefined };
}): Promise<Response> {
  const { mimeType, buffer, fileName, fileSize, providerId, apiKey, baseUrl } = opts;

  let provider = getDocumentExtractorProvider(providerId);
  if (!provider || !supportsMimeType(provider, mimeType)) {
    try {
      provider = selectDocumentExtractorProvider({ mimeType, requiredCapabilities: { text: true } });
    } catch (error) {
      return apiError(
        'INVALID_REQUEST',
        400,
        error instanceof Error ? error.message : `Unsupported course material type "${mimeType}"`,
      );
    }
  }
  opts.resolvedProviderIdHolder.current = provider.id;

  let managed = isPdfProviderId(provider.id) && isServerConfiguredProvider('pdf', provider.id);
  let clientBaseUrl = managed ? undefined : baseUrl || undefined;
  if (isSelfHostedMinerUProvider(provider.id) && !managed && !clientBaseUrl) {
    const cloudProvider = getDocumentExtractorProvider('mineru-cloud');
    const cloudManaged = isServerConfiguredProvider('pdf', 'mineru-cloud');
    const cloudApiKey = resolvePDFApiKey('mineru-cloud', cloudManaged ? undefined : apiKey || undefined);
    if (cloudProvider && supportsMimeType(cloudProvider, mimeType) && cloudApiKey) {
      provider = cloudProvider;
      managed = cloudManaged;
      clientBaseUrl = managed ? undefined : baseUrl || undefined;
      opts.resolvedProviderIdHolder.current = provider.id;
    }
  }
  if (isSelfHostedMinerUProvider(provider.id) && !managed && !clientBaseUrl) {
    return apiError(
      'INVALID_REQUEST',
      422,
      `${requestedTypeLabel(mimeType)} extraction requires a configured MinerU document extractor.`,
    );
  }
  if (clientBaseUrl && process.env.NODE_ENV === 'production') {
    const ssrfError = await validateUrlForSSRF(clientBaseUrl);
    if (ssrfError) {
      return apiError('INVALID_URL', 403, ssrfError);
    }
  }

  const config = {
    providerId: provider.id,
    apiKey: isPdfProviderId(provider.id)
      ? resolvePDFApiKey(provider.id, managed ? undefined : apiKey || undefined)
      : apiKey || undefined,
    baseUrl: isPdfProviderId(provider.id)
      ? resolvePDFBaseUrl(provider.id, clientBaseUrl)
      : clientBaseUrl,
  };

  const artifact = await provider.extract({ buffer, fileName, fileSize, mimeType, config });
  const result = documentArtifactToParsedPdfContent(artifact);
  return apiSuccess({
    data: trimAndWrap(result, fileName, fileSize, mimeType, provider.id),
  });
}

function trimAndWrap(
  result: ReturnType<typeof documentArtifactToParsedPdfContent>,
  fileName: string,
  fileSize: number,
  mimeType: string,
  parserId: string,
): ParsedPdfContent {
  // 服务端截断到 MAX_PDF_CONTENT_CHARS,确保响应体永远 < 4.5MB(Vercel 限制)。
  // 客户端拿到后再做最终截断只用于本地展示,不再承担"防止 413"职责。
  const rawText = result.text || '';
  const text = rawText.length > MAX_PDF_CONTENT_CHARS ? rawText.substring(0, MAX_PDF_CONTENT_CHARS) : rawText;
  return {
    ...result,
    text,
    metadata: {
      ...result.metadata,
      pageCount: result.metadata?.pageCount ?? 0,
      fileName,
      fileSize,
      mimeType,
      parser: result.metadata?.parser ?? parserId,
    },
  };
}