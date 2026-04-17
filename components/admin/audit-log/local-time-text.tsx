'use client';

import { useEffect, useState } from 'react';

type LocalTimeTextProps = {
  iso: string;
};

export function LocalTimeText({ iso }: LocalTimeTextProps) {
  const [text, setText] = useState('');

  useEffect(() => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      setText('Invalid date');
      return;
    }
    setText(date.toLocaleString());
  }, [iso]);

  return <>{text || '...'}</>;
}
