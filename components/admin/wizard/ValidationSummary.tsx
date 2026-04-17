import { AlertTriangle, CheckCircle2 } from 'lucide-react';

interface ValidationSummaryProps {
  errors: string[];
}

export function ValidationSummary({ errors }: ValidationSummaryProps) {
  if (!errors.length) {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
        <CheckCircle2 className="h-4 w-4" />
        All required fields are valid.
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
      <div className="mb-2 flex items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4" />
        Resolve these fields before continuing:
      </div>
      <ul className="list-disc space-y-1 pl-5">
        {errors.map((err) => (
          <li key={err}>{err}</li>
        ))}
      </ul>
    </div>
  );
}
