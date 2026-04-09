'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'system';

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: 'light' | 'dark';
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Production: always force light mode
  const [theme] = useState<Theme>('light');
  const resolvedTheme: 'light' | 'dark' = 'light';

  // Apply theme to document on mount
  useEffect(() => {
    document.documentElement.classList.remove('dark');
  }, []);

  // no-op setter — light mode is locked
  const handleSetTheme = (_newTheme: Theme) => {};

  return (
    <ThemeContext.Provider value={{ theme, setTheme: handleSetTheme, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
}
