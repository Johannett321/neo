/**
 * How numbers, dates and times *read*. Not what they are.
 *
 * These are machine-level, not per workspace, and that is the whole distinction: the
 * banner on Today is about which working life you are in, and a twenty-four hour clock
 * is about you. Nobody wants Celsius in the day job and Fahrenheit in their own
 * company. Shared rather than owned by either side, because main has to ask for a
 * forecast in the unit the renderer is going to draw.
 */

export type ClockFormat = 'system' | '12' | '24'
export type DateFormat = 'system' | 'dmy' | 'mdy' | 'ymd'
export type TemperatureUnits = 'system' | 'c' | 'f'

/**
 * The places that still read temperature in Fahrenheit. Deliberately a short list of
 * regions rather than a guess from the language: `en` is spoken in both hemispheres of
 * this argument, and it is the country that decides.
 */
const FAHRENHEIT_REGIONS = new Set(['US', 'BS', 'BZ', 'KY', 'PW', 'FM', 'MH', 'LR'])

/** The machine's own region, or an empty string when it will not say. */
function region(): string {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale
    // "en-US" and "en-Latn-US" both end in the region; anything else has none.
    const found = locale.split('-').find((part) => /^[A-Z]{2}$/.test(part))
    return found ?? ''
  } catch {
    return ''
  }
}

/** What "system" actually means here, resolved to the one thing an API can be asked for. */
export function resolveTemperature(choice: TemperatureUnits): 'c' | 'f' {
  if (choice === 'c' || choice === 'f') return choice
  return FAHRENHEIT_REGIONS.has(region()) ? 'f' : 'c'
}
