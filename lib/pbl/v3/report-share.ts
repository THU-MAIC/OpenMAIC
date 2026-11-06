import { reportProjectResults, type LearningReport } from './report';

/** Shared image coordinates keep the preview's clickable invitation aligned with its artwork. */
export const reportShareLayout = {
  width: 1200,
  height: 1500,
  campaign: { x: 64, y: 1240, width: 1072, height: 196 },
} as const;

/** Campaign content supplied by the course team; never inferred from IDs or the current URL. */
export const reportShareCampaign = {
  url: '',
  // Set the fixed public introductory-course URL before enabling the promotion block.
  // No destination is inferred from the current page, course ID or learner record.
  backgrounds: { light: '', dark: '' },
};

/** Empty or invalid configuration omits promotion without blocking achievement export. */
export function reportShareDestination(value = reportShareCampaign.url): string | null {
  try {
    const url = new URL(value.trim());
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Decode for readability only when entering the printed URL preserves the destination. */
export function reportShareDisplayUrl(destination: string): string {
  try {
    const readable = decodeURI(destination);
    // Invisible/formatting characters cannot be reliably re-entered from an image.
    const visible = !/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{White_Space}]/u.test(
      readable,
    );
    return visible && new URL(readable).href === destination ? readable : destination;
  } catch {
    return destination;
  }
}

/** A deliberately small public projection. Never pass conversations, citations or quotes to a poster. */
export function reportShareContent(report: LearningReport) {
  const summary = report.summary;
  const metrics: (readonly [string, string])[] = [];
  for (const [key, completed, total] of [
    ['completedMilestones', summary?.completedMilestones, summary?.totalMilestones],
    ['completedSteps', summary?.completedSteps, summary?.totalSteps],
  ] as const) {
    if (Number.isFinite(completed) && Number.isFinite(total))
      metrics.push([key, `${completed}/${total}`]);
  }
  if (summary?.concepts?.length) metrics.push(['concepts', String(summary.concepts.length)]);
  const passed = report.outcomes?.filter((outcome) => outcome.tests === 'passed').length ?? 0;
  const tested = report.outcomes?.filter((outcome) => outcome.tests !== null).length ?? 0;
  return {
    title: report.project.title,
    completed: report.requiredComplete,
    metrics,
    results: reportProjectResults(report)
      .slice(0, 6)
      .map(({ title, goal, shareResult }) => shareResult ?? { title, description: goal ?? '' }),
    workflow: summary?.skills?.map(({ id }) => id) ?? [],
    concepts: summary?.concepts?.slice(0, 6) ?? [],
    verification: {
      passed,
      tested,
      quizScore: report.outcomes?.reduce((n, o) => n + (o.quiz?.score ?? 0), 0) ?? 0,
      quizTotal: report.outcomes?.reduce((n, o) => n + (o.quiz?.total ?? 0), 0) ?? 0,
      decisions: report.facts?.decisions,
    },
  };
}
export type ReportShareContent = ReturnType<typeof reportShareContent>;
export type ShareTheme = 'light' | 'dark';
