import { useEffect } from 'react'
import { useApi, useApiMutation } from './api'

export type Theme = 'light' | 'dark' | 'system'

export const THEMES: { value: Theme; label: string; icon: 'sun' | 'moon' | 'monitor' }[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' }
]

/**
 * The renderer follows the stored preference; "system" defers to the OS and keeps
 * following it while the app is open.
 *
 * Applying the theme is a single document-level attribute, so calling this from more
 * than one place is harmless: every caller writes the same value from the same stored
 * setting. The shell calls it to apply the theme, Settings to change it.
 */
export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void } {
  const settings = useApi('settings:get')
  const save = useApiMutation('settings:save')
  const theme = (settings.data?.theme ?? 'system') as Theme

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      document.documentElement.setAttribute('data-theme', dark ? 'pmdark' : 'pm')
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  return { theme, setTheme: (t) => save.mutate({ theme: t }) }
}
