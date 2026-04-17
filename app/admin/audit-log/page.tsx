import Link from 'next/link';
import { prisma } from '@/lib/auth/prisma';
import { Prisma } from '@prisma/client';
import { getSystemSettings } from '@/lib/server/system-settings';
import { LocalTimeText } from '@/components/admin/audit-log/local-time-text';
import { ClientTimezoneInput } from '@/components/admin/audit-log/client-timezone-input';
import { I18nText } from '@/components/i18n-text';

const PAGE_SIZE = 10;

type AuditLogPageProps = {
  searchParams?:
    | Promise<{
        page?: string | string[];
        year?: string | string[];
        month?: string | string[];
        day?: string | string[];
        hour?: string | string[];
        minute?: string | string[];
        tz?: string | string[];
        actor?: string | string[];
        target?: string | string[];
        ip?: string | string[];
      }>
    | {
        page?: string | string[];
        year?: string | string[];
        month?: string | string[];
        day?: string | string[];
        hour?: string | string[];
        minute?: string | string[];
        tz?: string | string[];
        actor?: string | string[];
        target?: string | string[];
        ip?: string | string[];
      };
};

function getFirstParam(value?: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function parseBoundedInt(value: string, min: number, max: number): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function normalizeTimeZone(value: string | null | undefined): string {
  const tz = (value ?? '').trim();
  if (!tz) return 'UTC';
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

export default async function AuditLogPage({ searchParams }: AuditLogPageProps) {
  const systemSettings = await getSystemSettings();

  const params = await Promise.resolve(searchParams ?? {});
  const pageParam = getFirstParam(params.page);
  const tzQuery = getFirstParam(params.tz).trim();
  const yearQuery = getFirstParam(params.year).trim();
  const monthQuery = getFirstParam(params.month).trim();
  const dayQuery = getFirstParam(params.day).trim();
  const hourQuery = getFirstParam(params.hour).trim();
  const minuteQuery = getFirstParam(params.minute).trim();
    const timeZone = normalizeTimeZone(tzQuery || systemSettings.timezone);

  const actorQuery = getFirstParam(params.actor).trim();
  const targetQuery = getFirstParam(params.target).trim();
  const ipQuery = getFirstParam(params.ip).trim();

  const yearValue = parseBoundedInt(yearQuery, 1970, 3000);
  const monthValue = parseBoundedInt(monthQuery, 1, 12);
  const dayValue = parseBoundedInt(dayQuery, 1, 31);
  const hourValue = parseBoundedInt(hourQuery, 0, 23);
  const minuteValue = parseBoundedInt(minuteQuery, 0, 59);

  const conditions: Prisma.Sql[] = [];
  const localTimestampExpr = Prisma.sql`((al.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})`;

  if (yearValue !== null) {
    conditions.push(Prisma.sql`EXTRACT(YEAR FROM ${localTimestampExpr}) = ${yearValue}`);
  }
  if (monthValue !== null) {
    conditions.push(Prisma.sql`EXTRACT(MONTH FROM ${localTimestampExpr}) = ${monthValue}`);
  }
  if (dayValue !== null) {
    conditions.push(Prisma.sql`EXTRACT(DAY FROM ${localTimestampExpr}) = ${dayValue}`);
  }
  if (hourValue !== null) {
    conditions.push(Prisma.sql`EXTRACT(HOUR FROM ${localTimestampExpr}) = ${hourValue}`);
  }
  if (minuteValue !== null) {
    conditions.push(Prisma.sql`EXTRACT(MINUTE FROM ${localTimestampExpr}) = ${minuteValue}`);
  }

  if (actorQuery) {
    const actorLike = `%${actorQuery}%`;
    conditions.push(Prisma.sql`(actor.name ILIKE ${actorLike} OR actor.email ILIKE ${actorLike})`);
  }

  if (targetQuery) {
    const targetLike = `%${targetQuery}%`;
    conditions.push(Prisma.sql`(target.name ILIKE ${targetLike} OR target.email ILIKE ${targetLike})`);
  }

  if (ipQuery) {
    const ipLike = `%${ipQuery}%`;
    conditions.push(Prisma.sql`al.ip_address ILIKE ${ipLike}`);
  }

  const requestedPage = Math.max(1, Number.parseInt(pageParam ?? '1', 10) || 1);

  const fromClause = Prisma.sql`
    FROM audit_logs al
    LEFT JOIN users actor ON actor.id = al.actor_id
    LEFT JOIN users target ON target.id = al.target_id
  `;
  const whereClause = conditions.length > 0
    ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
    : Prisma.empty;

  const countRows = await prisma.$queryRaw<{ count: bigint | number }[]>(Prisma.sql`
    SELECT COUNT(*)::bigint AS count
    ${fromClause}
    ${whereClause}
  `);
  const total = Number(countRows[0]?.count ?? 0);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(requestedPage, totalPages);

  const idRows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT al.id
    ${fromClause}
    ${whereClause}
    ORDER BY al.created_at DESC
    OFFSET ${(currentPage - 1) * PAGE_SIZE}
    LIMIT ${PAGE_SIZE}
  `);
  const logIds = idRows.map((row) => row.id);

  const buildPageHref = (page: number) => {
    const qp = new URLSearchParams();
    qp.set('page', String(page));
    if (yearQuery) qp.set('year', yearQuery);
    if (monthQuery) qp.set('month', monthQuery);
    if (dayQuery) qp.set('day', dayQuery);
    if (hourQuery) qp.set('hour', hourQuery);
    if (minuteQuery) qp.set('minute', minuteQuery);
    if (tzQuery) qp.set('tz', tzQuery);
    if (actorQuery) qp.set('actor', actorQuery);
    if (targetQuery) qp.set('target', targetQuery);
    if (ipQuery) qp.set('ip', ipQuery);
    return `/admin/audit-log?${qp.toString()}`;
  };

  const logs = logIds.length === 0
    ? []
    : await prisma.auditLog.findMany({
        where: { id: { in: logIds } },
        include: {
          actor: { select: { name: true, email: true } },
          target: { select: { name: true, email: true } },
        },
      });
  const logOrder = new Map(logIds.map((id, idx) => [id, idx]));
  logs.sort((a, b) => (logOrder.get(a.id) ?? 0) - (logOrder.get(b.id) ?? 0));

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-6"><I18nText k="auditLog.title" fallback="Audit Log" /></h1>

      <form action="/admin/audit-log" method="get" className="mb-4 space-y-3 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5 p-4">
        <ClientTimezoneInput initialTimeZone={timeZone} />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <div>
            <label htmlFor="year" className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-600 dark:text-slate-400">
              <I18nText k="auditLog.filters.year" fallback="Year" />
            </label>
            <input
              id="year"
              name="year"
              type="number"
              min={1970}
              max={3000}
              defaultValue={yearQuery}
              placeholder="2026"
              className="w-full rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-3 py-2 text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
            />
          </div>

          <div>
            <label htmlFor="month" className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-600 dark:text-slate-400">
              <I18nText k="auditLog.filters.month" fallback="Month" />
            </label>
            <input
              id="month"
              name="month"
              type="number"
              min={1}
              max={12}
              defaultValue={monthQuery}
              placeholder="1-12"
              className="w-full rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-3 py-2 text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
            />
          </div>

          <div>
            <label htmlFor="day" className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-600 dark:text-slate-400">
              <I18nText k="auditLog.filters.day" fallback="Day" />
            </label>
            <input
              id="day"
              name="day"
              type="number"
              min={1}
              max={31}
              defaultValue={dayQuery}
              placeholder="1-31"
              className="w-full rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-3 py-2 text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
            />
          </div>

          <div>
            <label htmlFor="hour" className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-600 dark:text-slate-400">
              <I18nText k="auditLog.filters.hour" fallback="Hour" />
            </label>
            <input
              id="hour"
              name="hour"
              type="number"
              min={0}
              max={23}
              defaultValue={hourQuery}
              placeholder="0-23"
              className="w-full rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-3 py-2 text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
            />
          </div>

          <div>
            <label htmlFor="minute" className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-600 dark:text-slate-400">
              <I18nText k="auditLog.filters.minute" fallback="Minute" />
            </label>
            <input
              id="minute"
              name="minute"
              type="number"
              min={0}
              max={59}
              defaultValue={minuteQuery}
              placeholder="0-59"
              className="w-full rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-3 py-2 text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
            />
          </div>
        </div>

        <p className="text-xs text-slate-400 dark:text-slate-500">
          <I18nText k="auditLog.filters.hint" fallback="Leave any time field blank to ignore it. You can search by one part or any combination." />
        </p>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <div>
          <label htmlFor="actor" className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-600 dark:text-slate-400">
            <I18nText k="auditLog.filters.actor" fallback="Actor" />
          </label>
          <input
            id="actor"
            name="actor"
            type="text"
            defaultValue={actorQuery}
            placeholder="Name or email"
            className="w-full rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-3 py-2 text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
          />
        </div>

        <div>
          <label htmlFor="target" className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-600 dark:text-slate-400">
            <I18nText k="auditLog.filters.target" fallback="Target" />
          </label>
          <input
            id="target"
            name="target"
            type="text"
            defaultValue={targetQuery}
            placeholder="Name or email"
            className="w-full rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-3 py-2 text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
          />
        </div>

        <div>
          <label htmlFor="ip" className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-600 dark:text-slate-400">
            <I18nText k="auditLog.filters.ip" fallback="IP" />
          </label>
          <input
            id="ip"
            name="ip"
            type="text"
            defaultValue={ipQuery}
            placeholder="e.g. 192.168"
            className="w-full rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-3 py-2 text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
          />
        </div>

        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="rounded-lg border border-white/10 bg-purple-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-700"
          >
            <I18nText k="auditLog.filters.search" fallback="Search" />
          </button>
          <Link
            href="/admin/audit-log"
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-white/10"
          >
            <I18nText k="auditLog.filters.clear" fallback="Clear" />
          </Link>
        </div>
        </div>
      </form>

      <div className="bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl overflow-x-auto">
        {logs.length === 0 ? (
          <div className="py-16 text-center text-slate-400 dark:text-slate-500 text-sm"><I18nText k="auditLog.empty" fallback="No audit entries yet." /></div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 dark:border-white/5">
                {[
                  <I18nText key="time" k="auditLog.columns.time" fallback="Time" />,
                  <I18nText key="actor" k="auditLog.columns.actor" fallback="Actor" />,
                  <I18nText key="action" k="auditLog.columns.action" fallback="Action" />,
                  <I18nText key="resource" k="auditLog.columns.resource" fallback="Resource" />,
                  <I18nText key="target" k="auditLog.columns.target" fallback="Target" />,
                  <I18nText key="ip" k="auditLog.columns.ip" fallback="IP" />,
                ].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-slate-600 dark:text-slate-400 font-medium text-xs uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/5">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-white/3 transition-colors text-xs">
                  <td className="px-4 py-3 text-slate-400 dark:text-slate-500 whitespace-nowrap">
                    <LocalTimeText iso={new Date(log.createdAt).toISOString()} />
                  </td>
                  <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                    {log.actor?.name ?? log.actor?.email ?? <span className="text-slate-400 dark:text-slate-500">System</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 rounded bg-purple-500/10 text-purple-300 font-mono">
                      {log.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-400">
                    {log.resource ?? '—'}
                    {log.resourceId && (
                      <span className="text-slate-400 dark:text-slate-600 ml-1">#{log.resourceId.slice(0, 8)}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-400">
                    {log.target?.name ?? log.target?.email ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-500">{log.ipAddress ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {total > 0 && (
        <div className="mt-4 flex flex-col gap-3 text-sm text-slate-400 sm:flex-row sm:items-center sm:justify-between">
          <span>
            <I18nText k="auditLog.pagination.showing" fallback="Showing" />{' '}
            {(currentPage - 1) * PAGE_SIZE + 1}-{Math.min(currentPage * PAGE_SIZE, total)}{' '}
            <I18nText k="auditLog.pagination.of" fallback="of" />{' '}
            {total}
          </span>
          <div className="flex items-center gap-2">
            {currentPage > 1 ? (
              <Link
                href={buildPageHref(currentPage - 1)}
                className="rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-3 py-1.5 text-slate-700 dark:text-slate-300 transition-colors hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <I18nText k="auditLog.pagination.previous" fallback="Previous" />
              </Link>
            ) : (
              <span className="rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-3 py-1.5 text-slate-400 dark:text-slate-600"><I18nText k="auditLog.pagination.previous" fallback="Previous" /></span>
            )}

            <span className="px-2 text-slate-700 dark:text-slate-300">
              <I18nText k="auditLog.pagination.page" fallback="Page" />{' '}{currentPage}{' '}
              <I18nText k="auditLog.pagination.of" fallback="of" />{' '}{totalPages}
            </span>

            {currentPage < totalPages ? (
              <Link
                href={buildPageHref(currentPage + 1)}
                className="rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-3 py-1.5 text-slate-700 dark:text-slate-300 transition-colors hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <I18nText k="auditLog.pagination.next" fallback="Next" />
              </Link>
            ) : (
              <span className="rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-3 py-1.5 text-slate-400 dark:text-slate-600"><I18nText k="auditLog.pagination.next" fallback="Next" /></span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
