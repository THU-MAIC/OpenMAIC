import { ReportView } from '@/components/report/report-view';

// Learning report — reads the current device's local data (IndexedDB + quiz
// localStorage) and renders the learner's own report. All data access is
// client-side, so the page delegates entirely to the client ReportView.
export default function ReportPage() {
  return <ReportView />;
}
