import type { InterestsConfig } from "../config.js";

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Case-insensitive substring match against the muted phrases. */
export function isMuted(text: string, mute: string[]): boolean {
  const t = text.toLowerCase();
  return mute.some((m) => m.trim().length > 0 && t.includes(m.trim().toLowerCase()));
}

export function interestsBlock(interests: InterestsConfig): string {
  return interests.topics
    .map((t) => `- ${t.name} (weight ${t.weight}): ${t.description}`)
    .join("\n");
}
