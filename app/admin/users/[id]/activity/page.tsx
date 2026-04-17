import { prisma } from '@/lib/auth/prisma';

export default async function AdminUserActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const logs = await prisma.auditLog.findMany({
    where: { OR: [{ actorId: id }, { targetId: id }] },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      actor: { select: { name: true, email: true } },
      target: { select: { name: true, email: true } },
    },
  });

  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-5">
      <h1 className="mb-4 text-xl font-semibold text-white">User Activity</h1>
      {logs.length === 0 ? (
        <p className="text-sm text-slate-500">No activity found.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-white/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-slate-400">
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Action</th>
                <th className="px-3 py-2">Actor</th>
                <th className="px-3 py-2">Target</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-white/5">
                  <td className="px-3 py-2 text-xs text-slate-500">{new Date(log.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2 font-mono text-xs text-purple-300">{log.action}</td>
                  <td className="px-3 py-2 text-slate-300">{log.actor?.name ?? log.actor?.email ?? 'System'}</td>
                  <td className="px-3 py-2 text-slate-400">{log.target?.name ?? log.target?.email ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
