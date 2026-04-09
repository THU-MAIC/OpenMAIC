'use client';

import { useState, useCallback } from 'react';
import type { TeacherAction } from '@/lib/types/widgets';
import { SpeechBar } from './shared/SpeechBar';
import { Button } from '@/components/ui/button';
import { ChevronRight, ChevronLeft, MessageSquare } from 'lucide-react';

interface TeacherOverlayProps {
  actions: TeacherAction[];
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  onComplete?: () => void;
  /** If true, add extra bottom margin to avoid Roundtable overlap */
  inPlaybackMode?: boolean;
}

export function TeacherOverlay({ actions, iframeRef, onComplete, inPlaybackMode }: TeacherOverlayProps) {
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [activeAction, setActiveAction] = useState<TeacherAction | null>(null);
  const [showSpeech, setShowSpeech] = useState(false);

  const sendMessageToIframe = useCallback((type: string, payload: Record<string, unknown>) => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ type, ...payload }, '*');
    }
  }, [iframeRef]);

  const executeAction = useCallback((action: TeacherAction) => {
    setActiveAction(action);
    setShowSpeech(false);

    // Handle different action types
    switch (action.type) {
      case 'speech':
        setShowSpeech(true);
        break;

      case 'highlight':
        // Send highlight message to iframe
        if (action.target) {
          sendMessageToIframe('HIGHLIGHT_ELEMENT', {
            target: action.target,
            content: action.content,
          });
        }
        // Show content as speech if present
        if (action.content) {
          setShowSpeech(true);
        }
        break;

      case 'annotation':
        // Send annotation message to iframe
        if (action.target) {
          sendMessageToIframe('ANNOTATE_ELEMENT', {
            target: action.target,
            content: action.content,
          });
        }
        // Show content as speech if present
        if (action.content) {
          setShowSpeech(true);
        }
        break;

      case 'setState':
        // Send state update message to iframe
        if (action.state) {
          sendMessageToIframe('SET_WIDGET_STATE', { state: action.state });
        }
        // Show content as speech if present
        if (action.content) {
          setShowSpeech(true);
        }
        break;

      case 'reveal':
        // Send reveal message to iframe
        if (action.target) {
          sendMessageToIframe('REVEAL_ELEMENT', { target: action.target });
        }
        // Show content as speech if present
        if (action.content) {
          setShowSpeech(true);
        }
        break;

      default:
        break;
    }
  }, [sendMessageToIframe]);

  const nextAction = useCallback(() => {
    const nextIndex = currentIndex + 1;
    if (nextIndex < actions.length) {
      setCurrentIndex(nextIndex);
      executeAction(actions[nextIndex]);
    } else {
      setActiveAction(null);
      setShowSpeech(false);
      onComplete?.();
    }
  }, [currentIndex, actions, executeAction, onComplete]);

  const prevAction = useCallback(() => {
    const prevIndex = currentIndex - 1;
    if (prevIndex >= 0) {
      setCurrentIndex(prevIndex);
      executeAction(actions[prevIndex]);
    } else {
      setCurrentIndex(-1);
      setActiveAction(null);
      setShowSpeech(false);
    }
  }, [currentIndex, actions, executeAction]);

  const handleSpeechClose = useCallback(() => {
    setShowSpeech(false);
  }, []);

  const hasActions = actions.length > 0;
  const isComplete = currentIndex >= actions.length - 1 && activeAction === null;

  if (!hasActions) return null;

  return (
    <>
      {/* Speech bar */}
      {showSpeech && activeAction?.content && (
        <SpeechBar
          text={activeAction.content}
          onClose={handleSpeechClose}
          inPlaybackMode={inPlaybackMode}
        />
      )}

      {/* Navigation controls */}
      <div className={`fixed left-1/2 -translate-x-1/2 flex items-center gap-2 bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm rounded-full px-3 py-2 shadow-lg border border-gray-200 dark:border-gray-700 z-[60] ${inPlaybackMode ? 'bottom-52' : 'bottom-20'}`}>
        <Button
          variant="ghost"
          size="icon"
          onClick={prevAction}
          disabled={currentIndex < 0}
          className="size-8"
        >
          <ChevronLeft className="size-4" />
        </Button>

        <div className="flex items-center gap-1 px-2">
          <MessageSquare className="size-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            {currentIndex < 0 ? '开始导引' : `${currentIndex + 1} / ${actions.length}`}
          </span>
        </div>

        <Button
          variant="ghost"
          size="icon"
          onClick={nextAction}
          disabled={isComplete}
          className="size-8"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </>
  );
}