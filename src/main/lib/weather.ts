import { describeWeather } from '@shared/weather'
import type { WeatherNow, WeatherPlace } from '@shared/types'

/**
 * The one thing in this application that talks to the internet about you.
 *
 * Everything else here is deliberately offline — the database is in your home
 * folder, the assistant only leaves the machine because you gave it a key. The
 * weather cannot be derived from anything local, so it is fetched, and the whole of
 * this file is about keeping that honest:
 *
 * - It asks **Open-Meteo**, which needs no account and no key, so nothing identifies
 *   the request as yours beyond the address it came from.
 * - It sends a latitude and a longitude and nothing else. No project, no name, no
 *   workspace — there is no field on the request that could carry one.
 * - It fails silently and completely. Every path here returns `null` rather than
 *   throwing, because a Today page that cannot say what the weather is should say
 *   nothing about the weather and everything else it always said.
 *
 * The location comes from the machine's own timezone unless you name a place, so it
 * works on the first morning without a setup step. "Europe/Oslo" is a city, and the
 * geocoder knows what to do with a city.
 */

const FORECAST = 'https://api.open-meteo.com/v1/forecast'
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search'
const TIMEOUT_MS = 6000

/** Long enough that the page is not a poller, short enough to follow a rain shower. */
const CACHE_MS = 15 * 60 * 1000

/* eslint-disable @typescript-eslint/no-explicit-any */
async function getJson(url: string): Promise<any | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' }
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    // No network, a captive portal, a service having a bad day. All the same answer.
    return null
  }
}

/** Search for a place by name. Used by the settings pane and by nothing else. */
export async function searchPlaces(query: string): Promise<WeatherPlace[]> {
  const term = query.trim()
  if (term.length < 2) return []
  const data = await getJson(
    `${GEOCODE}?name=${encodeURIComponent(term)}&count=6&language=en&format=json`
  )
  const results = Array.isArray(data?.results) ? data.results : []
  return results.map((r: any) => ({
    name: String(r.name ?? ''),
    region: String(r.admin1 ?? ''),
    country: String(r.country ?? ''),
    latitude: Number(r.latitude),
    longitude: Number(r.longitude)
  }))
}

/**
 * Where to read the weather for when nobody has said.
 *
 * An IANA timezone is named after a city — "Europe/Oslo", "America/Los_Angeles" —
 * so the machine already knows roughly where it is without anything being asked of
 * the operating system or of a location service. Resolved once per run: the answer
 * cannot change while the app is open, and a failed lookup should not be retried on
 * every visit to the screen.
 */
let fromTimezone: { place: WeatherPlace | null } | null = null

async function timezonePlace(): Promise<WeatherPlace | null> {
  if (fromTimezone) return fromTimezone.place
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  const city = (zone.split('/').pop() ?? '').replace(/_/g, ' ')
  const place = city ? ((await searchPlaces(city))[0] ?? null) : null
  fromTimezone = { place }
  return place
}

interface Located {
  latitude: number
  longitude: number
  place: string
}

/** A hand-picked place wins; otherwise the timezone's city. Null when neither works. */
async function locate(workspace: {
  weatherPlace: string
  weatherLatitude: number | null
  weatherLongitude: number | null
}): Promise<Located | null> {
  if (workspace.weatherLatitude !== null && workspace.weatherLongitude !== null) {
    return {
      latitude: workspace.weatherLatitude,
      longitude: workspace.weatherLongitude,
      place: workspace.weatherPlace
    }
  }
  // A place typed with no coordinates beside it — from an older row, or a name saved
  // before the search came back. Look it up rather than showing nothing.
  if (workspace.weatherPlace) {
    const found = (await searchPlaces(workspace.weatherPlace))[0]
    if (found) {
      return { latitude: found.latitude, longitude: found.longitude, place: found.name }
    }
  }
  const guessed = await timezonePlace()
  return guessed
    ? { latitude: guessed.latitude, longitude: guessed.longitude, place: guessed.name }
    : null
}

const cache = new Map<string, { at: number; value: WeatherNow | null }>()

/**
 * The weather now, in the workspace's own unit. Never throws, and never blocks the
 * screen for longer than the timeout above: whatever goes wrong, the answer is null
 * and Today simply does not draw that corner.
 */
export async function currentWeather(
  workspace: { weatherPlace: string; weatherLatitude: number | null; weatherLongitude: number | null },
  /* Where the reading is taken is a property of the workspace; what it is read in is
     a property of the person, and comes from app settings. */
  units: 'c' | 'f'
): Promise<WeatherNow | null> {
  const at = await locate(workspace)
  if (!at) return null

  const unit = units === 'f' ? 'fahrenheit' : 'celsius'
  const key = `${at.latitude.toFixed(3)},${at.longitude.toFixed(3)},${unit}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value

  const data = await getJson(
    `${FORECAST}?latitude=${at.latitude}&longitude=${at.longitude}` +
      '&current=temperature_2m,weather_code,is_day' +
      '&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto' +
      `&temperature_unit=${unit}`
  )

  const current = data?.current
  if (!current || typeof current.temperature_2m !== 'number') {
    // Remember the failure too, so a page that is left open does not hammer a
    // service that is already saying no.
    cache.set(key, { at: Date.now(), value: null })
    return null
  }

  const code = Number(current.weather_code ?? 0)
  const isDay = current.is_day !== 0
  const value: WeatherNow = {
    place: at.place,
    temperature: Math.round(current.temperature_2m),
    high: Math.round(data?.daily?.temperature_2m_max?.[0] ?? current.temperature_2m),
    low: Math.round(data?.daily?.temperature_2m_min?.[0] ?? current.temperature_2m),
    units,
    code,
    description: describeWeather(code, isDay).text,
    isDay,
    fetchedAt: new Date().toISOString()
  }
  cache.set(key, { at: Date.now(), value })
  return value
}

/** Forget everything remembered, so a changed place is read again immediately. */
export function forgetWeather(): void {
  cache.clear()
}
