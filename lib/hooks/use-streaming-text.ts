import { useState, useEffect, useCallback, useRef } from 'react';

export interface StreamingTextOptions {
  text: string;
  speed?: number; // characters/second, default 30
  onComplete?: () => void;
  enabled?: boolean; // whether to enable streaming, default true
}

export interface StreamingTextResult {
  displayedText: string;
  isStreaming: boolean;
  skip: () => void;
  reset: () => void;
}

/**
 * Streaming Text Hook
 *
 * Implements a character-by-character text display effect
 *
 * @param options - Configuration options
 * @returns Streaming text state and control functions
 */
export function useStreamingText(options: StreamingTextOptions): StreamingTextResult {
  const { text, speed = 30, onComplete, enabled = true } = options;

  const [displayedText, setDisplayedText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  const frameRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const lastIndexRef = useRef(0);

  /**
   * Skip streaming animation and display all text immediately
   */
  const skip = useCallback(() => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    setDisplayedText(text);
    setIsStreaming(false);
    startTimeRef.current = null;
    lastIndexRef.current = text.length;
    onComplete?.();
  }, [text, onComplete]);

  /**
   * Reset streaming state
   */
  const reset = useCallback(() => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    setDisplayedText('');
    setIsStreaming(false);
    startTimeRef.current = null;
    lastIndexRef.current = 0;
  }, []);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- Animation driver: synchronous state transitions are intentional for streaming text display */
    // If streaming is disabled or text is empty, display all text immediately
    if (!enabled || !text) {
      setDisplayedText((prev) => (prev !== text ? text : prev));
      setIsStreaming((prev) => (prev ? false : prev));
      return;
    }

    // Limit max text length (disable streaming for text over 500 characters)
    if (text.length > 500) {
      setDisplayedText(text);
      setIsStreaming(false);
      onComplete?.();
      return;
    }

    // Start streaming display
    setIsStreaming(true);
    setDisplayedText('');
    /* eslint-enable react-hooks/set-state-in-effect */
    lastIndexRef.current = 0;

    const animate = (timestamp: number) => {
      if (!startTimeRef.current) {
        startTimeRef.current = timestamp;
      }

      const elapsed = timestamp - startTimeRef.current;
      const targetIndex = Math.min(Math.floor((elapsed / 1000) * speed), text.length);

      if (targetIndex > lastIndexRef.current) {
        lastIndexRef.current = targetIndex;
        setDisplayedText(text.slice(0, targetIndex));
      }

      if (targetIndex < text.length) {
        frameRef.current = requestAnimationFrame(animate);
      } else {
        setIsStreaming(false);
        startTimeRef.current = null;
        onComplete?.();
      }
    };

    frameRef.current = requestAnimationFrame(animate);

    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [text, speed, enabled, onComplete]);

  return {
    displayedText,
    isStreaming,
    skip,
    reset,
  };
}
