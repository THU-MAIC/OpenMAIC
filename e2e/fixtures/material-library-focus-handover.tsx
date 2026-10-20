/** Real link entry points and library, with the shell's keep-mounted coverage. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StoredMaterialNotice } from '../../components/workbench/compose-extras';
import { ToolCard } from '../../components/workbench/chat/tool-card';
import { MaterialLibraryPage } from '../../components/workbench/workspace/MaterialLibraryPage';
import {
  WorkbenchCourseNavigationProvider,
  type MaterialLibraryTarget,
} from '../../lib/workbench/panel-context';

function FocusHandover() {
  const [target, setTarget] = useState<MaterialLibraryTarget | null>(null);
  return (
    <>
      <div data-testid="source-composer" style={{ display: target ? 'none' : 'block' }}>
        <textarea aria-label="Draft" defaultValue="Keep this draft" />
        <div data-testid="upload-link">
          <StoredMaterialNotice materialIds={['m1']} onView={setTarget} />
        </div>
        <div data-testid="stale-upload-link">
          <StoredMaterialNotice materialIds={['missing']} onView={setTarget} />
        </div>
        <WorkbenchCourseNavigationProvider
          navigation={{
            openLibraryAt: setTarget,
            openCourse: () => {},
            activeCourseId: null,
            lookupCourse: () => null,
            courseOptions: [],
          }}
        >
          {['f1', 'gone', null].map((folderId) => (
            <div key={folderId ?? 'top'} data-testid={`tool-link-${folderId ?? 'top'}`}>
              <ToolCard
                node={{
                  key: folderId ?? 'top',
                  kind: 'tool',
                  text: '',
                  toolName: 'move_materials',
                  toolState: 'done',
                  toolDetails: { folderId },
                }}
              />
            </div>
          ))}
        </WorkbenchCourseNavigationProvider>
      </div>
      {target ? (
        <MaterialLibraryPage
          initialFocus={target}
          showBack
          onLeave={() => setTarget(null)}
          onChatWithMaterial={() => {}}
        />
      ) : null}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<FocusHandover />);
