import { useApi } from './api'
import { applyDisplayPreferences } from './format'

/**
 * Put the machine's format preferences in front of every `formatDate` in the app.
 *
 * Called from the shell, *during* its render rather than from an effect, because
 * everything that draws a date is a child of it: an effect runs after those children
 * have already drawn, so changing the setting would leave one frame showing the old
 * format. The call is idempotent — it rebuilds three `Intl` formatters — so a second
 * render costs nothing and Strict Mode's double render is harmless.
 *
 * Until settings have loaded, the formatters are the ones the operating system would
 * have given anyway, which is also what `system` means. So there is no flash of a
 * wrong format on the way to the right one: only the people who have changed a
 * setting see anything change at all, and they see it on the first painted frame.
 */
export function useDisplayPreferences(): void {
  const settings = useApi('settings:get')
  if (settings.data) applyDisplayPreferences(settings.data)
}
