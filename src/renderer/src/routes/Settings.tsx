import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { call, openExternal, useApi, useApiMutation } from '@/lib/api'
import { useTheme, THEMES, type Theme } from '@/lib/theme'
import { formatBytes, formatDateWith, formatTemperature, formatTimeWith } from '@/lib/format'
import { resolveTemperature, type ClockFormat } from '@shared/formats'
import { useWorkspace } from '@/lib/workspace'
import { Icon } from '@/components/Icon'
import { Logo } from '@/components/Logo'
import { IconPicker } from '@/components/IconPicker'
import { SettingsLayout } from '@/components/SettingsLayout'
import { Field, Kbd, Panel } from '@/components/primitives'

export function SettingsPage(): React.JSX.Element {
  const workspace = useWorkspace()

  return (
    <SettingsLayout
      title="Settings"
      exitTo="/"
      subtitle={
        <>
          You and your data. Anything about {workspace.name} itself lives in{' '}
          <Link to="/workspace" className="underline decoration-base-content/25 hover:decoration-current">
            workspace settings
          </Link>
          .
        </>
      }
      panes={[
        {
          id: 'profile',
          label: 'Profile',
          icon: 'people',
          description: 'One profile, mirrored into every workspace as a person.',
          render: () => <ProfilePane />
        },
        {
          id: 'appearance',
          label: 'Appearance',
          icon: 'sun',
          description: 'How the app looks on this machine.',
          render: () => <AppearancePane />
        },
        {
          id: 'formats',
          label: 'Formats',
          icon: 'clock',
          description: 'How a date, a clock and a temperature are written on this machine.',
          render: () => <FormatsPane />
        },
        {
          id: 'audio',
          label: 'Recording',
          icon: 'mic',
          description: 'What a meeting recording listens to on this machine.',
          render: () => <AudioPane />
        },
        {
          id: 'data',
          label: 'Data',
          icon: 'folder',
          description: 'Where everything is kept, and how to get it out again.',
          render: () => <DataPane />
        },
        {
          id: 'claude',
          label: 'Claude',
          icon: 'chat',
          description: 'Let the Claude desktop app read and change what is in Neo.',
          render: () => <ClaudePane />
        },
        {
          id: 'shortcuts',
          label: 'Shortcuts',
          icon: 'command',
          render: () => <ShortcutsPane />
        },
        {
          id: 'about',
          label: 'About',
          icon: 'sparkle',
          render: () => <AboutPane />
        }
      ]}
    />
  )
}

/**
 * What a recording listens to.
 *
 * This is in app settings rather than workspace settings because it is about this
 * machine — which microphone, which cable — while a workspace decides things about a
 * working life. You do not want a different answer here per client.
 *
 * The awkward part is honest rather than hidden. macOS does not let one application
 * hear another, at all, and no setting in this app can change that: the only route is
 * a virtual audio device that both the call and Neo are pointed at. So the pane says
 * so, names the free one people use, and then gets out of the way.
 */
function AudioPane(): React.JSX.Element {
  const settings = useApi('settings:get')
  const save = useApiMutation('settings:save')
  const native = useApi('systemAudio:available')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [asked, setAsked] = useState(false)

  const on = settings.data?.captureSystemAudio ?? true
  const chosen = settings.data?.systemAudioDevice ?? ''
  const windows = window.api.platform === 'win32'
  // The native tap needs nothing installed and is tried first, so when it is there
  // the device below is a fallback rather than the way this works.
  const tap = native.data?.available ?? false

  /*
   * Device *names* are only handed over once the microphone has been allowed — before
   * that every input is an empty label and the list is useless. So the list is only
   * built when it is going to be looked at, and asking for it is what fills it in.
   */
  const load = async (): Promise<void> => {
    await call('recording:requestMic')
    try {
      const granted = await navigator.mediaDevices.getUserMedia({ audio: true })
      granted.getTracks().forEach((track) => track.stop())
    } catch {
      // Refused. The list below will be empty and say why.
    }
    setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'))
    setAsked(true)
  }

  useEffect(() => {
    if (!windows) void load()
    // Only ever on the way in: re-running this would re-open the microphone.
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [windows])

  // The devices that exist to carry another application's sound. Named so they can be
  // put at the top, because in a list of eight inputs they are the only right answer.
  const virtual = devices.filter((d) =>
    /blackhole|loopback|soundflower|aggregate|multi-output|vb-?cable|virtual/i.test(d.label)
  )
  const others = devices.filter((d) => !virtual.includes(d))

  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex items-start gap-4">
          <div className="flex-1">
            <div className="text-[13px] font-medium">Record the computer’s sound too</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
              The other half of a video call. Without it a recording catches your side of the
              conversation and nothing anyone else said.
            </p>
          </div>
          <input
            type="checkbox"
            className="toggle toggle-sm mt-1"
            checked={on}
            onChange={(e) => save.mutate({ captureSystemAudio: e.target.checked })}
          />
        </div>
      </Panel>

      {on && tap && !windows && (
        <Panel>
          <div className="flex items-start gap-3">
            <Icon name="check" size={15} className="mt-0.5 shrink-0 text-success" />
            <div>
              <div className="text-[13px] font-medium">Ready, with nothing to install</div>
              <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
                Neo reads the computer’s sound through macOS itself, using a Core Audio process
                tap. The first time you record, macOS will ask whether to allow it — say yes, and
                both halves of the call go into the recording. You still hear it as normal;
                nothing is muted or rerouted.
              </p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-base-content/45">
                Needs macOS 14.4 or later. If it is refused or unavailable, the device below is
                used instead, and the meeting panel says which one you got.
              </p>

              <SystemAudioTest />
            </div>
          </div>
        </Panel>
      )}

      {on && (
        <Panel>
          {windows ? (
            <p className="text-[12.5px] leading-relaxed text-base-content/70">
              Windows hands an application its own output directly, so there is nothing to set up
              here. The computer’s sound is mixed into the recording alongside the microphone.
            </p>
          ) : (
            <>
              <Field
                label={tap ? 'If that does not work: a virtual audio device' : 'Where the computer’s sound comes in'}
                hint={
                  tap
                    ? 'Only used when the tap above is refused or unavailable — on macOS before 14.4, say. A virtual audio device that both your call and Neo are pointed at arrives here like any other input.'
                    : 'macOS does not let one application hear another. The only way round it is a virtual audio device that both your call and Neo are pointed at — then it arrives here like any other input.'
                }
              >
                <div className="space-y-1">
                  {[...virtual, ...others].map((device) => (
                    <button
                      key={device.deviceId}
                      className={`hairline flex w-full items-center gap-3 rounded-field border px-3 py-2 text-left transition ${
                        chosen === device.label ? 'border-primary/40 bg-primary/5' : 'hover:bg-base-200/60'
                      }`}
                      onClick={() =>
                        save.mutate({ systemAudioDevice: chosen === device.label ? '' : device.label })
                      }
                    >
                      <span
                        className={`size-3.5 shrink-0 rounded-full border-[1.5px] ${
                          chosen === device.label ? 'border-primary bg-primary' : 'border-base-content/25'
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{device.label}</span>
                      {virtual.includes(device) && (
                        <span className="shrink-0 text-[10.5px] text-base-content/40">
                          carries other apps
                        </span>
                      )}
                    </button>
                  ))}

                  {devices.length === 0 && (
                    <p className="text-[12px] text-base-content/50">
                      {asked
                        ? 'No audio inputs are visible. Neo may not have been allowed to use the microphone.'
                        : 'Looking…'}
                    </p>
                  )}
                </div>
              </Field>

              {chosen && !virtual.some((d) => d.label === chosen) && (
                <p className="mt-2 text-[11.5px] leading-relaxed text-warning">
                  “{chosen}” does not look like a virtual device. If it is an ordinary microphone,
                  the recording will hear the room twice and nothing extra.
                </p>
              )}

              <div className="hairline mt-4 border-t pt-4">
                <div className="text-[12px] font-medium">Nothing listed that would work?</div>
                <p className="mt-1 text-[12px] leading-relaxed text-base-content/55">
                  <button
                    className="underline decoration-base-content/25 hover:decoration-current"
                    onClick={() => openExternal('https://existential.audio/blackhole/')}
                  >
                    BlackHole
                  </button>{' '}
                  is free and open source, and is what most people use. Install it, then in Audio
                  MIDI Setup make a <em>Multi-Output Device</em> containing BlackHole and your
                  speakers and select it as the system output — that way you still hear the call
                  while Neo records it. Come back here and pick BlackHole above.
                </p>
                <button className="btn btn-xs mt-2 gap-1.5" onClick={() => void load()}>
                  <Icon name="refresh" size={11} />
                  Look again
                </button>
              </div>
            </>
          )}
        </Panel>
      )}
    </div>
  )
}

/**
 * Try it, here, before a meeting rather than during one.
 *
 * macOS settles every question about this at the moment it is first asked — whether
 * to prompt, whether to allow — and offers no API to ask beforehand. So the only way
 * to know is to open the tap and see what comes out, and the only moment worth
 * finding out is not halfway through the call you needed recorded.
 *
 * It reports the byte count rather than a tick, because a tap that opened and
 * produced silence is the failure that matters and it looks exactly like success from
 * anywhere else.
 */
function SystemAudioTest(): React.JSX.Element {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; reason: string; bytes: number } | null>(null)

  const run = async (): Promise<void> => {
    setRunning(true)
    setResult(null)
    try {
      setResult(await call('systemAudio:test'))
    } catch (error) {
      setResult({ ok: false, reason: error instanceof Error ? error.message : String(error), bytes: 0 })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2.5">
        <button className="btn btn-sm gap-1.5" disabled={running} onClick={() => void run()}>
          <Icon name={running ? 'refresh' : 'play'} size={12} className={running ? 'animate-spin' : ''} />
          {running ? 'Listening…' : 'Test it'}
        </button>
        <span className="text-[11.5px] text-base-content/45">
          Play something first — a video, some music — then press this.
        </span>
      </div>

      {result && (
        <div
          className={`hairline mt-2.5 flex items-start gap-2 rounded-field border px-3 py-2 text-[12px] leading-relaxed ${
            result.ok ? 'border-success/40 bg-success/5' : 'border-warning/40 bg-warning/5'
          }`}
        >
          <Icon
            name={result.ok ? 'check' : 'alert'}
            size={13}
            className={`mt-0.5 shrink-0 ${result.ok ? 'text-success' : 'text-warning'}`}
          />
          <span>
            {result.ok ? (
              <>
                Heard the computer — {formatBytes(result.bytes)} in two seconds. Recordings will
                catch both sides of a call.
              </>
            ) : (
              <>
                {result.reason}
                {result.bytes === 0 && !/would not let|refused|Privacy/i.test(result.reason) && (
                  <>
                    {' '}
                    If something <em>was</em> playing, macOS is most likely refusing quietly —
                    check <strong>System Settings › Privacy &amp; Security › Audio Recording</strong>
                    , and note that a build running from source is unsigned, which macOS treats
                    differently from an installed one.
                  </>
                )}
              </>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * One profile, mirrored into every workspace as a person. Editing it here renames and
 * re-photographs you everywhere you appear — cast panels, meeting attendees, task
 * assignees — without you having to touch each workspace.
 */
function ProfilePane(): React.JSX.Element {
  const profile = useApi('profile:get')
  const save = useApiMutation('profile:save')
  const [name, setName] = useState('')

  useEffect(() => {
    if (profile.data) setName(profile.data.name)
  }, [profile.data?.name])

  if (!profile.data) return <></>

  return (
    <Panel className="px-6 py-8">
      {/* The photo is the subject here rather than a field beside one, so it sits on
          its own above the name instead of pushing it into a narrow column. */}
      <div className="mx-auto flex max-w-xs flex-col items-center">
        <IconPicker
          name={name}
          color="var(--color-primary)"
          icon={profile.data.avatar}
          size={88}
          layout="column"
          noun="photo"
          hint="Shown wherever you appear on a project."
          onChange={({ iconPath }) => save.mutate({ avatarPath: iconPath })}
        />

        <div className="mt-6 w-full">
          <Field label="Your name">
            <input
              className="input input-bordered w-full text-center"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() && name !== profile.data?.name && save.mutate({ name: name.trim() })}
            />
          </Field>
        </div>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-base-content/45">
          You appear as a person in every workspace, so you can be put on projects and given roles
          like anyone else. Changing this updates all of them.
        </p>
      </div>
    </Panel>
  )
}

/**
 * A theme is a thing you look at, so it is chosen by looking at it. Each card is the
 * app in miniature — the column, the bar, the sheet the page is read on — drawn in
 * that theme's own colours rather than the running one's, which is the whole point:
 * the Dark card has to be dark while you are sitting in Light or it is not showing
 * you anything you did not already know.
 *
 * The colours below are written out rather than taken from the theme tokens for the
 * same reason. They are an illustration, not a surface, and three of them are always
 * the wrong theme for the window they are in.
 */
const PREVIEW = {
  light: { chrome: '#f3f3f5', page: '#ffffff', line: 'rgba(20,20,26,0.10)', bar: 'rgba(20,20,26,0.14)' },
  dark: { chrome: '#232429', page: '#191a1e', line: 'rgba(255,255,255,0.10)', bar: 'rgba(255,255,255,0.17)' }
} as const

/** The one thing in the picker that is a photograph's stand-in rather than a colour. */
const WALLPAPER = 'linear-gradient(135deg, #5b63f5 0%, #b34fb0 46%, #f0913c 100%)'

function Bars({ tone, widths, gap = 5 }: { tone: string; widths: number[]; gap?: number }): React.JSX.Element {
  return (
    <div className="flex flex-col" style={{ gap }}>
      {widths.map((w, i) => (
        <div key={i} style={{ height: 3, width: `${w}%`, borderRadius: 2, background: tone }} />
      ))}
    </div>
  )
}

/** One flat theme, drawn as the app: sidebar, toolbar, and a page of rows. */
function FlatPreview({ mode }: { mode: 'light' | 'dark' }): React.JSX.Element {
  const c = PREVIEW[mode]
  return (
    <div className="flex h-full w-full" style={{ background: c.page }}>
      <div
        className="flex h-full flex-col justify-start p-2"
        style={{ width: '34%', background: c.chrome, borderRight: `1px solid ${c.line}` }}
      >
        <div style={{ height: 5, width: '55%', borderRadius: 2, background: c.bar, marginBottom: 8 }} />
        <Bars tone={c.bar} widths={[80, 62, 70]} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div style={{ height: 12, borderBottom: `1px solid ${c.line}` }} />
        <div className="flex-1 p-2">
          <Bars tone={c.bar} widths={[68, 90, 44]} gap={6} />
        </div>
      </div>
    </div>
  )
}

/**
 * The glass, and it is the real material rather than a picture of one: the wallpaper
 * is painted *inside* the card, so `backdrop-filter` has something in the document to
 * blur and the preview frosts for the same reason the app does. It reads the amount
 * you are dragging, so the slider below has something to answer to.
 */
function GlassPreview({ strength }: { strength: number }): React.JSX.Element {
  // The same two curves the material uses, at the same two ends — including the near
  // one, where the glass is frosted rather than absent. A preview gentler than the
  // thing it previews is a preview that lies about both ends of the slider.
  const chrome = Math.max(0, 0.34 - 0.32 * strength)
  const page = Math.max(0, 0.51 - 0.43 * strength)
  const blur = 7 + 5 * strength
  return (
    <div className="relative h-full w-full" style={{ background: WALLPAPER }}>
      <div
        className="absolute inset-y-0 left-0 flex flex-col p-2"
        style={{
          width: '34%',
          background: `rgba(255,255,255,${chrome})`,
          backdropFilter: `blur(${blur}px) saturate(1.8)`,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.6)'
        }}
      >
        <div
          style={{ height: 5, width: '55%', borderRadius: 2, background: 'rgba(20,20,26,0.34)', marginBottom: 8 }}
        />
        <Bars tone="rgba(20,20,26,0.28)" widths={[80, 62, 70]} />
      </div>
      <div
        className="absolute inset-y-0 right-0 flex flex-col"
        style={{
          left: '34%',
          background: `rgba(255,255,255,${page})`,
          backdropFilter: `blur(${blur}px) saturate(1.8)`
        }}
      >
        <div style={{ height: 12, borderBottom: '1px solid rgba(20,20,26,0.10)' }} />
        <div className="flex-1 p-2">
          <Bars tone="rgba(20,20,26,0.24)" widths={[68, 90, 44]} gap={6} />
        </div>
      </div>
    </div>
  )
}

/** System is both, cut on the diagonal, because that is exactly what it gives you. */
function SystemPreview(): React.JSX.Element {
  return (
    <div className="relative h-full w-full">
      <FlatPreview mode="light" />
      <div
        className="absolute inset-0"
        style={{ clipPath: 'polygon(100% 0, 100% 100%, 0 100%)' }}
      >
        <FlatPreview mode="dark" />
      </div>
    </div>
  )
}

function ThemePreview({ value, strength }: { value: Theme; strength: number }): React.JSX.Element {
  if (value === 'light') return <FlatPreview mode="light" />
  if (value === 'dark') return <FlatPreview mode="dark" />
  if (value === 'system') return <SystemPreview />
  return <GlassPreview strength={strength} />
}

const THEME_NOTE: Record<Theme, string> = {
  light: 'Light whatever the machine is set to.',
  dark: 'Dark whatever the machine is set to.',
  system: 'Follows macOS, and changes with it while the app is open.',
  glass: 'The window itself becomes glass. Colours still follow macOS; only the material changes.'
}

/** The theme lives here rather than in the top bar: you set it once and forget it. */
function AppearancePane(): React.JSX.Element {
  const { theme, setTheme, transparency, setTransparency, material } = useTheme()

  /*
   * The amount you are dragging, before it is a setting. Committed on pointer-up
   * exactly as a panel width is: a slider fires per pixel, and every one of those
   * would be a write and a full cache invalidation. The custom property is set on
   * every move regardless, so the window changes under the handle rather than when
   * you let go of it.
   */
  const [dragged, setDragged] = useState<number | null>(null)
  const shown = dragged ?? transparency

  const preview = (n: number): void => {
    setDragged(n)
    document.documentElement.style.setProperty('--glass-set', String(n / 100))
  }
  const commit = (): void => {
    if (dragged === null) return
    setTransparency(dragged)
    setDragged(null)
  }

  return (
    <Panel>
      <Field label="Theme" hint={THEME_NOTE[theme]}>
        <div className="grid grid-cols-2 gap-3 pt-1">
          {THEMES.map((option) => {
            const selected = theme === option.value
            return (
              <button
                key={option.value}
                onClick={() => setTheme(option.value)}
                aria-pressed={selected}
                className={`rounded-box border p-2 text-left transition ${
                  selected
                    ? 'border-primary ring-2 ring-primary/25'
                    : 'hairline hover:border-base-content/25'
                }`}
              >
                <div
                  className="hairline aspect-[16/10] w-full overflow-hidden rounded-[7px] border"
                  aria-hidden
                >
                  <ThemePreview value={option.value} strength={shown / 100} />
                </div>
                <div className="mt-2 flex items-center gap-2 px-0.5 pb-0.5">
                  {/*
                    A drawn radio and not an <input>: the whole card is the control, so
                    a second focusable thing inside it would be a second tab stop for
                    the same choice. It says which one is on; the button does the work.
                  */}
                  <span
                    className={`flex size-[14px] shrink-0 items-center justify-center rounded-full border transition ${
                      selected ? 'border-primary bg-primary' : 'border-base-content/30'
                    }`}
                  >
                    {selected && <span className="size-[5px] rounded-full bg-primary-content" />}
                  </span>
                  <span className={`text-[13px] ${selected ? 'font-medium' : 'text-base-content/70'}`}>
                    {option.label}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      </Field>

      {/*
        Only under glass, because it is the only theme it means anything to. It is the
        amount, not the material: at nothing at all the window is still a pane of
        glass, and nothing gets through it.
      */}
      {theme === 'glass' && (
        <div className="mt-6">
          <Field
            label="Transparency"
            hint={
              material === 'paint'
                ? 'This machine cannot show the desktop through a window, so the app frosts a backdrop of its own instead.'
                : 'How much of the desktop behind the window comes through the sidebar, the toolbar and the page. Even at the far end it is a thin pane rather than no pane: text has to sit on something.'
            }
          >
            <div className="flex items-center gap-3 pt-1">
              <span className="w-14 shrink-0 text-[11px] text-base-content/40">Frosted</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={shown}
                onChange={(e) => preview(Number(e.target.value))}
                onPointerUp={commit}
                onKeyUp={commit}
                onBlur={commit}
                className="range range-xs range-primary flex-1"
                aria-label="Transparency"
              />
              <span className="w-14 shrink-0 text-right text-[11px] text-base-content/40">Clear</span>
              <span className="w-10 shrink-0 text-right text-[12px] tabular-nums text-base-content/60">
                {shown}%
              </span>
            </div>
          </Field>
          <p className="mt-3 text-[11px] leading-relaxed text-base-content/40">
            Turning on Reduce transparency in macOS accessibility settings overrides this
            and frosts the glass solid.
          </p>
        </div>
      )}
    </Panel>
  )
}

/**
 * How a date, a clock and a temperature are written.
 *
 * On this machine and not on a workspace, which is the whole distinction: which
 * working life you are in changes the photograph at the top of Today, and it does not
 * change whether you count hours to twelve or to twenty-four.
 *
 * Every one of them defaults to what the operating system already says, which is right
 * for almost everybody. They exist for the cases it gets wrong — a machine set to one
 * country used by somebody who thinks in another's units — and the previews are there
 * so the choice is made by looking rather than by decoding an abbreviation.
 */
function FormatsPane(): React.JSX.Element {
  const settings = useApi('settings:get')
  const save = useApiMutation('settings:save')
  const current = settings.data
  /*
   * A day in a month whose name shortens, in a year that is not this one — so the
   * year is part of every preview and "year first" is visibly a different answer
   * from the other three rather than the same string with the parts moved.
   */
  const sample = '2025-11-08'

  if (!current) return <Panel>…</Panel>

  return (
    <Panel>
      <Field label="Clock" hint="Used by the time on Today and by anything that shows an hour.">
        <Choice
          value={current.clockFormat}
          onChange={(clockFormat) => save.mutate({ clockFormat })}
          options={[
            { value: 'system', label: 'System', sample: exampleTime('system') },
            { value: '24', label: '24-hour', sample: exampleTime('24') },
            { value: '12', label: '12-hour', sample: exampleTime('12') }
          ]}
        />
      </Field>

      <div className="mt-5">
        <Field
          label="Dates"
          hint="The order the parts come in. The month and weekday names stay in this machine's own language whichever you pick."
        >
          <Choice
            value={current.dateFormat}
            onChange={(dateFormat) => save.mutate({ dateFormat })}
            options={[
              { value: 'system', label: 'System', sample: formatDateWith('system', sample) },
              { value: 'dmy', label: 'Day first', sample: formatDateWith('dmy', sample) },
              { value: 'mdy', label: 'Month first', sample: formatDateWith('mdy', sample) },
              { value: 'ymd', label: 'Year first', sample: formatDateWith('ymd', sample) }
            ]}
          />
        </Field>
      </div>

      <div className="mt-5">
        <Field label="Temperature" hint="What the weather on Today is read in.">
          <Choice
            value={current.temperatureUnits}
            onChange={(temperatureUnits) => save.mutate({ temperatureUnits })}
            options={[
              {
                value: 'system',
                label: 'System',
                sample:
                  resolveTemperature('system') === 'f'
                    ? formatTemperature(64, 'f')
                    : formatTemperature(18, 'c')
              },
              { value: 'c', label: 'Celsius', sample: formatTemperature(18, 'c') },
              { value: 'f', label: 'Fahrenheit', sample: formatTemperature(64, 'f') }
            ]}
          />
        </Field>
      </div>
    </Panel>
  )
}

/** What a time looks like under one of the three clock choices, right now. */
function exampleTime(choice: ClockFormat): string {
  const at = new Date()
  at.setHours(17, 5, 0, 0)
  return formatTimeWith(choice, at)
}

/**
 * A row of choices, each showing what it would actually look like. One control shape
 * for all three questions, because they are one question asked three times.
 */
function Choice<T extends string>({
  value,
  onChange,
  options
}: {
  value: T
  onChange: (next: T) => void
  options: { value: T; label: string; sample: string }[]
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            aria-pressed={selected}
            className={`rounded-field border px-3 py-1.5 text-left transition ${
              selected ? 'border-primary ring-2 ring-primary/25' : 'hairline hover:border-base-content/25'
            }`}
          >
            <span className="block text-[13px] tabular-nums">{option.sample}</span>
            <span className="mt-0.5 block text-[11px] text-base-content/45">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function DataPane(): React.JSX.Element {
  const settings = useApi('settings:get')
  const reveal = useApiMutation('settings:revealData')
  const exportMarkdown = useApiMutation('settings:exportMarkdown')
  const exportJson = useApiMutation('settings:exportJson')
  const [message, setMessage] = useState('')

  return (
    <Panel>
      <Field label="Folder">
        <div className="flex items-center gap-2">
          <code className="hairline flex-1 truncate rounded-field border bg-base-200/50 px-3 py-2 font-mono text-[11px]">
            {settings.data?.dataDir ?? '…'}
          </code>
          <button className="btn btn-sm gap-1.5" onClick={() => reveal.mutate()}>
            <Icon name="folder" size={13} />
            Reveal
          </button>
        </div>
      </Field>

      <p className="mt-4 text-[12px] leading-relaxed text-base-content/55">
        Everything is in that folder: an embedded Postgres database in <code className="font-mono">db/</code>,
        a Markdown mirror of every note, decision and journal entry in{' '}
        <code className="font-mono">markdown/</code>, uploaded icons in{' '}
        <code className="font-mono">icons/</code>, and exports in{' '}
        <code className="font-mono">exports/</code>. Nothing leaves this machine. Back it up by copying
        the folder.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          className="btn btn-sm gap-1.5"
          onClick={async () => {
            const result = await exportMarkdown.mutateAsync()
            setMessage(`Rebuilt ${result.files} Markdown files.`)
          }}
        >
          <Icon name="note" size={13} />
          Rebuild Markdown mirror
        </button>
        <button
          className="btn btn-sm gap-1.5"
          onClick={async () => {
            const result = await exportJson.mutateAsync()
            setMessage(`Wrote ${result.path}`)
          }}
        >
          <Icon name="external" size={13} />
          Export JSON
        </button>
      </div>

      {message && <p className="mt-3 text-[12px] text-success">{message}</p>}
    </Panel>
  )
}

/**
 * Setting the Claude desktop app up to talk to Neo.
 *
 * The assistant panel is one way in; this is the other, and the difference is worth
 * saying out loud rather than leaving to be discovered. The panel runs on your own
 * OpenAI key and asks before every change. Claude Desktop runs on your Claude
 * subscription and does its own asking — it has no way to show Neo's confirmation,
 * so what you approve is its prompt rather than ours.
 *
 * The button writes one entry into Claude Desktop's own configuration and leaves the
 * rest of that file alone. Doing it by hand means two absolute paths typed into a
 * file in a library folder, which is a poor introduction to a feature whose point is
 * not thinking about plumbing.
 */
function ClaudePane(): React.JSX.Element {
  const status = useApi('mcp:status')
  const connect = useApiMutation('mcp:connect')
  const disconnect = useApiMutation('mcp:disconnect')
  const reveal = useApiMutation('mcp:revealConfig')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [justChanged, setJustChanged] = useState(false)

  const state = status.data
  const snippet = state
    ? JSON.stringify({ mcpServers: { neo: state.entry } }, null, 2)
    : ''

  const run = async (action: 'connect' | 'disconnect'): Promise<void> => {
    setError('')
    try {
      await (action === 'connect' ? connect.mutateAsync() : disconnect.mutateAsync())
      setJustChanged(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!state) return <Panel><p className="text-[12px] text-base-content/55">…</p></Panel>

  return (
    <Panel>
      <p className="text-[13px] leading-relaxed text-base-content/70">
        Neo can hand its tools to the <strong>Claude desktop app</strong>, so you can ask about your
        projects, meetings and people — and have things written down, moved or ticked off — in a
        conversation that started somewhere else.
      </p>

      {!state.claudeInstalled ? (
        <div className="hairline mt-4 rounded-box border bg-base-200/40 px-4 py-3">
          <p className="text-[12px] leading-relaxed text-base-content/70">
            Claude Desktop is not installed on this machine. Install it from{' '}
            <button
              className="underline decoration-base-content/25 hover:decoration-current"
              onClick={() => openExternal('https://claude.ai/download')}
            >
              claude.ai/download
            </button>{' '}
            and come back — this pane will do the rest.
          </p>
        </div>
      ) : (
        <>
          <div className="hairline mt-4 flex flex-wrap items-center gap-3 rounded-box border bg-base-200/40 px-4 py-3">
            <span
              className={`inline-flex size-2 shrink-0 rounded-full ${
                state.connected ? 'bg-success' : state.stale ? 'bg-warning' : 'bg-base-content/25'
              }`}
              aria-hidden="true"
            />
            <span className="flex-1 text-[12.5px] text-base-content/75">
              {state.connected
                ? 'Claude Desktop is set up to talk to Neo.'
                : state.stale
                  ? 'Claude Desktop is pointing at a different copy of Neo. Connect again to point it here.'
                  : 'Claude Desktop does not know about Neo yet.'}
            </span>
            {state.connected ? (
              <button className="btn btn-sm" onClick={() => void run('disconnect')}>
                Disconnect
              </button>
            ) : (
              <button className="btn btn-sm btn-primary gap-1.5" onClick={() => void run('connect')}>
                <Icon name="check" size={13} />
                {state.stale ? 'Point it here' : 'Connect Claude Desktop'}
              </button>
            )}
          </div>

          {justChanged && (
            <p className="mt-3 flex items-center gap-1.5 text-[12px] text-warning">
              <Icon name="refresh" size={13} />
              Quit Claude Desktop and open it again — it only reads that file at startup.
            </p>
          )}
        </>
      )}

      {error && <p className="mt-3 text-[12px] text-error">{error}</p>}

      <p className="mt-5 text-[12px] leading-relaxed text-base-content/55">
        <strong className="font-medium text-base-content/70">Neo has to be open.</strong> The
        connector holds no copy of your data — it passes every question through to this app, which
        answers it the same way the assistant panel does. With Neo shut, Claude says so and does
        nothing. Everything it writes is logged and mirrored to Markdown exactly as if you had
        clicked it yourself.
      </p>

      <p className="mt-3 text-[12px] leading-relaxed text-base-content/55">
        It can change things, and the confirmation you get is <em>Claude Desktop&rsquo;s</em>, not
        Neo&rsquo;s — reading is marked as reading, and deleting is marked as deleting, but the
        assistant panel is the one that stops and shows you a sentence first.
      </p>

      <details className="group mt-5">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] text-base-content/55 hover:text-base-content/80">
          <Icon
            name="chevronRight"
            size={12}
            className="transition-transform group-open:rotate-90"
          />
          Set it up by hand instead
        </summary>
        <div className="mt-3">
          <p className="text-[12px] leading-relaxed text-base-content/55">
            Put this in{' '}
            <button
              className="underline decoration-base-content/25 hover:decoration-current"
              onClick={() => reveal.mutate()}
            >
              claude_desktop_config.json
            </button>
            , merging it with anything already there.
          </p>
          <pre className="hairline mt-2 overflow-x-auto rounded-field border bg-base-200/50 px-3 py-2 font-mono text-[11px] leading-relaxed">
            {snippet}
          </pre>
          <button
            className="btn btn-xs mt-2 gap-1.5"
            onClick={async () => {
              await navigator.clipboard.writeText(snippet)
              setCopied(true)
              window.setTimeout(() => setCopied(false), 2000)
            }}
          >
            <Icon name={copied ? 'check' : 'note'} size={12} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </details>
    </Panel>
  )
}

function ShortcutsPane(): React.JSX.Element {
  return (
    <Panel>
      <dl className="grid gap-2 text-[12px] sm:grid-cols-2">
        {[
          ['⌘K', 'Search everything'],
          ['⌘N', 'New item, from anywhere'],
          ['⌘↵', 'Save and close a dialog'],
          ['Esc', 'Close a dialog, or leave settings']
        ].map(([key, label]) => (
          <div key={key} className="flex items-center gap-3">
            <Kbd>{key}</Kbd>
            <span className="text-base-content/60">{label}</span>
          </div>
        ))}
      </dl>
    </Panel>
  )
}

function AboutPane(): React.JSX.Element {
  const settings = useApi('settings:get')

  return (
    <Panel>
      <div className="flex items-center gap-4">
        <Logo size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold tracking-[-0.015em]">Neo</span>
            <span className="font-mono text-[11px] text-base-content/40">
              {settings.data?.appVersion ?? '…'}
            </span>
          </div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-base-content/55">
            A personal command centre for running several working lives at once. Everything it
            knows is on this machine.
          </p>
        </div>
      </div>
    </Panel>
  )
}
