'use client';

import { useEffect, useState } from 'react';

type ClientTimezoneInputProps = {
  initialTimeZone: string;
};

export function ClientTimezoneInput({ initialTimeZone }: ClientTimezoneInputProps) {
  const [timeZone, setTimeZone] = useState(initialTimeZone || 'UTC');

  useEffect(() => {
    const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (localTimeZone) {
      setTimeZone(localTimeZone);
    }
  }, []);

  return <input type="hidden" name="tz" value={timeZone} readOnly />;
}
