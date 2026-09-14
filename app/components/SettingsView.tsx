import { TeamSettings } from './TeamSettings';
import { PageHeader } from '@/components/buzz/PageHeader';
export type Preferences = { compact: boolean; shortcuts: boolean };
type Props = { preferences: Preferences; setPreferences: (value: Preferences) => void };
export function SettingsView({ preferences, setPreferences }: Props) {
  return <div className="page settings-simple">
    <PageHeader className="page-heading" title="Settings" />
    <TeamSettings />
    <details className="settings-personal"><summary>Display and shortcuts</summary>
      <label className="team-check"><input type="checkbox" checked={preferences.compact} onChange={event => setPreferences({ ...preferences, compact: event.target.checked })}/>Compact conversations</label>
      <label className="team-check"><input type="checkbox" checked={preferences.shortcuts} onChange={event => setPreferences({ ...preferences, shortcuts: event.target.checked })}/>Use ⌘ / Ctrl K for workspace search</label>
    </details>
  </div>;
}
