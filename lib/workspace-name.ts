'use client';
import { buzz, useBuzz } from './buzz/store';
export function useWorkspaceName() {
  const { uiState } = useBuzz();
  return typeof uiState?.workspaceName === 'string' ? uiState.workspaceName : 'Shell Engineering';
}
export async function setWorkspaceName(value: string) {
  await buzz.saveWorkspaceSetting('workspaceName', value.trim().slice(0, 60) || 'Shell Engineering');
}
