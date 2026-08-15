import { WorkspaceShell } from '@/components/workspace/workspace-shell';

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return <WorkspaceShell>{children}</WorkspaceShell>;
}
