// Force dynamic rendering since this page uses client-side hooks (useI18n)
export const dynamic = 'force-dynamic';

export default function GenerationPreviewLayout({ children }: { children: React.ReactNode }) {
  return children;
}
