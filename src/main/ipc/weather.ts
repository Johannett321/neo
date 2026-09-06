import { resolveTemperature } from '@shared/formats'
import type { TemperatureUnits } from '@shared/formats'
import { q1 } from '../db/client'
import { currentWeather, searchPlaces } from '../lib/weather'
import { handle } from './util'

/**
 * The weather, and the only handler in the app that opens a socket to the internet
 * without an API key having been given to it. `lib/weather.ts` says what does and
 * does not leave the machine; this is the part that decides whether to ask at all.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function registerWeatherHandlers(): void {
  handle('weather:get', async ({ workspaceId }) => {
    const row = await q1<any>(
      `SELECT weather_place, weather_latitude, weather_longitude, today_show_weather
       FROM workspace WHERE id = $1`,
      [workspaceId]
    )
    // Switched off means no request, not a request whose answer is thrown away. It is
    // the only setting in the app whose whole point is that nothing happens.
    if (!row || row.today_show_weather === false) return null

    // Asked for in the unit it will be drawn in, so nothing has to convert a
    // temperature afterwards and get the rounding a degree out.
    const chosen = await q1<{ value: string }>(
      "SELECT value FROM setting WHERE key = 'temperatureUnits'"
    )
    const units = resolveTemperature((chosen?.value ?? 'system') as TemperatureUnits)

    return currentWeather(
      {
        weatherPlace: row.weather_place ?? '',
        weatherLatitude: row.weather_latitude ?? null,
        weatherLongitude: row.weather_longitude ?? null
      },
      units
    )
  })

  handle('weather:search', async ({ query }) => searchPlaces(query))
}
