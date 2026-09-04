import { useState } from 'react'
import { call } from '@/lib/api'
import { Icon } from './Icon'
import { Mark } from './Mark'

/**
 * Picking happens in the main process — the renderer never sees a filesystem path,
 * only the stored filename and a data URL to preview. Shared by workspaces and
 * projects so both behave identically.
 */
export function IconPicker({
  name,
  color,
  icon,
  onChange,
  size = 52,
  hint = 'PNG, JPG, WebP, GIF or SVG, up to 2 MB. Without one, the initial is used.'
}: {
  name: string
  color: string
  icon: string | null
  onChange: (next: { iconPath: string; icon: string | null }) => void
  size?: number
  hint?: string
}): React.JSX.Element {
  const [error, setError] = useState('')

  const choose = async (): Promise<void> => {
    try {
      const picked = await call('icon:pick')
      if (!picked) return
      setError('')
      onChange({ iconPath: picked.iconPath, icon: picked.dataUrl })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That image could not be read.')
    }
  }

  return (
    <div>
      <div className="flex items-center gap-4">
        <Mark name={name || '?'} color={color} icon={icon} size={size} rounded="rounded-[12px]" />
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1.5">
            <button type="button" className="btn btn-sm gap-1.5" onClick={() => void choose()}>
              <Icon name="folder" size={13} />
              {icon ? 'Replace icon' : 'Upload icon'}
            </button>
            {icon && (
              <button
                type="button"
                className="btn btn-ghost btn-sm text-base-content/50"
                onClick={() => onChange({ iconPath: '', icon: null })}
              >
                Remove
              </button>
            )}
          </div>
          <span className="text-[11px] leading-snug text-base-content/40">{hint}</span>
        </div>
      </div>
      {error && <p className="mt-2 text-[12px] text-error">{error}</p>}
    </div>
  )
}
