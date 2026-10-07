import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import type { PBLProject } from '@openmaic/dsl';
import type { StandalonePlayerStrings } from '@/lib/export/standalone-html/contract';

interface BriefingMilestone {
  title: string;
  description?: string;
  tasks: Array<{ title: string; description?: string }>;
}

interface Briefing {
  title: string;
  description?: string;
  learningObjective?: string;
  setting?: string;
  goal?: string;
  learnerRole?: string;
  characters: Array<{ name: string; persona?: string }>;
  milestones: BriefingMilestone[];
}

/**
 * The static briefing of a PBL scene. The export already resolved the
 * classroom's authoritative representation (upgrading legacy projects) and
 * reduced it to these fields; entries are still read defensively.
 */
export function pblBriefing(content: { projectV2?: PBLProject }, fallbackTitle: string): Briefing {
  const project = content.projectV2;
  const present = <T,>(items: readonly (T | null | undefined)[] | undefined): T[] =>
    (items ?? []).filter((item): item is T => item != null && typeof item === 'object');
  const byOrder = (a: { order?: number }, b: { order?: number }) => (a.order ?? 0) - (b.order ?? 0);
  return {
    title: project?.title || fallbackTitle,
    description: project?.description,
    learningObjective: project?.learningObjective,
    setting: project?.scenario?.setting,
    goal: project?.scenario?.goal,
    learnerRole: project?.scenario?.learnerRole,
    characters: present(project?.scenario?.characters).map((character) => ({
      name: character.name,
      persona: character.persona,
    })),
    milestones: present(project?.milestones)
      .sort(byOrder)
      .map((milestone) => ({
        title: milestone.title,
        description: milestone.description,
        tasks: present(milestone.microtasks)
          .sort(byOrder)
          .map((task) => ({
            title: task.title,
            description: task.learnerBrief ?? task.description,
          })),
      })),
  };
}

/** Only a web address may become the "continue online" link. */
export function safeClassroomUrl(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</h3>
      <div className="whitespace-pre-line text-sm leading-relaxed text-slate-700">{children}</div>
    </div>
  );
}

export function PblScene({
  content,
  sceneTitle,
  classroomUrl,
  strings,
}: {
  content: { projectV2?: PBLProject };
  sceneTitle: string;
  classroomUrl?: string;
  strings: StandalonePlayerStrings;
}) {
  const briefing = pblBriefing(content, sceneTitle);
  const link = safeClassroomUrl(classroomUrl);
  return (
    <div className="absolute inset-0 overflow-y-auto">
      <article className="mx-auto max-w-3xl space-y-5 px-4 py-6" data-testid="pbl">
        <header className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-xl font-semibold">{briefing.title}</h2>
          {briefing.description && (
            <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-600">
              {briefing.description}
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-violet-50 px-4 py-3 text-sm text-violet-900">
            <span className="min-w-0 flex-1">{strings.pblOnlineOnly}</span>
            {link && (
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 font-medium text-white hover:bg-violet-700"
                data-testid="pbl-continue-online"
              >
                {strings.pblContinueOnline}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}
          </div>
        </header>

        {(briefing.learningObjective ||
          briefing.setting ||
          briefing.goal ||
          briefing.learnerRole ||
          briefing.characters.length > 0) && (
          <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            {briefing.learningObjective && (
              <Field label={strings.pblLearningObjective}>{briefing.learningObjective}</Field>
            )}
            {briefing.setting && <Field label={strings.pblScenario}>{briefing.setting}</Field>}
            {briefing.goal && <Field label={strings.pblGoal}>{briefing.goal}</Field>}
            {briefing.learnerRole && (
              <Field label={strings.pblYourRole}>{briefing.learnerRole}</Field>
            )}
            {briefing.characters.length > 0 && (
              <Field label={strings.pblCharacters}>
                <ul className="space-y-1">
                  {briefing.characters.map((character, index) => (
                    <li key={index}>
                      <span className="font-medium text-slate-900">{character.name}</span>
                      {character.persona ? ` — ${character.persona}` : ''}
                    </li>
                  ))}
                </ul>
              </Field>
            )}
          </section>
        )}

        {briefing.milestones.length > 0 && (
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {strings.pblMilestones}
            </h3>
            <ol className="space-y-4">
              {briefing.milestones.map((milestone, index) => (
                <li key={index} className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-100 text-xs font-semibold text-violet-700">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{milestone.title}</div>
                    {milestone.description && (
                      <p className="mt-0.5 whitespace-pre-line text-sm text-slate-600">
                        {milestone.description}
                      </p>
                    )}
                    {milestone.tasks.length > 0 && (
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                        {milestone.tasks.map((task, taskIndex) => (
                          <li key={taskIndex}>
                            <span className="font-medium">{task.title}</span>
                            {task.description ? `: ${task.description}` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
      </article>
    </div>
  );
}
