import { providerOf } from '../../../shared/models'
import type { Mascot } from '../mascots/types'

// The name the main conversation speaks under until a mascot has a name of its own.
// Agents brought in show their own names on their cards, in the party panel, and
// in the inbox.
export const AGENT_NAME = 'Claude'

export function defaultSpeakerForModel(model?: string | null): string {
  if (!model) return AGENT_NAME
  const provider = providerOf(model)
  if (provider === 'codex') return 'Codex'
  if (provider === 'gemini') return 'Gemini'
  return AGENT_NAME
}

// The name the main conversation speaks under in CHAT: the active mascot's name, or
// the active provider's name (Codex, Gemini, Claude) when the built-in default mascot
// has not been renamed.
export function speakerName(mascot: Mascot, model?: string | null): string {
  return mascot.named ? mascot.name : defaultSpeakerForModel(model)
}
