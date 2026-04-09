'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface HighlightProps {
  target: string; // CSS selector
  duration?: number;
  color?: string;
}

export function Highlight({ target, color = 'rgba(139, 92, 246, 0.3)' }: HighlightProps) {
  const [position, setPosition] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    const element = document.querySelector(target);
    if (!element) return;

    const rect = element.getBoundingClientRect();
    setPosition({
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    });

    // Update position on scroll/resize
    const updatePosition = () => {
      const newRect = element.getBoundingClientRect();
      setPosition({
        top: newRect.top,
        left: newRect.left,
        width: newRect.width,
        height: newRect.height,
      });
    };

    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);

    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [target, mounted]);

  if (!mounted || !position) return null;

  return createPortal(
    <div
      style={{
        position: 'fixed',
        top: position.top - 4,
        left: position.left - 4,
        width: position.width + 8,
        height: position.height + 8,
        border: `2px solid ${color}`,
        borderRadius: 8,
        pointerEvents: 'none',
        zIndex: 9999,
        animation: 'pulse 2s infinite',
      }}
    />,
    document.body
  );
}