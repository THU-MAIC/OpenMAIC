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
  const skills = summary?.skills.map((skill) => skill.id) ?? [];
  const passed = report.outcomes?.filter((outcome) => outcome.tests === 'passed').length ?? 0;
  const tested = report.outcomes?.filter((outcome) => outcome.tests !== null).length ?? 0;
  // Findings are private free text, even when their citations and quotes are valid.
  // Public conclusions describe only saved, structured participation/results.
  const process =
    skills.includes('planReview') || skills.includes('codeReview')
      ? 'reviewed'
      : (report.facts?.decisions ?? 0) > 0
        ? 'decided'
        : null;
  const result =
    tested > 0 && passed === tested
      ? 'verified'
      : skills.includes('reflection')
        ? 'reflected'
        : (summary?.completedSteps ?? 0) > 0
          ? 'completed'
          : null;
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
    skills,
    concepts: summary?.concepts.slice(0, 6) ?? [],
    verification: {
      passed,
      tested,
      quizScore: report.outcomes?.reduce((n, o) => n + (o.quiz?.score ?? 0), 0) ?? 0,
      quizTotal: report.outcomes?.reduce((n, o) => n + (o.quiz?.total ?? 0), 0) ?? 0,
      decisions: report.facts?.decisions,
    },
    highlights: [process, result].filter((value) => value !== null),
    waiting:
      report.analysis?.status === 'not_generated' || report.analysis?.status === 'generating',
  };
}
export type ReportShareContent = ReturnType<typeof reportShareContent>;
export type ShareOrientation = 'landscape' | 'portrait';
export type ShareTheme = 'light' | 'dark';
