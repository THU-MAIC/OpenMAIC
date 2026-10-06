export function UnavailableScene({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <p className="max-w-md rounded-lg border border-dashed border-slate-300 bg-white px-6 py-8 text-center text-sm text-slate-500">
        {message}
      </p>
    </div>
  );
}
