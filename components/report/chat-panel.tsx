'use client';

import { useI18n } from '@/lib/hooks/use-i18n';
import type { ReportMetric, ChatVM } from '@/lib/report/types';
import { StatStrip, type Stat } from './report-primitives';
import { ChatChart } from './chat-chart';

export function ChatPanel({ metric, chat }: { metric: ReportMetric; chat: ChatVM[] }) {
  const { t } = useI18n();

  const active = chat.reduce((sum, c) => sum + c.active, 0);
  const completed = chat.reduce((sum, c) => sum + c.completed, 0);
  const interrupted = chat.reduce((sum, c) => sum + c.interrupted, 0);

  if (metric.chatSessionCount === 0) {
    return <p className="text-sm text-muted-foreground">{t('learningReport.chat.empty')}</p>;
  }

  const stats: Stat[] = [
    { label: t('learningReport.chat.total'), value: String(metric.chatSessionCount) },
    { label: t('learningReport.chat.qa'), value: String(metric.qaSessionCount) },
    { label: t('learningReport.chat.lecture'), value: String(metric.lectureSessionCount) },
    { label: t('learningReport.chat.discussion'), value: String(metric.discussionSessionCount) },
    { label: t('learningReport.chat.messages'), value: String(metric.totalChatMessageCount) },
    { label: t('learningReport.chat.completed'), value: String(completed) },
    { label: t('learningReport.chat.active'), value: String(active) },
    { label: t('learningReport.chat.interrupted'), value: String(interrupted) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <StatStrip items={stats} />
      <ChatChart chat={chat} />
    </div>
  );
}
