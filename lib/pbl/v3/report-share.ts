import type { LearningReport } from './report';

/** Campaign content supplied by the course team; never inferred from IDs or the current URL. */
export const reportShareCampaign = {
  url: '',
  // Replace decorative assets here when the campaign design is delivered.
  backgrounds: { landscape: { light: '', dark: '' }, portrait: { light: '', dark: '' } },
};

/** A deliberately small public projection. Never pass conversations, citations or quotes to a poster. */
export function reportShareContent(report: LearningReport) {
  const summary = report.summary;
  return {
    title: report.project.title,
    completed: report.requiredComplete,
    metrics: summary
      ? ([
          ['completedMilestones', `${summary.completedMilestones}/${summary.totalMilestones}`],
          ['completedSteps', `${summary.completedSteps}/${summary.totalSteps}`],
          ['skills', String(summary.skills.length)],
          ['concepts', String(summary.concepts.length)],
        ] as const)
      : [],
    skills: summary?.skills.map((s) => s.id) ?? [],
    concepts: summary?.concepts.slice(0, 6) ?? [],
    verification: {
      passed: report.outcomes?.filter((o) => o.tests === 'passed').length ?? 0,
      tested: report.outcomes?.filter((o) => o.tests !== null).length ?? 0,
      quizScore: report.outcomes?.reduce((n, o) => n + (o.quiz?.score ?? 0), 0) ?? 0,
      quizTotal: report.outcomes?.reduce((n, o) => n + (o.quiz?.total ?? 0), 0) ?? 0,
      decisions: report.facts?.decisions,
    },
    highlights:
      report.analysis?.status === 'ready'
        ? report.analysis.findings
            .filter((f) => ['journey', 'strength', 'collaboration', 'change'].includes(f.category))
            .filter((f) => !f.quote || !f.title.includes(f.quote))
            .map((f) => f.title.trim())
            .filter(Boolean)
            .slice(0, 2)
        : [],
    waiting:
      report.analysis?.status === 'not_generated' || report.analysis?.status === 'generating',
  };
}
export type ReportShareContent = ReturnType<typeof reportShareContent>;
export type ShareOrientation = 'landscape' | 'portrait';
export type ShareTheme = 'light' | 'dark';
