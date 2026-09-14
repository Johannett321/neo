import { resolveTemperature } from '@shared/formats'
import { api, must } from '../lib/cloud/client'
import { loadSession } from '../lib/cloud/session'
import { currentWeather, searchPlaces } from '../lib/weather'
import { handle } from './util'

/**
 * The weather, and the only handler in the app that opens a socket to anywhere but Neo
 * Cloud without an API key having been given to it. `lib/weather.ts` says what does and
 * does not leave the machine; this is the part that decides whether to ask at all.
 */
export function registerWeatherHandlers(): void {
  handle('weather:get', async ({ workspaceId }) => {
    if (!loadSession()) return null
    try {
      const [workspaces, settings] = await Promise.all([
        must(api.GET('/v1/workspaces')),
        must(api.GET('/v1/settings'))
      ])
      const workspace = (workspaces as { id: string; weatherPlace: string; weatherLatitude: number | null;
        weatherLongitude: number | null; todayShowWeather: boolean }[]).find((w) => w.id === workspaceId)
      // Switched off means no request, not a request whose answer is thrown away.
      if (!workspace || workspace.todayShowWeather === false) return null
      // Asked for in the unit it will be drawn in, so nothing converts a reading afterwards.
      const units = resolveTemperature(settings.temperatureUnits)
      return currentWeather({
        weatherPlace: workspace.weatherPlace ?? '',
        weatherLatitude: workspace.weatherLatitude ?? null,
        weatherLongitude: workspace.weatherLongitude ?? null
      }, units)
    } catch {
      // The corner of one screen, and nothing worth an error.
      return null
    }
  })

  handle('weather:search', async ({ query }) => searchPlaces(query))
}
