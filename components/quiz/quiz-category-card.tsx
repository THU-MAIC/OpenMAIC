'use client';

interface QuizCategoryCardProps {
  title: string;
  description: string;
  onClick: () => void;
}

export function QuizCategoryCard({ title, description, onClick }: QuizCategoryCardProps) {
  return (
    <button
      onClick={onClick}
      className="w-full rounded-2xl border border-gray-200 bg-white p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-gray-800 dark:bg-gray-900"
    >
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{description}</p>
    </button>
  );
}
