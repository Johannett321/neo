/**
 * WMO weather codes, in the words a person would use looking out of the window, with
 * the icon that goes with each.
 *
 * Shared rather than owned by either side, for the reason every table in this folder
 * is: main puts the words on the reading it fetched, the renderer draws the picture,
 * and the two cannot drift into describing different weather. `night` is the variant
 * for a code that would otherwise be drawn with a sun in it at nine in the evening.
 */
export interface Condition {
  text: string
  icon: string
  night?: string
}

export const CONDITIONS: Record<number, Condition> = {
  0: { text: 'Clear', icon: 'weatherSun', night: 'weatherMoon' },
  1: { text: 'Mostly clear', icon: 'weatherSun', night: 'weatherMoon' },
  2: { text: 'Partly cloudy', icon: 'weatherPartly', night: 'weatherPartlyNight' },
  3: { text: 'Overcast', icon: 'weatherCloud' },
  45: { text: 'Fog', icon: 'weatherFog' },
  48: { text: 'Freezing fog', icon: 'weatherFog' },
  51: { text: 'Light drizzle', icon: 'weatherDrizzle' },
  53: { text: 'Drizzle', icon: 'weatherDrizzle' },
  55: { text: 'Heavy drizzle', icon: 'weatherDrizzle' },
  56: { text: 'Freezing drizzle', icon: 'weatherDrizzle' },
  57: { text: 'Freezing drizzle', icon: 'weatherDrizzle' },
  61: { text: 'Light rain', icon: 'weatherRain' },
  63: { text: 'Rain', icon: 'weatherRain' },
  65: { text: 'Heavy rain', icon: 'weatherRain' },
  66: { text: 'Freezing rain', icon: 'weatherRain' },
  67: { text: 'Freezing rain', icon: 'weatherRain' },
  71: { text: 'Light snow', icon: 'weatherSnow' },
  73: { text: 'Snow', icon: 'weatherSnow' },
  75: { text: 'Heavy snow', icon: 'weatherSnow' },
  77: { text: 'Snow grains', icon: 'weatherSnow' },
  80: { text: 'Showers', icon: 'weatherRain' },
  81: { text: 'Showers', icon: 'weatherRain' },
  82: { text: 'Heavy showers', icon: 'weatherRain' },
  85: { text: 'Snow showers', icon: 'weatherSnow' },
  86: { text: 'Snow showers', icon: 'weatherSnow' },
  95: { text: 'Thunderstorm', icon: 'weatherStorm' },
  96: { text: 'Thunderstorm', icon: 'weatherStorm' },
  99: { text: 'Thunderstorm', icon: 'weatherStorm' }
}

/** The words and the icon for a code, given whether the sun is up where it was read. */
export function describeWeather(code: number, isDay = true): { text: string; icon: string } {
  const found = CONDITIONS[code]
  if (!found) return { text: '', icon: 'weatherCloud' }
  return { text: found.text, icon: !isDay && found.night ? found.night : found.icon }
}
