import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Course Catalog | Slate',
  description: 'Explore community-generated AI courses across various subjects and age groups.',
};

export default function CatalogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="min-h-screen bg-slate-50 dark:bg-slate-950">{children}</div>;
}
