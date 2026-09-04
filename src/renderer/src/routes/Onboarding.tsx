import { useState } from 'react'
import { useApiMutation } from '@/lib/api'
import { useWorkspaces } from '@/lib/workspace'
import { Icon } from '@/components/Icon'
import { IconPicker } from '@/components/IconPicker'
import { Logo } from '@/components/Logo'
import { Mark } from '@/components/Mark'
import { Field } from '@/components/primitives'
import { WORKSPACE_COLORS } from '@/components/WorkspaceModal'

const WorkspaceMarkPreview = ({
  name,
  color,
  icon
}: {
  name: string
  color: string
  icon: string | null
}): React.JSX.Element => <Mark name={name} color={color} icon={icon} size={20} />

/**
 * The app ships with nothing in it. A workspace is the first decision you make,
 * and it is a real one — everything after this lives inside one.
 */
export function Onboarding(): React.JSX.Element {
  const { archived, switchTo } = useWorkspaces()
  const save = useApiMutation('workspace:save')
  const loadSample = useApiMutation('settings:loadSample')
  const restore = useApiMutation('workspace:setArchived')

  const [name, setName] = useState('')
  const [color, setColor] = useState(WORKSPACE_COLORS[0] as string)
  const [iconPath, setIconPath] = useState('')
  const [iconPreview, setIconPreview] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (!name.trim()) return
    await save.mutateAsync({ name: name.trim(), color, iconPath })
  }

  return (
    <div className="flex h-full items-center justify-center bg-base-200/40 px-6">
      <div className="drag-region absolute inset-x-0 top-0 h-[52px]" />

      <div className="rise w-full max-w-md">
        {/* First launch is the one moment the app should say what it is. */}
        <div className="flex items-center gap-3">
          <Logo size={34} />
          <div>
            <div className="text-[17px] font-semibold leading-tight tracking-[-0.015em]">Neo</div>
            <div className="text-[12px] text-base-content/50">
              A command centre for several working lives
            </div>
          </div>
        </div>
        {/* A 2px rule is how this app says whose colour something is; here it is its own. */}
        <div className="brand-gradient mb-6 mt-4 h-[2px] w-14 rounded-full" />

        <h1 className="text-[26px] font-semibold tracking-[-0.02em]">
          {archived.length > 0 ? 'No open workspaces' : 'Create your first workspace'}
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-base-content/60">
          A workspace is one area of your working life — a day job, your own company, a client. They stay
          completely separate: no screen ever mixes two of them, so you only ever see the one you are in.
        </p>

        <form
          className="hairline mt-6 rounded-box border bg-base-100 p-5"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="mb-5">
            <IconPicker
              name={name}
              color={color}
              icon={iconPreview}
              hint="Optional — PNG, JPG, WebP, GIF or SVG, up to 2 MB."
              onChange={({ iconPath: next, icon }) => {
                setIconPath(next)
                setIconPreview(icon)
              }}
            />
          </div>

          <Field label="Name">
            <input
              autoFocus
              className="input input-bordered w-full"
              placeholder="Day job"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          <div className="mt-4">
            <span className="mb-1.5 block text-xs font-medium text-base-content/65">Colour</span>
            <div className="flex flex-wrap gap-1.5">
              {WORKSPACE_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  className={`size-7 rounded-full transition ${
                    color === swatch ? 'ring-2 ring-base-content/40 ring-offset-2 ring-offset-base-100' : ''
                  }`}
                  style={{ backgroundColor: swatch }}
                  onClick={() => setColor(swatch)}
                  aria-label={swatch}
                />
              ))}
            </div>
          </div>

          <button type="submit" className="btn btn-primary mt-6 w-full" disabled={!name.trim()}>
            Create workspace
          </button>
        </form>

        {archived.length > 0 && (
          <div className="hairline mt-5 rounded-box border p-3">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-base-content/40">
              Archived
            </div>
            {archived.map((item) => (
              <div key={item.id} className="flex items-center gap-2.5 py-1">
                <span className="opacity-50">
                  <WorkspaceMarkPreview name={item.name} color={item.color} icon={item.icon} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-base-content/60">{item.name}</span>
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={async () => {
                    await restore.mutateAsync({ id: item.id, archived: false })
                    switchTo(item.id)
                  }}
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-5 text-center">
          <button
            className="btn btn-ghost btn-sm gap-1.5 text-base-content/55"
            onClick={() => loadSample.mutate()}
          >
            <Icon name="sparkle" size={13} />
            Or load sample data to look around first
          </button>
        </div>
      </div>
    </div>
  )
}
