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
  layout = 'row',
  noun = 'icon',
  hint = 'PNG, JPG, WebP, GIF or SVG, up to 2 MB. Without one, the initial is used.'
}: {
  name: string
  color: string
  icon: string | null
  onChange: (next: { iconPath: string; icon: string | null }) => void
  size?: number
  /** Stacked and centred where the picture is the subject of the panel, not a field in it. */
  layout?: 'row' | 'column'
  /** What the buttons call the image — a person has a photo, not an icon. */
  noun?: string
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

  const column = layout === 'column'

  return (
    <div className={column ? 'text-center' : ''}>
      <div className={`flex gap-4 ${column ? 'flex-col items-center' : 'items-center'}`}>
        <Mark
          name={name || '?'}
          color={color}
          icon={icon}
          size={size}
          rounded={column ? 'rounded-full' : 'rounded-[12px]'}
        />
        <div className={`flex flex-col gap-1.5 ${column ? 'items-center' : ''}`}>
          <div className="flex gap-1.5">
            <button type="button" className="btn btn-sm gap-1.5" onClick={() => void choose()}>
              <Icon name="folder" size={13} />
              {icon ? `Replace ${noun}` : `Upload ${noun}`}
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
          <span className={`text-[11px] leading-snug text-base-content/40 ${column ? 'max-w-[16rem]' : ''}`}>
            {hint}
          </span>
        </div>
      </div>
      {error && <p className="mt-2 text-[12px] text-error">{error}</p>}
    </div>
  )
}
