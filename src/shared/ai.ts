/**
 * Which models the assistant offers, named in both processes: the main process
 * sends one to OpenAI, and workspace settings has to be able to list them without
 * reaching into the main process to find out what they are.
 *
 * Deliberately a short list rather than every model that exists. This is a settings
 * pane in a personal app, not a model catalogue, and the choice that matters is
 * only ever "is this question worth the more expensive one".
 */
export interface AiModel {
  id: string
  label: string
  hint: string
}

export const DEFAULT_MODEL = 'gpt-5.2'

export const MODELS: AiModel[] = [
  { id: 'gpt-5.2', label: 'GPT-5.2', hint: 'The default. Good judgement, sensible cost.' },
  { id: 'gpt-5.4', label: 'GPT-5.4', hint: 'Stronger reasoning for tangled questions.' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', hint: 'Faster and cheaper; fine for lookups.' },
  { id: 'gpt-5.5', label: 'GPT-5.5', hint: 'The most capable, and the most expensive.' }
]

/**
 * How wide the assistant panel is, in pixels. It is a preference like the theme, so
 * it is persisted like the theme — in the settings table, not in browser storage,
 * because everything this app remembers lives in the folder you can back up.
 *
 * The maximum is a function of the window rather than a constant: the panel may take
 * a lot of room, but never so much that the screen behind it stops being usable.
 */
export const ASSISTANT_WIDTH = { default: 420, min: 340, max: 760 }

export const clampAssistantWidth = (width: number, windowWidth: number): number =>
  Math.max(
    ASSISTANT_WIDTH.min,
    Math.min(width, ASSISTANT_WIDTH.max, Math.max(ASSISTANT_WIDTH.min, windowWidth - 620))
  )
