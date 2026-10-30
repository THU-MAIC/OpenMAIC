import type { LearningReport } from './report';

export class ReportResponseError extends Error {
  constructor(readonly pendingFinal = false) {
    super('PBL_REPORT_RESPONSE_UNAVAILABLE');
  }
}

/** Gateways can return an empty 524 or an HTML error page instead of API JSON. */
export async function readReportResponse(
  response: Response,
  studyId: string,
): Promise<LearningReport> {
  let value: unknown;
  try {
    value = JSON.parse(await response.text());
  } catch {
    throw new ReportResponseError();
  }
  if (!response.ok) {
    const error =
      value && typeof value === 'object' && 'error' in value
        ? (value.error as { reason?: string })
        : undefined;
    throw new ReportResponseError(error?.reason === 'PBL_REPORT_PENDING');
  }
  if (!value || typeof value !== 'object') throw new ReportResponseError();
  const report = value as Partial<LearningReport>;
  if (
    report.studyId !== studyId ||
    !report.project ||
    !Array.isArray(report.milestones) ||
    !Array.isArray(report.evidence) ||
    !Array.isArray(report.conversations) ||
    (report.analysis &&
      (!['not_generated', 'generating', 'ready', 'failed'].includes(report.analysis.status) ||
        !Array.isArray(report.analysis.findings)))
  )
    throw new ReportResponseError();
  return report as LearningReport;
}
