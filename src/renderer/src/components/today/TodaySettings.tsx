import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { WeatherPlace, Workspace } from '@shared/types'
import { call, useApi, useApiMutation } from '@/lib/api'
import { Icon } from '@/components/Icon'
import { AutoTextarea, ConfirmButton, Field, Panel } from '@/components/primitives'

/**
 * Everything about how the Today page looks, in one pane, because it is one question:
 * what do you want to be looking at first thing in the morning.
 *
 * It is deliberately the only pane in the app where nothing you change can be wrong.
 * A banner, a line about yourself, the links you open every day and a switch beside
 * each block — none of it is read by attention, by the Markdown mirror or by anything
 * that decides what you should do next, so it is safe to let it be yours.
 */
export function TodayPane({ workspace }: { workspace: Workspace }): React.JSX.Element {
  return (
    <div className="space-y-4">
      <BannerPanel workspace={workspace} />
      <BioPanel workspace={workspace} />
      <LinksPanel workspace={workspace} />
      <WeatherPanel workspace={workspace} />
      <VisibilityPanel workspace={workspace} />
    </div>
  )
}

/* ------------------------------------------------------------------- banner */

function BannerPanel({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const save = useApiMutation('workspace:save')
  const [error, setError] = useState('')
  /* Where the picture sits while it is being dragged, before it is a setting. */
  const [dragged, setDragged] = useState<{ x: number; y: number } | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)

  const position = dragged ?? { x: workspace.bannerX, y: workspace.bannerY }

  const choose = async (): Promise<void> => {
    try {
      const picked = await call('banner:pick')
      if (!picked) return
      setError('')
      // A new photograph is centred rather than inheriting the last one's crop: the
      // old numbers described a different picture, and are wrong for this one.
      save.mutate({ id: workspace.id, bannerPath: picked.bannerPath, bannerX: 50, bannerY: 50 })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That image could not be read.')
    }
  }

  /**
   * Drag the picture to say which part of it is seen.
   *
   * `object-fit: cover` scales the image until it covers the strip and throws the
   * overflow away; `object-position` chooses which part is thrown. So a drag is only
   * meaningful along an axis that actually overflows, and how far a pixel moves the
   * picture depends on how much overflow there is — which is why this measures the
   * image's natural size rather than guessing at a sensitivity. On the axis with
   * nothing to spare the pointer moves and the picture does not, which is correct:
   * there is nothing hidden there to bring into view.
   */
  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const box = frame.current?.getBoundingClientRect()
    const img = image.current
    if (!box || !img || !img.naturalWidth || !img.naturalHeight) return

    const scale = Math.max(box.width / img.naturalWidth, box.height / img.naturalHeight)
    const spareX = img.naturalWidth * scale - box.width
    const spareY = img.naturalHeight * scale - box.height
    if (spareX < 1 && spareY < 1) return

    const from = { x: event.clientX, y: event.clientY }
    const at = { x: workspace.bannerX, y: workspace.bannerY }
    event.currentTarget.setPointerCapture(event.pointerId)

    const clamp = (n: number): number => Math.min(100, Math.max(0, Math.round(n)))
    // Dragging the picture right reveals what is off its left edge, so the position
    // moves towards zero — the pointer and the photograph go the same way.
    const move = (e: PointerEvent): void => {
      setDragged({
        x: spareX < 1 ? at.x : clamp(at.x - ((e.clientX - from.x) / spareX) * 100),
        y: spareY < 1 ? at.y : clamp(at.y - ((e.clientY - from.y) / spareY) * 100)
      })
    }
    const end = (e: PointerEvent): void => {
      move(e)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      // Written on release, not per pixel: every write here invalidates the whole
      // query cache, exactly as the transparency slider does not.
      setDragged((settled) => {
        if (settled && (settled.x !== workspace.bannerX || settled.y !== workspace.bannerY)) {
          save.mutate({ id: workspace.id, bannerX: settled.x, bannerY: settled.y })
        }
        return null
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  }

  const centred = position.x === 50 && position.y === 50

  return (
    <Panel>
      <div className="mb-3">
        <div className="text-[13px] font-medium">Banner</div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
          A photograph across the top of Today. Wide beats tall — the strip here is close to
          the shape it is drawn in on the page, so what you see is what you get.
        </p>
      </div>

      {workspace.banner ? (
        <div
          ref={frame}
          onPointerDown={startDrag}
          className="hairline group relative h-28 w-full cursor-grab overflow-hidden rounded-box border active:cursor-grabbing"
          title="Drag to choose which part of the picture is seen"
        >
          <img
            ref={image}
            src={workspace.banner}
            alt=""
            draggable={false}
            className="size-full select-none object-cover"
            style={{ objectPosition: `${position.x}% ${position.y}%` }}
          />
          {/*
            The hint only appears under the pointer, and goes for good once the picture
            has been moved: it is an instruction, and an instruction that stays on
            screen after it has been followed is decoration.
          */}
          {centred && (
            <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-gradient-to-t from-black/60 to-transparent px-2 pb-1.5 pt-6 text-[11px] text-white/85 opacity-0 transition group-hover:opacity-100">
              <Icon name="grip" size={12} />
              Drag to choose what is seen
            </span>
          )}
        </div>
      ) : (
        <div className="hairline flex h-28 w-full items-center justify-center rounded-box border border-dashed text-base-content/25">
          <Icon name="image" size={22} />
        </div>
      )}

      <div className="mt-3 flex items-center gap-1.5">
        <button type="button" className="btn btn-sm gap-1.5" onClick={() => void choose()}>
          <Icon name="folder" size={13} />
          {workspace.banner ? 'Replace' : 'Upload'}
        </button>
        {workspace.banner && !centred && (
          <button
            type="button"
            className="btn btn-ghost btn-sm text-base-content/50"
            onClick={() => save.mutate({ id: workspace.id, bannerX: 50, bannerY: 50 })}
          >
            Centre
          </button>
        )}
        {workspace.banner && (
          <button
            type="button"
            className="btn btn-ghost btn-sm text-base-content/50"
            onClick={() => save.mutate({ id: workspace.id, bannerPath: '' })}
          >
            Remove
          </button>
        )}
        <span className="ml-1 text-[11px] text-base-content/40">
          PNG, JPG, WebP or GIF, up to 8 MB.
        </span>
      </div>

      {error && <p className="mt-2 text-[12px] text-error">{error}</p>}
    </Panel>
  )
}

/* ---------------------------------------------------------------------- bio */

function BioPanel({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const save = useApiMutation('workspace:save')
  const [bio, setBio] = useState(workspace.bio)

  // Switching workspace while the pane is open must not carry the old text across.
  useEffect(() => setBio(workspace.bio), [workspace.id, workspace.bio])

  return (
    <Panel>
      <Field
        label="What you do here"
        hint="One line under the greeting. What this working life is — not a job title, unless that is genuinely what it is."
      >
        <AutoTextarea
          value={bio}
          onChange={setBio}
          minRows={2}
          placeholder="Delivery lead across the platform teams. Three squads, one roadmap."
          className="textarea textarea-bordered"
          onBlur={() => bio !== workspace.bio && save.mutate({ id: workspace.id, bio })}
        />
      </Field>
    </Panel>
  )
}

/* -------------------------------------------------------------------- links */

function LinksPanel({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const links = useApi('workspaceLink:list', { workspaceId: workspace.id })
  const save = useApiMutation('workspaceLink:save')
  const remove = useApiMutation('workspaceLink:delete')
  const reorder = useApiMutation('workspaceLink:reorder')
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')

  const rows = links.data ?? []

  const add = (): void => {
    if (!url.trim()) return
    save.mutate(
      { workspaceId: workspace.id, label: label.trim(), url: url.trim() },
      {
        onSuccess: () => {
          setLabel('')
          setUrl('')
          setError('')
        },
        onError: (e) => setError(e.message)
      }
    )
  }

  /** Swap a row with the one beside it, and send the whole order back. */
  const move = (index: number, by: -1 | 1): void => {
    const next = [...rows]
    const target = index + by
    const a = next[index]
    const b = next[target]
    if (!a || !b) return
    next[index] = b
    next[target] = a
    reorder.mutate({ ids: next.map((l) => l.id) })
  }

  return (
    <Panel>
      <div className="mb-3">
        <div className="text-[13px] font-medium">Links</div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
          The things you open every morning — the intranet, the timesheet, the one dashboard
          you actually read. They belong to this workspace, not to a project.
        </p>
      </div>

      {rows.length > 0 && (
        <div className="hairline mb-3 overflow-hidden rounded-box border">
          {rows.map((link, index) => (
            <div
              key={link.id}
              className="row-hover hairline group flex items-center gap-2 border-b px-2.5 py-2 last:border-b-0"
            >
              <div className="flex shrink-0 flex-col opacity-0 transition group-hover:opacity-100">
                <button
                  type="button"
                  className="text-base-content/35 hover:text-base-content disabled:opacity-25"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label="Move up"
                >
                  <Icon name="chevronUp" size={12} />
                </button>
                <button
                  type="button"
                  className="text-base-content/35 hover:text-base-content disabled:opacity-25"
                  disabled={index === rows.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label="Move down"
                >
                  <Icon name="chevronDown" size={12} />
                </button>
              </div>

              {/*
                Uncontrolled and saved on the way out, like the address beside it: a
                mutation here invalidates the whole query cache, and one per keystroke
                would refetch the application every time you renamed a link.
              */}
              <input
                className="input input-ghost input-sm w-[9rem] shrink-0 px-2 text-[13px]"
                defaultValue={link.label}
                onBlur={(e) =>
                  e.target.value.trim() !== link.label &&
                  save.mutate({ id: link.id, label: e.target.value.trim() })
                }
                placeholder="Label"
              />
              <input
                className="input input-ghost input-sm min-w-0 flex-1 px-2 text-[12px] text-base-content/60"
                defaultValue={link.url}
                onBlur={(e) => {
                  const typed = e.target.value.trim()
                  if (typed === link.url) return
                  // Emptied rather than changed. Main refuses it, and a field left
                  // showing what was refused is worse than one that puts it back.
                  if (!typed) e.target.value = link.url
                  else save.mutate({ id: link.id, url: typed })
                }}
                placeholder="https://"
              />
              <ConfirmButton
                label="Remove"
                title="Remove this link?"
                body={link.label || link.url}
                confirmLabel="Remove"
                onConfirm={() => remove.mutate({ id: link.id })}
              />
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          className="input input-bordered input-sm w-[9rem] shrink-0"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label"
        />
        <input
          className="input input-bordered input-sm min-w-0 flex-1"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="intranet.company.com"
        />
        <button type="button" className="btn btn-sm gap-1.5" onClick={add} disabled={!url.trim()}>
          <Icon name="plus" size={13} />
          Add
        </button>
      </div>
      <p className="mt-1.5 text-[11px] text-base-content/40">
        No label, and the address itself is used. Anything without a scheme gets https.
      </p>
      {error && <p className="mt-2 text-[12px] text-error">{error}</p>}
    </Panel>
  )
}

/* ------------------------------------------------------------------ weather */

function WeatherPanel({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const save = useApiMutation('workspace:save')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WeatherPlace[]>([])
  const [searching, setSearching] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const search = (value: string): void => {
    setQuery(value)
    if (timer.current) clearTimeout(timer.current)
    if (value.trim().length < 2) {
      setResults([])
      return
    }
    // Typed slowly enough to be a place rather than a keystroke. The lookup leaves
    // the machine, so it is worth not making one of those per letter.
    timer.current = setTimeout(() => {
      setSearching(true)
      void call('weather:search', { query: value })
        .then(setResults)
        .finally(() => setSearching(false))
    }, 400)
  }

  const choose = (place: WeatherPlace): void => {
    save.mutate({
      id: workspace.id,
      weatherPlace: place.name,
      weatherLatitude: place.latitude,
      weatherLongitude: place.longitude
    })
    setQuery('')
    setResults([])
  }

  return (
    <Panel>
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <div className="text-[13px] font-medium">Weather</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
            The only thing in Neo that asks the internet anything without a key of yours.
            It sends a latitude and a longitude to Open-Meteo — no account, no name, nothing
            about your work — and shows nothing at all if that fails.
          </p>
        </div>
        <input
          type="checkbox"
          className="toggle toggle-sm mt-1"
          checked={workspace.todayShowWeather}
          onChange={(e) => save.mutate({ id: workspace.id, todayShowWeather: e.target.checked })}
        />
      </div>

      {workspace.todayShowWeather && (
        <div className="mt-4 space-y-3">
          <Field
            label="Place"
            hint={
              workspace.weatherPlace
                ? 'Search to change it.'
                : 'Working it out from this machine’s timezone. Search to say exactly where.'
            }
          >
            <div className="flex items-center gap-2">
              <input
                className="input input-bordered input-sm min-w-0 flex-1"
                value={query}
                onChange={(e) => search(e.target.value)}
                placeholder={workspace.weatherPlace || 'Where you work from'}
              />
              {workspace.weatherPlace && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm text-base-content/50"
                  onClick={() =>
                    save.mutate({
                      id: workspace.id,
                      weatherPlace: '',
                      weatherLatitude: null,
                      weatherLongitude: null
                    })
                  }
                >
                  Use my timezone
                </button>
              )}
            </div>
          </Field>

          {searching && <p className="text-[12px] text-base-content/40">Looking…</p>}
          {results.length > 0 && (
            <div className="hairline overflow-hidden rounded-box border">
              {results.map((place) => (
                <button
                  key={`${place.latitude},${place.longitude}`}
                  type="button"
                  className="row-hover hairline flex w-full items-baseline gap-2 border-b px-3 py-2 text-left last:border-b-0"
                  onClick={() => choose(place)}
                >
                  <span className="text-[13px]">{place.name}</span>
                  <span className="text-[11px] text-base-content/45">
                    {[place.region, place.country].filter(Boolean).join(', ')}
                  </span>
                </button>
              ))}
            </div>
          )}
          {!searching && query.trim().length >= 2 && results.length === 0 && (
            <p className="text-[12px] text-base-content/40">
              Nothing found — or the lookup could not be reached.
            </p>
          )}

          <p className="text-[11px] leading-relaxed text-base-content/40">
            Celsius or Fahrenheit is in{' '}
            <Link
              to="/settings?pane=formats"
              className="underline decoration-base-content/25 hover:decoration-current"
            >
              Settings → Formats
            </Link>
            , with the clock and the date: those are about you rather than about this
            workspace, and nobody wants different degrees in different ones.
          </p>
        </div>
      )}
    </Panel>
  )
}

/* --------------------------------------------------------------- visibility */

/**
 * What the page is allowed to show. Overdue and due today are not in this list and
 * never will be: they are the reason the screen exists, and a Today page you can
 * switch the work off is a wallpaper.
 */
const BLOCKS: { key: keyof Workspace; label: string; hint: string }[] = [
  { key: 'todayShowClock', label: 'The time', hint: 'The clock beside the date.' },
  { key: 'todayShowBio', label: 'Your line', hint: 'What you do in this workspace, under the greeting.' },
  { key: 'todayShowLinks', label: 'Links', hint: 'The chips along the bottom of the banner.' },
  { key: 'todayShowStats', label: 'The counts', hint: 'Active projects, open items, people.' },
  { key: 'todayShowSoon', label: 'Next seven days', hint: 'What is coming, under what is due.' },
  {
    key: 'todayShowAttention',
    label: 'Needs a look',
    hint: 'Projects the app thinks have gone quiet or are drifting.'
  },
  {
    key: 'todayShowMeetingTodos',
    label: 'Open to-dos from meetings',
    hint: 'What was agreed in a room and never closed.'
  }
]

function VisibilityPanel({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const save = useApiMutation('workspace:save')

  return (
    <Panel>
      <div className="mb-3">
        <div className="text-[13px] font-medium">What to show</div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
          Per workspace, so the day job and your own company can look like different
          places. Overdue and due today are always there — they are what the screen is for.
        </p>
      </div>

      <div className="hairline overflow-hidden rounded-box border">
        {BLOCKS.map((block) => (
          <label
            key={block.key}
            className="hairline flex cursor-pointer items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[13px]">{block.label}</span>
              <span className="block text-[11px] text-base-content/45">{block.hint}</span>
            </span>
            <input
              type="checkbox"
              className="toggle toggle-sm"
              checked={Boolean(workspace[block.key])}
              onChange={(e) => save.mutate({ id: workspace.id, [block.key]: e.target.checked })}
            />
          </label>
        ))}
      </div>
    </Panel>
  )
}
