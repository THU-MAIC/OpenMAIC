interface ReviewDiffItem {
  label: string;
  value: string;
}

interface ReviewDiffCardProps {
  title: string;
  items: ReviewDiffItem[];
}

export function ReviewDiffCard({ title, items }: ReviewDiffCardProps) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-4">
      <h3 className="mb-3 text-sm font-semibold text-white">{title}</h3>
      <dl className="space-y-2">
        {items.map((item) => (
          <div key={item.label} className="flex items-center justify-between gap-4 border-b border-white/5 pb-2 last:border-0">
            <dt className="text-sm text-slate-400">{item.label}</dt>
            <dd className="text-sm font-medium text-white">{item.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
