import { useEffect, useState } from 'react'
import { call, useApi, useApiMutation } from './api'

export type Theme = 'light' | 'dark' | 'system' | 'glass'

/**
 * Where the frosting comes from. `window` is the operating system blurring the
 * desktop behind the app, which is the real thing; `paint` is the app drawing a
 * backdrop of its own for the glass to sit on, because this machine has no such
 * material to offer. The screen says which, rather than promising the first and
 * quietly giving the second.
 */
export type GlassMaterial = 'window' | 'paint'

export const THEMES: { value: Theme; label: string; icon: 'sun' | 'moon' | 'monitor' | 'droplet' }[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' },
  { value: 'glass', label: 'Liquid Glass', icon: 'droplet' }
]

/**
 * The renderer follows the stored preference; "system" defers to the OS and keeps
 * following it while the app is open.
 *
 * Applying the theme is a single document-level attribute, so calling this from more
 * than one place is harmless: every caller writes the same value from the same stored
 * setting. The shell calls it to apply the theme, Settings to change it.
 *
 * Liquid Glass is the exception to "a theme is a palette", and deliberately so: it is
 * a *material*, and a material has to work in both palettes. So it takes its colours
 * from the operating system exactly as "system" does — `data-theme` still says `pm`
 * or `pmdark` — and adds `data-glass`, which is the only thing the glass rules in
 * `styles.css` key off. That is what keeps the material one block of CSS instead of a
 * second and third copy of every theme token.
 */
export function useTheme(): {
  theme: Theme
  setTheme: (t: Theme) => void
  transparency: number
  setTransparency: (n: number) => void
  material: GlassMaterial | null
} {
  const settings = useApi('settings:get')
  const save = useApiMutation('settings:save')
  const theme = (settings.data?.theme ?? 'system') as Theme
  const transparency = settings.data?.glassTransparency ?? 45
  const glass = theme === 'glass'
  const [material, setMaterial] = useState<GlassMaterial | null>(null)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const dark = theme === 'dark' || ((theme === 'system' || glass) && media.matches)
      document.documentElement.setAttribute('data-theme', dark ? 'pmdark' : 'pm')
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme, glass])

  /*
   * Main owns the window, so it is asked rather than told: only it can put a vibrancy
   * view under the web contents, and only it knows whether this machine has one. The
   * attribute is not written until the answer is back, because `window` and `paint`
   * want different backdrops and guessing wrong shows.
   */
  useEffect(() => {
    let stale = false
    void call('window:glass', { on: glass }).then((result) => {
      if (stale) return
      setMaterial(glass ? result.material : null)
      if (glass) document.documentElement.setAttribute('data-glass', result.material)
      else document.documentElement.removeAttribute('data-glass')
    })
    return () => {
      stale = true
    }
  }, [glass])

  /*
   * A window you are not typing in gets a little clearer, not a little flatter.
   *
   * macOS's own instinct is the opposite — it switches a vibrancy view off the moment
   * its window stops being key, which is why `visualEffectState` is pinned to active
   * in main. Having insisted the glass stay glass, this leans the other way on
   * purpose: the window you are looking past is the one that should be easiest to
   * look past. It is small, and it is the app's own paint rather than the material,
   * because the material has no dial.
   *
   * The renderer's own focus events, not an IPC channel: the window losing key is
   * exactly what fires them, and there is nothing main knows here that the page does
   * not.
   */
  useEffect(() => {
    if (!glass) return
    const root = document.documentElement
    const apply = (): void => {
      root.toggleAttribute('data-glass-idle', !document.hasFocus())
    }
    apply()
    window.addEventListener('focus', apply)
    window.addEventListener('blur', apply)
    return () => {
      window.removeEventListener('focus', apply)
      window.removeEventListener('blur', apply)
      root.removeAttribute('data-glass-idle')
    }
  }, [glass])

  /*
   * Set whatever the theme, and read only under `[data-glass]`. It is `--glass-set`
   * and not `--glass-strength` because this is an inline style, and an inline style
   * cannot be overridden — the stylesheet reads it through a fallback so that
   * `prefers-reduced-transparency` still has the last word.
   */
  useEffect(() => {
    document.documentElement.style.setProperty('--glass-set', String(transparency / 100))
  }, [transparency])

  return {
    theme,
    setTheme: (t) => save.mutate({ theme: t }),
    transparency,
    setTransparency: (n) => save.mutate({ glassTransparency: Math.min(100, Math.max(0, Math.round(n))) }),
    material
  }
}
