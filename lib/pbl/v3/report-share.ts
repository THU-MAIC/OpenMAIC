import type { LearningReport } from './report';

/** Campaign content supplied by the course team; never inferred from IDs or the current URL. */
export const reportShareCampaign = {
  url: '',
  // Replace decorative assets here when the campaign design is delivered.
  backgrounds: { light: '', dark: '' },
};

/** A deliberately small public projection. Never pass conversations, citations or quotes to a poster. */
export function reportShareContent(report: LearningReport) {
  const summary = report.summary;
  const skills = summary?.skills?.map((skill) => skill.id) ?? [];
  const metrics: (readonly [string, string])[] = [];
  for (const [key, completed, total] of [
    ['completedMilestones', summary?.completedMilestones, summary?.totalMilestones],
    ['completedSteps', summary?.completedSteps, summary?.totalSteps],
  ] as const) {
    if (Number.isFinite(completed) && Number.isFinite(total))
      metrics.push([key, `${completed}/${total}`]);
  }
  if (summary?.skills) metrics.push(['skills', String(summary.skills.length)]);
  if (summary?.concepts) metrics.push(['concepts', String(summary.concepts.length)]);
  const passed = report.outcomes?.filter((outcome) => outcome.tests === 'passed').length ?? 0;
  const tested = report.outcomes?.filter((outcome) => outcome.tests !== null).length ?? 0;
  return {
    title: report.project.title,
    completed: report.requiredComplete,
    metrics,
    skills,
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
