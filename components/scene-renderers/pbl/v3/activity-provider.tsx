'use client';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { useStageStore } from '@/lib/store';
import { createPblActivity, PBL_ACTIVITY_INTERVAL_MS } from '@/lib/pbl/v3/activity';

const Activity = createContext({
  sceneId: '',
  generation: 0,
  input: (_event: SyntheticEvent) => {},
});
export function usePblActivityGeneration(sceneId: string) {
  const activity = useContext(Activity);
  return activity.sceneId === sceneId ? activity.generation : 0;
}

export function usePblActivityInput(sceneId: string) {
  const activity = useContext(Activity);
  return activity.sceneId === sceneId ? activity.input : undefined;
}

/** Lives above scene rendering: whiteboard/fullscreen changes do not invent a departure. */
export function PblActivityProvider({
  classroomId,
  children,
}: {
  classroomId: string;
  children: ReactNode;
}) {
  const scene = useStageStore((s) =>
    s.stage?.id === classroomId ? s.scenes.find((item) => item.id === s.currentSceneId) : undefined,
  );
  const sceneId = scene?.content.type === 'pbl' && scene.content.projectV3 ? scene.id : '';
  const [activity, setActivity] = useState({ sceneId: '', generation: 0 });
  const reporter = useRef<ReturnType<typeof createPblActivity> | null>(null);
  useEffect(() => {
    if (!sceneId) {
      reporter.current = null;
      return;
    }
    let nextWake = 0;
    const current = createPblActivity(
      async () => {
        const response = await fetch('/api/pbl/v3/activity', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-openmaic-sandbox': '1' },
          body: JSON.stringify({ stageId: classroomId, sceneId }),
          signal: AbortSignal.timeout(10_000),
        });
        return response.ok && (await response.json()).recorded === true;
      },
      () => {
        if (Date.now() < nextWake) return;
        nextWake = Date.now() + 1000;
        setActivity((prior) => ({ sceneId, generation: prior.generation + 1 }));
      },
    );
    reporter.current = current;
    const enter = () => {
      if (document.visibilityState !== 'visible') return;
      nextWake = 0;
      current.mark();
    };
    enter();
    document.addEventListener('visibilitychange', enter);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void current.flush();
    }, PBL_ACTIVITY_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', enter);
      if (reporter.current === current) reporter.current = null;
    };
  }, [classroomId, sceneId]);
  const input = (event: SyntheticEvent) => {
    if (event.isTrusted && document.visibilityState === 'visible') reporter.current?.mark();
  };
  return <Activity.Provider value={{ ...activity, input }}>{children}</Activity.Provider>;
}
