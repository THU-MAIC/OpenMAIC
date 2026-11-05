import { expect, it } from 'vitest';
import { readReportResponse } from '@/lib/pbl/v3/report-client';

const report = {
  studyId: 'study',
  project: { title: 'Project' },
  milestones: [],
  evidence: [],
  conversations: [],
  analysis: { status: 'generating', findings: [] },
};
it.each([
  new Response(null, { status: 524 }),
  new Response('<html>gateway</html>', { status: 502 }),
  new Response('{"studyId":', { status: 200 }),
  Response.json({}),
  Response.json({ ...report, studyId: 'other' }),
])(
  'handles empty, non-JSON, truncated and mismatched responses without exposing browser/provider diagnostics',
  async (response) => {
    await expect(readReportResponse(response, 'study')).rejects.toThrow(
      'PBL_REPORT_RESPONSE_UNAVAILABLE',
    );
  },
);
it('accepts a pending response and subsequent ready data', async () => {
  expect(await readReportResponse(Response.json(report, { status: 202 }), 'study')).toEqual(report);
  expect(
    (
      await readReportResponse(
        Response.json({ ...report, analysis: { status: 'ready', findings: [] } }),
        'study',
      )
    ).analysis?.status,
  ).toBe('ready');
});
it('preserves the structured wait-for-final-response guidance', async () => {
  await expect(
    readReportResponse(
      Response.json({ error: { reason: 'PBL_REPORT_PENDING' } }, { status: 409 }),
      'study',
    ),
  ).rejects.toMatchObject({ pendingFinal: true });
});
