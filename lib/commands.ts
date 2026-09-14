export const commands = [
  {command:'/model',usage:'/model',description:'Open Habitats to edit an agent’s model.',example:'/model'},
  {command:'/task',usage:'/task [goal]',description:'Use your next message as an agent task.',example:'/task Create a script to summarize the report'},
  { command: '/googledrive', usage: '/googledrive [filename]', description: 'Choose a Google Drive file to import into Data.', example: '/googledrive project plan' },
  { command: '/connect', usage: '/connect', description: 'Open Add models in Habitats.', example: '/connect' },
  { command: '/model connect', usage: '/model connect', description: 'Open Add models in Habitats.', example: '/model connect' },
  { command: '/quickstart', usage: '/quickstart', description: 'Open the team setup guide and see what is ready.', example: '/quickstart' },
  { command: '/search', usage: '/search <words>', description: 'Find messages and thread replies you can read.', example: '/search launch checklist' },
  { command: '/run', usage: '/run <shell command>', description: 'Submit an exact command to Terminal. Members need admin approval.', example: '/run pwd' },
  { command: '/stop', usage: '/stop', description: 'Stop the latest active agent run in this conversation.', example: '/stop' },
  { command: '/terminal', usage: '/terminal', description: 'Open command requests, approvals, and output.', example: '/terminal' },
  { command: '/models', usage: '/models', description: 'Open Habitats to choose each agent’s machine or cloud home.', example: '/models' },
  { command: '/team', usage: '/team', description: 'Open team settings and invitations.', example: '/team' },
  { command: '/help', usage: '/help', description: 'Show all commands, examples, and model-switching help.', example: '/help' },
];
export function parseCommand(text: string) {
  if (text.trim() === '/') return { name: 'help', args: '' };
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1].toLowerCase(), args: (match[2] || '').trim() } : null;
}
