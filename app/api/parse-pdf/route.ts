import { NextRequest } from 'next/server';
import {
  isServerConfiguredProvider,
  resolvePDFApiKey,
  resolvePDFBaseUrl,
} from '@/lib/server/provider-config';
import type { PDFProviderId } from '@/lib/pdf/types';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { documentArtifactToParsedPdfContent, extractDocument } from '@/lib/document';
import { fetchCourseMaterialFromStorage, MaterialFetchError } from '@/lib/server/course-asset-storage';
import { getServerSupabase } from '@/lib/supabase/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { MAX_PDF_CONTENT_CHARS } from '@/lib/constants/generation';

const log = createLogger('Parse PDF');

/**
 * POST /api/parse-pdf
 *
 * 两种模式:
 *   - 直传模式(multipart,带 pdf 字段):legacy / 回退路径,受 4.5MB 限制
 *   - path 模式(application/json,带 { courseId, path }):从 Supabase Storage 拉取,不受限
 */
export async function POST(req: NextRequest) {
  let pdfFileName: string | undefined;
  let resolvedProviderId: string | undefined;
  try {
    const contentType = req.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const session = await getServerSupabase();
      const { data: { user: sessionUser } } = await session.auth.getUser();
      if (!sessionUser) {
        return apiError('UNAUTHORIZED', 401, '请先登录后再使用 path 模式解析 PDF');
      }
      const callerUserId = sessionUser.id;

      const body = (await req.json()) as {
        courseId?: string;
        path?: string;
        providerId?: PDFProviderId;
        apiKey?: string;
        baseUrl?: string;
      };
      const { courseId, path, providerId, apiKey, baseUrl } = body;
      if (!courseId || !path) {
        return apiError('MISSING_REQUIRED_FIELD', 400, '请提供 courseId 和 path');
      }
      const effectiveProviderId = providerId || ('unpdf' as PDFProviderId);
      pdfFileName = path.split('/').pop() || 'document';

      let material;
      try {
        material = await fetchCourseMaterialFromStorage(courseId, path, callerUserId);
      } catch (e) {
        if (e instanceof MaterialFetchError) {
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
      pdfFileName = material.fileName;

      const managed = isServerConfiguredProvider('pdf', effectiveProviderId);
      const clientBaseUrl = managed ? undefined : baseUrl || undefined;
      if (clientBaseUrl && process.env.NODE_ENV === 'production') {
        const ssrfError = await validateUrlForSSRF(clientBaseUrl);
        if (ssrfError) {
          return apiError('INVALID_URL', 403, ssrfError);
        }
      }

      const config = {
        providerId: effectiveProviderId,
        apiKey: resolvePDFApiKey(effectiveProviderId, managed ? undefined : apiKey || undefined),
        baseUrl: resolvePDFBaseUrl(effectiveProviderId, clientBaseUrl),
      };

      const artifact = await extractDocument({
        buffer: material.buffer,
        fileName: material.fileName,
        fileSize: material.size,
        mimeType: 'application/pdf',
        config,
      });
      const result = documentArtifactToParsedPdfContent(artifact);
      const rawText = result.text || '';
      const text = rawText.length > MAX_PDF_CONTENT_CHARS ? rawText.substring(0, MAX_PDF_CONTENT_CHARS) : rawText;
      const resultWithMetadata: ParsedPdfContent = {
        ...result,
        text,
        metadata: {
          ...result.metadata,
          pageCount: result.metadata?.pageCount ?? 0,
          fileName: material.fileName,
          fileSize: material.size,
        },
      };
      return apiSuccess({ data: resultWithMetadata });
    }

    if (!contentType.includes('multipart/form-data')) {
      log.error('Invalid Content-Type for PDF upload:', contentType);
      return apiError(
        'INVALID_REQUEST',
        400,
        `Invalid Content-Type: expected multipart/form-data, got "${contentType}"`,
      );
    }

    // ── 直传模式(legacy,受 4.5MB 限制) ──
    const formData = await req.formData();
    const pdfFile = formData.get('pdf') as File | null;
    const providerId = formData.get('providerId') as PDFProviderId | null;
    const apiKey = formData.get('apiKey') as string | null;
    const baseUrl = formData.get('baseUrl') as string | null;

    if (!pdfFile) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'No PDF file provided');
    }

    const effectiveProviderId = providerId || ('unpdf' as PDFProviderId);
    pdfFileName = pdfFile?.name;
    resolvedProviderId = effectiveProviderId;

    const managed = isServerConfiguredProvider('pdf', effectiveProviderId);
    const clientBaseUrl = managed ? undefined : baseUrl || undefined;
    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const config = {
      providerId: effectiveProviderId,
      apiKey: resolvePDFApiKey(effectiveProviderId, managed ? undefined : apiKey || undefined),
      baseUrl: resolvePDFBaseUrl(effectiveProviderId, clientBaseUrl),
    };

    const arrayBuffer = await pdfFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const artifact = await extractDocument({
      buffer,
      fileName: pdfFile.name,
      fileSize: pdfFile.size,
      mimeType: 'application/pdf',
      config,
    });
    const result = documentArtifactToParsedPdfContent(artifact);

    const rawText = result.text || '';
    const text = rawText.length > MAX_PDF_CONTENT_CHARS ? rawText.substring(0, MAX_PDF_CONTENT_CHARS) : rawText;
    const resultWithMetadata: ParsedPdfContent = {
      ...result,
      text,
      metadata: {
        ...result.metadata,
        pageCount: result.metadata?.pageCount ?? 0,
        fileName: pdfFile.name,
        fileSize: pdfFile.size,
      },
    };

    return apiSuccess({ data: resultWithMetadata });
  } catch (error) {
    log.error(
      `PDF parsing failed [provider=${resolvedProviderId ?? 'unknown'}, file="${pdfFileName ?? 'unknown'}"]:`,
      error,
    );
    return apiError('PARSE_FAILED', 500, error instanceof Error ? error.message : 'Unknown error');
  }
}