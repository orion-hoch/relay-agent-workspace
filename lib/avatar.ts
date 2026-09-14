const colors = [
  { backgroundColor: '#f2ded4', color: '#805744' },
  { backgroundColor: '#e5dff1', color: '#665183' },
  { backgroundColor: '#dcebe4', color: '#3d6d58' },
  { backgroundColor: '#dce7f1', color: '#426583' },
  { backgroundColor: '#f0e5c9', color: '#7b6934' },
  { backgroundColor: '#f0dce4', color: '#824f64' },
];
export function avatarColor(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return colors[hash % colors.length];
}

export const agentInitials = (name: string) => name.trim().split(/\s+/).slice(0,2).map(part => Array.from(part)[0]).join('').toUpperCase() || '?';
