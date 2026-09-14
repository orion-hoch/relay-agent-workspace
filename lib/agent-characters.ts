/** Shared portrait registry; every sheet is idle/sleep/thinking/stuck in a 2×2 grid. */
export const AGENT_CHARACTERS = ['octopus', 'sea-turtle', 'seal', 'pufferfish', 'seahorse'] as const;
export type AgentCharacter = typeof AGENT_CHARACTERS[number];
// Keep stored profiles compatible while retiring the original land-animal portraits.
export function normalizeAgentCharacter(value: unknown): AgentCharacter {
  const aliases: Record<string, AgentCharacter> = { worm: 'octopus', firefly: 'pufferfish', ladybug: 'seahorse', caterpillar: 'sea-turtle' };
  if (typeof value !== 'string') return 'octopus';
  return AGENT_CHARACTERS.includes(value as AgentCharacter) ? value as AgentCharacter : aliases[value] ?? 'octopus';
}
