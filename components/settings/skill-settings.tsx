'use client';

/**
 * Skill management section of the global settings dialog.
 *
 * Lists the skills installed for the current account — built-in skills that
 * ship with the product and the owner's own skills created from chat history —
 * from the owner-scoped `GET /api/agent/skills` registry. The row layout and
 * the grouped list follow the reference skill-settings dialog, which this
 * surface replaces with REAL endpoints only:
 *
 *  - every row opens a detail view (`SkillDetailDialog`) and offers a real
 *    Download action that hits `GET /api/skills/:id` and ships the zip the
 *    server builds;
 *  - a user skill's detail view loads its full body from the owner-scoped
 *    detail route (`GET /api/agent/skills/:id`); built-in skills have no
 *    detail route, so their detail view shows what the registry already
 *    carries and never issues a request that would 404.
 *
 * Owner rows can also be deleted after confirmation, and exported zips or bare
 * SKILL.md files can be uploaded through the owner-scoped registry endpoint.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Loader2, Sparkles, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  agentSkillsErrorText,
  skillTitle,
  useAgentSkills,
  type AgentSkillInfo,
} from '@/lib/workbench/agent-skills';
import { cn } from '@/lib/utils';

/**
 * The real Download affordance for one skill. A plain anchor to the export
 * route (`GET /api/skills/:id`): same-origin, so the `download` attribute
 * names the file and the server's `Content-Disposition` keeps it a download
 * in every browser either way.
 */
function DownloadLink({ skill }: { skill: AgentSkillInfo }) {
  const { t } = useI18n();
  return (
    <a
      href={`/api/skills/${encodeURIComponent(skill.id)}`}
      download={`${skill.name}-skill.zip`}
      data-testid={`skill-settings-download-${skill.name}`}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
    >
      <Download className="size-3.5" />
      {t('settings.skills.download')}
    </a>
  );
}

/** The kind/constraint pills a row and the detail view share. */
function SkillBadges({ skill }: { skill: AgentSkillInfo }) {
  const { t } = useI18n();
  return (
    <>
      <span className="shrink-0 rounded bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
        {skill.source === 'user'
          ? t('settings.skills.badgeOwner')
          : t('settings.skills.badgeBuiltin')}
      </span>
      {skill.hasConstraints && (
        <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
          {t('settings.skills.badgeConstraints')}
        </span>
      )}
    </>
  );
}

function SkillRow({
  skill,
  onDetails,
  onDelete,
}: {
  skill: AgentSkillInfo;
  onDetails: (skill: AgentSkillInfo) => void;
  onDelete?: (skill: AgentSkillInfo) => void;
}) {
  const { t } = useI18n();
  const title = skillTitle(skill, t);
  return (
    <div
      data-testid={`skill-settings-row-${skill.name}`}
      className="flex items-start gap-2 rounded-lg px-2 py-2 hover:bg-muted/60"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-1.5">
          {title ? (
            <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
              {title}
            </span>
          ) : null}
          {/* The English id is the skill's contract — it is never dropped. */}
          <span
            className={cn(
              'shrink-0 text-[11px] text-muted-foreground',
              !title && 'text-[13px] font-medium text-foreground',
            )}
          >
            /{skill.name}
          </span>
          <SkillBadges skill={skill} />
        </div>
        <p className="line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">
          {skill.description}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          data-testid={`skill-settings-details-${skill.name}`}
          onClick={() => onDetails(skill)}
        >
          {t('settings.skills.details')}
        </Button>
        <DownloadLink skill={skill} />
        {onDelete ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
            data-testid={`skill-settings-delete-${skill.name}`}
            onClick={() => onDelete(skill)}
          >
            <Trash2 className="size-3.5" />
            {t('settings.skills.delete')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SkillGroup({
  label,
  skills,
  emptyLabel,
  testId,
  onDetails,
  onDelete,
}: {
  label: string;
  skills: AgentSkillInfo[];
  emptyLabel: string;
  testId: string;
  onDetails: (skill: AgentSkillInfo) => void;
  onDelete?: (skill: AgentSkillInfo) => void;
}) {
  return (
    <div>
      {/* The label sits OUTSIDE the bordered box — it is the group's heading,
          not a row of the list. */}
      <h4 className="mb-1 leading-none text-[11px] font-semibold text-muted-foreground">{label}</h4>
      <section data-testid={testId} className="rounded-lg border border-border pb-1 pt-0.5">
        {skills.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">{emptyLabel}</p>
        ) : (
          skills.map((skill) => (
            <SkillRow key={skill.id} skill={skill} onDetails={onDetails} onDelete={onDelete} />
          ))
        )}
      </section>
    </div>
  );
}

interface SkillContentState {
  loading: boolean;
  failed: boolean;
  content: string | null;
}

/**
 * The full body of ONE user skill, from the owner-scoped detail route
 * (`GET /api/agent/skills/:id`). Built-in skills have no detail route — their
 * registry row already carries the whole story — so this hook is only ever
 * handed a user-skill id and never issues a request that would 404.
 */
function useUserSkillContent(id: string | null): SkillContentState & { retry: () => void } {
  const [state, setState] = useState<SkillContentState>({
    loading: false,
    failed: false,
    content: null,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    // The dialog re-opens per skill: reset synchronously so the previous
    // skill's body never flashes under the new one's loading state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ loading: true, failed: false, content: null });
    fetch(`/api/agent/skills/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`skill detail request failed: ${res.status}`);
        const body = (await res.json()) as { id: string; content: string };
        if (!cancelled) setState({ loading: false, failed: false, content: body.content });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, failed: true, content: null });
      });
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}

/**
 * The detail view, laid out like the reference skill-settings dialog: a
 * header carrying the display name + id and the one-line description, the
 * kind/constraint pills, and the skill body (user skills) or a note that the
 * built-in ships with the product. Download stays available in the footer.
 */
function SkillDetailDialog({
  skill,
  onClose,
}: {
  skill: AgentSkillInfo | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const content = useUserSkillContent(skill && skill.source === 'user' ? skill.id : null);

  return (
    <Dialog open={skill !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-testid="skill-settings-detail-dialog"
        className="max-h-[80vh] gap-3 overflow-y-auto p-4 sm:max-w-[520px]"
      >
        {skill ? (
          <>
            <DialogHeader className="space-y-0.5">
              <DialogTitle className="flex items-baseline gap-1.5 text-base">
                <Sparkles className="size-4 shrink-0 self-center text-primary" />
                <span className="min-w-0 truncate">{skillTitle(skill, t) ?? skill.name}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">/{skill.name}</span>
              </DialogTitle>
              <DialogDescription className="text-xs">{skill.description}</DialogDescription>
            </DialogHeader>

            <div className="flex items-center gap-1.5">
              <SkillBadges skill={skill} />
            </div>

            {skill.source === 'user' ? (
              content.loading ? (
                <p
                  data-testid="skill-settings-detail-loading"
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                  {t('common.loading')}
                </p>
              ) : content.failed ? (
                <p
                  data-testid="skill-settings-detail-error"
                  className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
                >
                  {t('settings.skills.detailFailed')}
                  <button
                    type="button"
                    data-testid="skill-settings-detail-retry"
                    onClick={content.retry}
                    className="text-xs font-semibold text-destructive hover:underline"
                  >
                    {t('settings.skills.retry')}
                  </button>
                </p>
              ) : (
                <div className="min-w-0">
                  <h4 className="mb-1 leading-none text-[11px] font-semibold text-muted-foreground">
                    {t('settings.skills.contentLabel')}
                  </h4>
                  <pre
                    data-testid="skill-settings-detail-content"
                    className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/50 p-3 font-mono text-[11px] leading-relaxed text-foreground"
                  >
                    {content.content}
                  </pre>
                </div>
              )
            ) : (
              <p
                data-testid="skill-settings-detail-note"
                className="rounded-md border border-border bg-muted/50 px-2.5 py-2 text-xs text-muted-foreground"
              >
                {t('settings.skills.builtinDetailNote')}
              </p>
            )}

            <DialogFooter className="gap-2 sm:justify-end">
              <Button variant="outline" size="sm" onClick={onClose}>
                {t('settings.close')}
              </Button>
              <DownloadLink skill={skill} />
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The "Skills" section body, mounted by the settings dialog when its sidebar
 * selects the section. Grouped by kind — the owner's skills first, then the
 * built-ins — with the reference's loading / failed / empty patterns.
 */
export function SkillSettings() {
  const { t } = useI18n();
  const { skills, loading, error, reload } = useAgentSkills();
  const [detailSkill, setDetailSkill] = useState<AgentSkillInfo | null>(null);
  const [deleteSkill, setDeleteSkill] = useState<AgentSkillInfo | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [actionError, setActionError] = useState<'deleteFailed' | 'uploadFailed' | null>(null);
  const [hiddenSkillIds, setHiddenSkillIds] = useState<Set<string>>(() => new Set());
  const [uploadedSkills, setUploadedSkills] = useState<AgentSkillInfo[]>([]);
  const uploadRef = useRef<HTMLInputElement>(null);

  const visibleSkills = [
    ...skills,
    ...uploadedSkills.filter((uploaded) => !skills.some((skill) => skill.id === uploaded.id)),
  ].filter((skill) => !hiddenSkillIds.has(skill.id));
  const userSkills = visibleSkills.filter((skill) => skill.source === 'user');
  const builtinSkills = visibleSkills.filter((skill) => skill.source === 'builtin');

  const openDetails = useCallback((skill: AgentSkillInfo) => setDetailSkill(skill), []);

  const confirmDelete = useCallback(async () => {
    if (!deleteSkill || deleting) return;
    setDeleting(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/agent/skills/${encodeURIComponent(deleteSkill.id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error(`skill delete request failed: ${response.status}`);
      setHiddenSkillIds((current) => new Set(current).add(deleteSkill.id));
      setDeleteSkill(null);
      if (detailSkill?.id === deleteSkill.id) setDetailSkill(null);
      await reload().catch(() => {});
    } catch {
      setActionError('deleteFailed');
    } finally {
      setDeleting(false);
    }
  }, [deleteSkill, deleting, detailSkill?.id, reload]);

  const uploadSkill = useCallback(
    async (file: File) => {
      setUploading(true);
      setActionError(null);
      try {
        const form = new FormData();
        form.set('file', file);
        const response = await fetch('/api/agent/skills', { method: 'POST', body: form });
        if (!response.ok) throw new Error(`skill upload request failed: ${response.status}`);
        const uploaded = (await response.json()) as AgentSkillInfo;
        setUploadedSkills((current) => [
          ...current.filter((skill) => skill.id !== uploaded.id),
          uploaded,
        ]);
        await reload().catch(() => {});
      } catch {
        setActionError('uploadFailed');
      } finally {
        setUploading(false);
        if (uploadRef.current) uploadRef.current.value = '';
      }
    },
    [reload],
  );

  return (
    <div className="flex flex-col gap-4" data-testid="skill-settings-section">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">{t('settings.skills.description')}</p>
        <input
          ref={uploadRef}
          type="file"
          accept=".zip,.md,text/markdown,application/zip"
          className="sr-only"
          data-testid="skill-settings-upload-input"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void uploadSkill(file);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 px-2.5 text-xs"
          disabled={uploading}
          data-testid="skill-settings-upload"
          onClick={() => uploadRef.current?.click()}
        >
          {uploading ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Upload className="size-3.5" />
          )}
          {uploading ? t('settings.skills.uploading') : t('settings.skills.upload')}
        </Button>
      </div>

      {actionError ? (
        <p
          data-testid="skill-settings-action-error"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
        >
          {t(`settings.skills.${actionError}`)}
        </p>
      ) : null}

      {loading ? (
        <p
          data-testid="skill-settings-loading"
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          {t('common.loading')}
        </p>
      ) : error ? (
        // A failed list answers BOTH groups at once — rendering empty boxes
        // under an error would read as "you have no skills".
        <p
          data-testid="skill-settings-list-error"
          className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
        >
          {agentSkillsErrorText({ error }, t)}
          <button
            type="button"
            data-testid="skill-settings-list-retry"
            onClick={() => void reload().catch(() => {})}
            className="text-xs font-semibold text-destructive hover:underline"
          >
            {t('settings.skills.retry')}
          </button>
        </p>
      ) : (
        <>
          <SkillGroup
            label={t('settings.skills.mySkills')}
            skills={userSkills}
            emptyLabel={t('settings.skills.emptyMySkills')}
            testId="skill-settings-my-group"
            onDetails={openDetails}
            onDelete={setDeleteSkill}
          />
          <SkillGroup
            label={t('settings.skills.builtinSkills')}
            skills={builtinSkills}
            emptyLabel={t('settings.skills.emptyBuiltinSkills')}
            testId="skill-settings-builtin-group"
            onDetails={openDetails}
          />
        </>
      )}

      <SkillDetailDialog skill={detailSkill} onClose={() => setDetailSkill(null)} />

      <AlertDialog
        open={deleteSkill !== null}
        onOpenChange={(open) => !open && setDeleteSkill(null)}
      >
        <AlertDialogContent data-testid="skill-settings-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.skills.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.skills.deleteConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              data-testid="skill-settings-delete-confirm"
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              {deleting ? t('settings.skills.deleting') : t('settings.skills.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
