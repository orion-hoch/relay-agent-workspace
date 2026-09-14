'use client';
import { useCallback, useRef, useLayoutEffect, type SetStateAction } from 'react';
import { buzz, useBuzz } from './store';

export function useWorkspaceSetting<T>(key: string, initial: T): [T, (value: SetStateAction<T>) => void] {
  const { uiState, loaded } = useBuzz();
  const current = useRef(initial);
  const value = (uiState?.[key] ?? initial) as T;
  useLayoutEffect(() => { current.current = value; }, [value]);
  const set = useCallback((update: SetStateAction<T>) => {
    if (!loaded) { window.dispatchEvent(new CustomEvent('shoal:notice', { detail: 'Workspace is loading. Try again in a moment.' })); return; }
    const next = typeof update === 'function' ? (update as (value: T) => T)(current.current) : update;
    current.current = next;
    void buzz.saveWorkspaceSetting(key, next).catch(error => {
      window.dispatchEvent(new CustomEvent('shoal:notice', { detail: error instanceof Error ? error.message : 'Could not save workspace changes.' }));
    });
  }, [key, loaded]);
  return [value, set];
}
