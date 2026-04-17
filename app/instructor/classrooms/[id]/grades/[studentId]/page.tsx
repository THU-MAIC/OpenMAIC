'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, Pencil, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';

interface AnswerItem {
  questionId: string;
  answer: string;
  score: number;
  comment?: string;
  overrideScore?: number;
  overrideComment?: string;
}

interface QuizResult {
  id: string;
  sceneTitle: string;
  sceneId: string;
  score: number;
  maxScore: number;
  gradedBy: string;
  gradedAt: string;
  answers: AnswerItem[];
}

export default function StudentGradesPage() {
  const params = useParams<{ id: string; studentId: string }>();
  const { t } = useI18n();
  const { id: classroomId, studentId } = params;

  const [results, setResults] = useState<QuizResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchResults = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/instructor/classrooms/${classroomId}/grades/${studentId}`);
      if (!res.ok) throw new Error('failed');
      const data = await res.json() as { results: QuizResult[] };
      setResults(data.results ?? []);
    } catch {
      toast.error(t('instructorStudentGrades.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [classroomId, studentId, t]);

  useEffect(() => { void fetchResults(); }, [fetchResults]);

  const totalScore = results.reduce((s, r) => s + r.score, 0);
  const totalMax = results.reduce((s, r) => s + r.maxScore, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href={`/instructor/classrooms/${classroomId}/grades`}
          className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> {t('instructorStudentGrades.backToGradebook')}
        </Link>
      </div>

      {/* Summary */}
      {totalMax > 0 && (
        <div className="rounded-xl border border-white/10 bg-white/5 px-6 py-4">
          <p className="text-sm text-slate-400">{t('instructorStudentGrades.totalScore')}</p>
          <p className="mt-1 text-3xl font-bold text-white">
            {totalScore}
            <span className="text-lg text-slate-400">/{totalMax}</span>
          </p>
        </div>
      )}

      {results.length === 0 ? (
        <p className="text-sm text-slate-500 py-10 text-center">{t('instructorStudentGrades.noQuizResults')}</p>
      ) : (
        <div className="space-y-3">
          {results.map((result) => (
            <QuizResultCard
              key={result.id}
              result={result}
              classroomId={classroomId}
              studentId={studentId}
              t={t}
              expanded={expandedId === result.id}
              onToggle={() => setExpandedId(expandedId === result.id ? null : result.id)}
              onOverrideSuccess={() => void fetchResults()}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function QuizResultCard({
  result,
  classroomId,
  studentId,
  t,
  expanded,
  onToggle,
  onOverrideSuccess,
}: {
  result: QuizResult;
  classroomId: string;
  studentId: string;
  t: (key: string, options?: Record<string, unknown>) => string;
  expanded: boolean;
  onToggle: () => void;
  onOverrideSuccess: () => void;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-white/4 transition-colors text-left"
      >
        <div>
          <p className="font-medium text-white">{result.sceneTitle}</p>
          <p className="text-xs text-slate-400 mt-0.5">
            {new Date(result.gradedAt).toLocaleDateString()} &middot;{' '}
            {t('instructorStudentGrades.gradedBy')}: {result.gradedBy === 'ai' ? t('instructorStudentGrades.ai') : t('instructorStudentGrades.instructor')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`font-semibold ${result.score === result.maxScore ? 'text-emerald-400' : 'text-white'}`}>
            {result.score}/{result.maxScore}
          </span>
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-slate-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-slate-400" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-white/10 divide-y divide-white/5">
          {result.answers.length === 0 ? (
            <p className="px-5 py-4 text-sm text-slate-500">{t('instructorStudentGrades.noAnswerDetails')}</p>
          ) : (
            result.answers.map((a, idx) => (
              <AnswerRow
                key={a.questionId}
                answer={a}
                index={idx}
                quizResultId={result.id}
                classroomId={classroomId}
                studentId={studentId}
                t={t}
                maxScorePerQ={result.maxScore}
                onOverrideSuccess={onOverrideSuccess}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function AnswerRow({
  answer,
  index,
  quizResultId,
  classroomId,
  studentId,
  t,
  maxScorePerQ,
  onOverrideSuccess,
}: {
  answer: AnswerItem;
  index: number;
  quizResultId: string;
  classroomId: string;
  studentId: string;
  t: (key: string, options?: Record<string, unknown>) => string;
  maxScorePerQ: number;
  onOverrideSuccess: () => void;
}) {
  const displayScore = answer.overrideScore ?? answer.score;
  const displayComment = answer.overrideComment ?? answer.comment;

  const [editing, setEditing] = useState(false);
  const [overrideScore, setOverrideScore] = useState(String(displayScore));
  const [overrideComment, setOverrideComment] = useState(displayComment ?? '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const scoreNum = parseInt(overrideScore, 10);
    if (!Number.isInteger(scoreNum) || scoreNum < 0) {
      toast.error(t('instructorStudentGrades.scoreValidation'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        `/api/instructor/classrooms/${classroomId}/grades/${studentId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            quizResultId,
            questionId: answer.questionId,
            newScore: scoreNum,
            newComment: overrideComment.trim() || undefined,
          }),
        },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({})) as { error?: string };
        toast.error(payload.error ?? t('instructorStudentGrades.overrideFailed'));
        return;
      }
      toast.success(t('instructorStudentGrades.gradeUpdated'));
      setEditing(false);
      onOverrideSuccess();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="px-5 py-4 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">
            {t('instructorStudentGrades.question')} {index + 1}
          </p>
          <p className="text-sm text-white whitespace-pre-wrap">{answer.answer || t('instructorStudentGrades.noAnswer')}</p>
          {displayComment && (
            <p className="mt-1 text-xs text-slate-400 italic">{t('instructorStudentGrades.aiComment')}: {displayComment}</p>
          )}
        </div>

        <div className="flex-shrink-0 flex items-center gap-2">
          {answer.overrideScore !== undefined && (
            <span className="text-[10px] rounded bg-amber-500/20 px-1.5 py-0.5 text-amber-400">
              {t('instructorStudentGrades.overridden')}
            </span>
          )}
          <span className="text-sm font-medium text-white">{displayScore}</span>
          {!editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded border border-white/10 p-1 text-slate-400 hover:text-white transition-colors"
              aria-label={t('instructorStudentGrades.overrideGrade')}
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3 space-y-2">
          <p className="text-xs font-semibold text-indigo-300">{t('instructorStudentGrades.overrideGrade')}</p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={overrideScore}
              onChange={(e) => setOverrideScore(e.target.value)}
              min={0}
              max={maxScorePerQ}
              className="w-20 rounded border border-white/10 bg-white/5 px-2 py-1 text-sm text-white focus:border-indigo-500 focus:outline-none"
            />
            <input
              type="text"
              value={overrideComment}
              onChange={(e) => setOverrideComment(e.target.value)}
              placeholder={t('instructorStudentGrades.overrideCommentPlaceholder')}
              maxLength={500}
              className="flex-1 rounded border border-white/10 bg-white/5 px-2 py-1 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              className="rounded bg-indigo-600 p-1.5 text-white hover:bg-indigo-500 disabled:opacity-60 transition-colors"
              aria-label={t('instructorStudentGrades.saveOverride')}
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => setEditing(false)}
              className="rounded border border-white/10 p-1.5 text-slate-400 hover:text-white transition-colors"
              aria-label={t('instructorStudentGrades.cancel')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
