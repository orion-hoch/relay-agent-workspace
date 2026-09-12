import type { BuzzEnv } from './db';

const profiles: Record<string, [string, string]> = {
  atlas: ['Engineering partner', 'Turns technical questions into clear answers and helps the team ship with confidence.'],
  sage: ['Operations partner', 'Connects the dots across projects, finds blockers, and keeps every handoff moving.'],
  nova: ['Creative partner', 'A thoughtful collaborator for campaign ideas, launch stories, and your next first draft.'],
  iris: ['Customer partner', 'Brings the customer perspective to every conversation, with the right account context.'],
  scout: ['Research partner', 'Explores new questions, compares sources, and brings useful findings back to the team.'],
  ledger: ['Finance partner', 'Makes financial context easier to understand while keeping sensitive work close to home.'],
};

export async function cleanDemoProfiles(env: BuzzEnv) {
  if (await env.DB.prepare("SELECT 1 FROM settings WHERE key='github_profiles_v1'").first()) return;
  const rows = await env.DB.prepare("SELECT id, data FROM members WHERE kind='agent'").all<{ id: string; data: string }>();
  const statements: D1PreparedStatement[] = [];
  for (const row of rows.results) {
    const data = JSON.parse(row.data) as Record<string, unknown>;
    const profile = profiles[row.id];
    if (!profile || data.demo !== true) continue;
    for (const key of ['goal', 'accessPaths', 'approvalGates', 'examplePrompts', 'purpose', 'writeBoundary', 'excluded']) delete data[key];
    data.role = profile[0];
    data.description = profile[1];
    data.instructions = profile[1];
    // Existing document/channel permissions remain enforced; they are not editor fields.
    statements.push(env.DB.prepare('UPDATE members SET data=? WHERE id=?').bind(JSON.stringify(data), row.id));
  }
  statements.push(env.DB.prepare("INSERT INTO settings(key,value) VALUES ('github_profiles_v1','1')"));
  await env.DB.batch(statements);
}
