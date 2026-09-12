import demo from './bell-demo.json';
import type { BuzzEnv } from './db';
import { embed } from './context';

export const BELL_COLLECTIONS = demo.collections.map(collection => collection.name);
const stamp = '2026-09-12T13:00:00.000Z';
const legacyProfiles = [{"name": "Atlas", "instructions": "You are the engineering specialist. Give precise technical answers, propose small concrete patches or prototypes, and name the files or systems involved."}, {"name": "Sage", "instructions": "You coordinate work. Break objectives into bounded subtasks with owners and acceptance criteria, surface blockers, and keep decisions and open questions explicit."}, {"name": "Nova", "instructions": "You are the product specialist. Write short design briefs: problem, evidence, proposal, open questions. Cite the sources you used."}, {"name": "Iris", "instructions": "You are the support specialist. Prepare sourced customer responses from policy and account evidence. Flag anything that needs human approval before it is sent."}, {"name": "Scout", "instructions": "You research. Compare sources, report findings with citations, and state confidence and gaps."}, {"name": "Ledger", "instructions": "You handle finance questions. Use only evidence at your access level, show the numbers you relied on, and never estimate figures you cannot source."}];
const characters = ['octopus', 'sea-turtle', 'seahorse', 'seal', 'pufferfish', 'octopus'];
const tones = ['mint', 'gold', 'lilac', 'coral', 'sky', 'slate'];
const collectionName = (id: string) => demo.collections.find(collection => collection.id === id)!.name;
const name = (id: string) => [...demo.members, ...demo.agents].find(member => member.id === id)!.name;
const sourceText = (source: typeof demo.documents[number]) => `# ${source.title}\n\nFictional Shell Corporation demo evidence · ${source.classification}\nLogical source: ${source.path}\n\n${source.body}\n`;

/** Add the fictional corpus once; retain existing conversations, custom profiles and files. */
export async function seedBell(env: BuzzEnv) {
  await env.DB.prepare("UPDATE documents SET error = 'Keyword search only: Shell demo embeddings have not been generated.' WHERE id LIKE 'bell-%' AND status = 'ready' AND error IS NULL AND EXISTS(SELECT 1 FROM chunks WHERE document_id = documents.id AND embedding IS NULL)").run();
  if (await env.DB.prepare("SELECT 1 FROM settings WHERE key = 'bell_demo_v1'").first()) return;
  const vectors = await embed(env, demo.documents.map(sourceText));
  const statements: D1PreparedStatement[] = [];
  for (const person of demo.members) statements.push(env.DB.prepare('INSERT OR IGNORE INTO members(id, kind, name, initials, tone, data) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(person.id, 'human', person.name, person.name.slice(0, 2).toUpperCase(), 'sky', JSON.stringify({ role: person.role, team: person.team })));
  for (const [index, agent] of demo.agents.entries()) {
    const channels = demo.channels.filter(channel => channel.memberIds.includes(agent.id)).map(channel => channel.name);
    const data = {
      demo: true, role: agent.role, description: agent.purpose, goal: agent.goal,
      instructions: `${demo.tenant.demoNotice}\nYour purpose: ${agent.purpose}\nGoal: ${agent.goal}\n${agent.writeBoundary}\nHuman review: ${agent.approvalGate}\nExcluded: ${agent.excluded.join(', ')}. Cite evidence as [source §n]. Distinguish measured results, proposed tests, and approved decisions. Logical access paths describe source scopes; they are not connected external tools.`,
      character: characters[index], color: tones[index], owner: name(agent.ownerId),
      channels, context: agent.readCollections.map(collectionName), audiences: [...new Set(agent.audienceScopes)],
      accessLevel: agent.classification, accessPaths: agent.accessPaths, approvalGates: [agent.approvalGate],
      examplePrompts: agent.examplePrompts, capabilities: ['Retrieve scoped evidence', 'Draft analysis', 'Prepare review'],
      allowedTaskIds: demo.tasks.filter(task => task.agentId === agent.id).map(task => `bell-${task.id}`),
      runtime: 'local', homeId: 'lab', model: '', device: 'Local GB10',
    };
    statements.push(env.DB.prepare(`INSERT INTO members(id, kind, name, initials, tone, data) VALUES (?, 'agent', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data WHERE members.kind = 'agent' AND members.name = ? AND json_extract(members.data, '$.instructions') = ? AND json_extract(members.data, '$.homeId') = 'lab' AND json_extract(members.data, '$.runtime') = 'local' AND json_extract(members.data, '$.context') = ?`)
      .bind(agent.id, agent.name, agent.name.slice(0, 2), tones[index], JSON.stringify(data), legacyProfiles[index].name, legacyProfiles[index].instructions, JSON.stringify([["Engineering", "Company"], ["Company", "Product"], ["Product", "Company"], ["Support", "Company"], ["Company", "Product", "Engineering"], ["Company"]][index])));
  }
  for (const [index, project] of demo.projects.entries()) statements.push(env.DB.prepare('INSERT OR IGNORE INTO projects(id, name, description, color) VALUES (?, ?, ?, ?)')
    .bind(project.id, project.name, project.description, ['blue', 'violet', 'green', 'amber'][index]));
  for (const task of demo.tasks) {
    const docs = task.documentIds.map(id => demo.documents.find(doc => doc.id === id)!.title);
    const blocker = 'blocker' in task ? task.blocker : '';
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO tasks(id, project, title, description, status, owner, priority, due, label, comments, criteria, deliverable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(`bell-${task.id}`, task.projectId, task.title,
        `Fictional demo task. Reviewer: ${name(task.ownerId)}.\nSources: ${docs.join('; ')}.${blocker ? `\nBlocked: ${blocker}` : ''}`,
        task.status === 'Todo' ? 'Backlog' : task.status, name(task.agentId), task.priority, task.dueDate, blocker ? 'Blocked' : 'Demo',
        JSON.stringify([`Demo snapshot · ${name(task.ownerId)}: ${blocker || 'Review against the acceptance criteria and cited source evidence.'}`]), task.acceptanceCriteria,
        task.status === 'Done' ? `Illustrative completed deliverable — ${task.acceptanceCriteria}` : null, stamp));
  }
  let messageIndex = 0;
  for (const channel of demo.channels) {
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO channels(name, created_at) VALUES (?, ?)').bind(channel.name, stamp));
    for (const message of channel.messages) {
      const ts = new Date(Date.parse(stamp) + messageIndex * 180000).toISOString();
      statements.push(env.DB.prepare("INSERT OR IGNORE INTO messages(id, room, member_id, name, body, created_at, state) VALUES (?, ?, ?, ?, ?, ?, 'complete')")
        .bind(`bell-message-${messageIndex++}`, channel.name, message.authorId, name(message.authorId), message.text, ts));
    }
  }
  for (const [index, source] of demo.documents.entries()) {
    const collection = demo.collections.find(collection => collection.id === source.collectionId)!;
    const agents = demo.agents.filter(agent => agent.readCollections.includes(source.collectionId)).map(agent => agent.id);
    const id = `bell-${source.id}`;
    const filename = source.path.split('/').pop()!;
    const text = sourceText(source);
    const key = `bell-demo/${source.path}`;
    await env.BUCKET.put(key, text, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } });
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO documents(id, name, type, size, collection, level, owner, audiences, agents, status, text_chars, chunk_count, updated_at, r2_key, error) VALUES (?, ?, 'text/markdown', ?, ?, ?, ?, ?, ?, 'ready', ?, 1, ?, ?, ?)")
        .bind(id, filename, new TextEncoder().encode(text).length, collection.name, source.classification, name(source.ownerId), JSON.stringify(collection.audience), JSON.stringify(agents), text.length, `${source.updatedAt}T12:00:00.000Z`, key, vectors ? null : 'Keyword search only: Shell demo embeddings have not been generated.'),
      env.DB.prepare('INSERT OR IGNORE INTO chunks(id, document_id, idx, text, embedding) VALUES (?, ?, 0, ?, ?)').bind(`${id}:0`, id, text, vectors ? JSON.stringify(vectors[index]) : null),
      env.DB.prepare('INSERT INTO chunks_fts(chunk_id, document_id, text) SELECT ?, ?, ? WHERE NOT EXISTS(SELECT 1 FROM chunks_fts WHERE chunk_id = ?)').bind(`${id}:0`, id, text, `${id}:0`),
    );
  }
  for (const taskId of ['SUM-103', 'HOR-204', 'CED-401']) {
    const task = demo.tasks.find(task => task.id === taskId)!;
    const agent = demo.agents.find(agent => agent.id === task.agentId)!;
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO approvals(id, title, agent, body, action, status, level, recipient, workflow, source, created_at) VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?, ?, 'bell-demo', ?)")
      .bind(`bell-review-${task.id}`, `Demo review · ${task.title}`, agent.name,
        `Synthetic review request. ${task.acceptanceCriteria}\n\nApproving records a demo decision only. No publication, purchase, hardware change, or command is executed.`,
        JSON.stringify({ type: 'demo_review', taskId: `bell-${task.id}`, effect: 'Record a review decision only' }), agent.classification, name(task.ownerId), 'Shell engineering review', stamp));
  }
  statements.push(
    env.DB.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES ('rules', ?)").bind(`${demo.tenant.demoNotice} Cite source evidence. Keep proposed tests separate from observed results. Do not claim an external action occurred without a real receipt.`),
    env.DB.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES ('rules_version', '1')"),
    env.DB.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES ('bell_demo_v1', ?)").bind(stamp),
  );
  await env.DB.batch(statements);
}
