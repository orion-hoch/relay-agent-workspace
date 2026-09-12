// Grouped navigation/rows adapted from Buzz SettingsView and SettingsOptionGroup.
import { useWorkspaceName, setWorkspaceName } from '@/lib/workspace-name';
import { useState } from 'react';
import { ArrowUpRight, Building2, Settings2, Plug } from 'lucide-react';
import { PageHeader } from '@/components/buzz/PageHeader';

type Section = 'workspace' | 'preferences' | 'connections';
type Props = {
  navigate: (view: string) => void;
  preferences: boolean[];
  setPreferences: (value: boolean[]) => void;
};
const sections = [
  { id: 'workspace' as const, label: 'Workspace', icon: Building2 },
  { id: 'preferences' as const, label: 'Preferences', icon: Settings2 },
  { id: 'connections' as const, label: 'Connections', icon: Plug },
];
const preferenceRows = [
  {
    label: 'Desktop notifications',
    description: 'Mentions and review requests.',
  },
  {
    label: 'Compact conversation density',
    description: 'Show more messages in channels.',
  },
  {
    label: 'Keyboard shortcuts',
    description: 'Open workspace search with ⌘ / Ctrl K.',
  },
];
export function SettingsView({ navigate, preferences, setPreferences }: Props) {
  const [section, setSection] = useState<Section>('workspace');
  const workspaceName = useWorkspaceName();
  const [draftName, setDraftName] = useState<string | null>(null);
  const nameValue = draftName ?? workspaceName;
  const [message, setMessage] = useState('');
  async function saveName() {
    const next = nameValue.trim();
    if (!next) {
      setMessage('Enter a workspace name.');
      return;
    }
    setMessage('Saving…');
    try {
      await setWorkspaceName(next);
      setDraftName(null);
      setMessage('Saved');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save workspace name.');
    }
  }
  return (
    <div className="page quality-settings">
      <PageHeader className="page-heading" title="Settings" />
      <div className="settings-layout">
        <nav className="settings-sections" aria-label="Settings sections">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={section === id ? 'selected' : ''}
              aria-current={section === id ? 'page' : undefined}
              onClick={() => {
                setSection(id);
                setMessage('');
              }}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>
        <section
          className="settings-section"
          aria-labelledby="settings-section-heading"
        >
          <h2 id="settings-section-heading">
            {sections.find((item) => item.id === section)?.label}
          </h2>
          {section === 'workspace' && (
            <div className="settings-group">
              <form
                className="settings-name-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveName();
                }}
              >
                <label htmlFor="settings-workspace-name">Workspace name</label>
                <div>
                  <input
                    id="settings-workspace-name"
                    className="input"
                    value={nameValue}
                    maxLength={60}
                    onChange={(event) => {
                      setDraftName(event.target.value);
                      setMessage('');
                    }}
                  />
                  <button
                    className="btn btn-secondary"
                    type="submit"
                    disabled={nameValue.trim() === workspaceName}
                  >
                    Save
                  </button>
                </div>
                {message && (
                  <output className="settings-save-status" aria-live="polite">
                    {message}
                  </output>
                )}
              </form>
              <dl className="settings-owner-row">
                <dt>Owner</dt>
                <dd>You</dd>
              </dl>
            </div>
          )}
          {section === 'preferences' && (
            <div className="settings-group">
              {preferenceRows.map(({ label, description }, index) => (
                <div className="settings-preference-row" key={label}>
                  <div>
                    <span id={`setting-label-${index}`}>{label}</span>
                    <p id={`setting-description-${index}`}>{description}</p>
                  </div>
                  <button
                    type="button"
                    className={`settings-switch ${preferences[index] ? 'checked' : ''}`}
                    role="switch"
                    aria-labelledby={`setting-label-${index}`}
                    aria-describedby={`setting-description-${index}`}
                    aria-checked={!!preferences[index]}
                    onClick={() =>
                      setPreferences(
                        Array.from(
                          { length: Math.max(3, preferences.length) },
                          (_, position) =>
                            position === index
                              ? !preferences[position]
                              : !!preferences[position],
                        ),
                      )
                    }
                  >
                    <span />
                  </button>
                </div>
              ))}
            </div>
          )}
          {section === 'connections' && (
            <div className="settings-group">
              <button className="settings-link-row" onClick={() => navigate('compute')}>
                <span><strong>Habitats</strong><small>Homes, members, and access</small></span>
                <ArrowUpRight size={18} />
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
