import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion'
import { call as callApi, useApi, useApiMutation } from '@/lib/api'
import { EASE } from '@/lib/motion'
import { useTheme } from '@/lib/theme'
import { useWorkspaces } from '@/lib/workspace'
import { Icon, type IconName } from '@/components/Icon'
import { IconPicker } from '@/components/IconPicker'
import { Logo } from '@/components/Logo'
import { Mark } from '@/components/Mark'
import { Field, Kbd } from '@/components/primitives'
import { WORKSPACE_COLORS } from '@/components/WorkspaceModal'

/**
 * The first launch, and the only one.
 *
 * Everywhere else this app assumes you know why you opened it. Here it cannot: there
 * is no data, nothing is derived from anything, and every screen the app is proud of
 * would be an empty state. So the first two panels are the pitch — what this is for,
 * and the one constraint the whole thing is built around — and only then does it ask
 * for anything.
 *
 * What it asks for is deliberately two things and no more: who you are, and one
 * working life to put in it. Both are used immediately, neither can be got wrong, and
 * the workspace is not written until the last button — so backing out of the flow
 * leaves nothing behind, and arriving at the end is arriving at something you made
 * rather than a form you filled in.
 *
 * `onDone` matters more than it looks. The gate that renders this is latched in App,
 * because creating the workspace makes its own condition false: without the latch the
 * screen would vanish mid-save and the app would arrive behind it.
 */

type Step = 'intro' | 'tour' | 'profile' | 'workspace' | 'notifications' | 'ready'

/**
 * The flow without the panel that asks for permission, which is most desktops.
 *
 * Windows shows a notification and lets you switch it off afterwards, and a Linux
 * desktop has no per-application permission at all — so on both, a screen asking for
 * consent would be asking for something nobody is going to be asked for. macOS does
 * put the question up, and there is exactly one way to raise it: show a notification.
 * `notification:capability` is what decides, so the check is a fact main reports
 * rather than a platform string the renderer has read for itself.
 */
const BASE_STEPS: Step[] = ['intro', 'tour', 'profile', 'workspace', 'ready']
const GATED_STEPS: Step[] = ['intro', 'tour', 'profile', 'workspace', 'notifications', 'ready']

/** The three names people actually give their first workspace. */
const SUGGESTIONS = ['Day job', 'My company', 'Client work']

export function Welcome({ onDone }: { onDone: () => void }): React.JSX.Element {
  // The shell is not mounted yet, and the stored preference is nobody else's to apply.
  useTheme()
  const reduce = useReducedMotion()
  const { switchTo } = useWorkspaces()
  const settings = useApi('settings:get')
  const suggestedName = useApi('profile:suggestName')

  const saveProfile = useApiMutation('profile:save')
  const saveWorkspace = useApiMutation('workspace:save')
  const saveSettings = useApiMutation('settings:save')
  const loadSample = useApiMutation('settings:loadSample')

  /*
   * Latched on the first answer, exactly as the gate in App is and for the same kind
   * of reason: `index` is a position in this list, so a list that grew underneath
   * somebody would move them to a different panel than the one they were reading.
   */
  const capability = useApi('notification:capability')
  const [steps, setSteps] = useState<Step[]>(BASE_STEPS)
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (settled || !capability.data) return
    setSteps(capability.data.gated && capability.data.supported ? GATED_STEPS : BASE_STEPS)
    setSettled(true)
  }, [capability.data, settled])

  const [index, setIndex] = useState(0)
  // Which way the panels travel. Going back reverses it, so the movement always
  // agrees with the button that caused it.
  const [direction, setDirection] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [name, setName] = useState('')
  const [avatarPath, setAvatarPath] = useState('')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [touchedName, setTouchedName] = useState(false)

  /*
   * What the desktop said when it was asked. Null until the button is pressed, and
   * kept so the panel can answer honestly either way — a refusal and a prompt that is
   * still open are indistinguishable from in here, so it says that rather than
   * guessing which one happened.
   */
  const [asked, setAsked] = useState<{ shown: boolean; reason: string } | null>(null)

  const [workspaceName, setWorkspaceName] = useState('')
  const [color, setColor] = useState(WORKSPACE_COLORS[0] as string)
  const [iconPath, setIconPath] = useState('')
  const [icon, setIcon] = useState<string | null>(null)

  // The machine already knows your name, so the field starts filled and the job
  // becomes correcting it rather than composing it. Typing anything ends this.
  useEffect(() => {
    const machine = suggestedName.data?.name
    if (machine && !touchedName && !name) setName(machine)
  }, [suggestedName.data?.name, touchedName, name])

  const step = steps[index] as Step
  /*
   * The rail names the things that are done, so it has to gain a segment when the
   * flow does — three full bars with two panels still to go would be the progress
   * bar lying in the one direction a progress bar is never forgiven for.
   */
  const rail = steps.includes('notifications')
    ? ['Neo is installed', 'You', 'Your first workspace', 'Notifications']
    : ['Neo is installed', 'You', 'Your first workspace']
  // Two of the five panels have nothing to type into, and a form only submits on
  // Return from a field inside it — so on those the button takes the focus itself
  // and Return keeps working the whole way through.
  const primary = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (step === 'intro' || step === 'tour' || step === 'ready') primary.current?.focus()
  }, [step])

  const go = (delta: number): void => {
    setDirection(delta)
    setIndex((current) => Math.min(steps.length - 1, Math.max(0, current + delta)))
  }

  /** Nothing is written until here. Order matters: you exist before the workspace
   *  that mirrors you as a person does. */
  const finish = async (): Promise<void> => {
    if (busy || !workspaceName.trim()) return
    setBusy(true)
    setError('')
    try {
      await saveProfile.mutateAsync({ name: name.trim() || 'Me', avatarPath })
      const created = await saveWorkspace.mutateAsync({
        name: workspaceName.trim(),
        color,
        iconPath
      })
      await saveSettings.mutateAsync({ onboardedAt: new Date().toISOString() })
      switchTo(created.id)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That could not be saved.')
      setBusy(false)
    }
  }

  /** The way in for someone who would rather see it working than be told about it. */
  const lookAround = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await loadSample.mutateAsync()
      await saveSettings.mutateAsync({ onboardedAt: new Date().toISOString() })
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The sample data could not be loaded.')
      setBusy(false)
    }
  }

  const canContinue =
    step === 'profile' ? Boolean(name.trim()) : step === 'workspace' ? Boolean(workspaceName.trim()) : true

  /**
   * Ask the operating system, then carry on whatever it answers.
   *
   * There is no API for "may I?" — showing one is the request — so this posts a real
   * notification, which is both the question macOS puts on screen and, once it has
   * been allowed, the thing the person sees and recognises later. The flow is never
   * blocked on the answer: an app that will not let you past a permission screen is
   * an app that has confused its own convenience for consent.
   */
  const askAndContinue = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      setAsked(await callApi('notification:test'))
    } catch {
      setAsked({ shown: false, reason: 'Your system did not answer.' })
    }
    setBusy(false)
  }

  /** Keep it quiet, and say so in settings rather than leaving it on and ignored. */
  const declineNotifications = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await saveSettings.mutateAsync({ notifications: false })
    } catch {
      // Nothing to say: the switch is in Settings either way.
    }
    setBusy(false)
    go(1)
  }

  const submit = (): void => {
    if (!canContinue) return
    if (step === 'ready') void finish()
    // Pressed once it asks; pressed again it moves on, so the answer has somewhere to
    // land and "allowed" is confirmed on the screen that asked for it.
    else if (step === 'notifications' && !asked) void askAndContinue()
    else go(1)
  }

  const panel: Variants = reduce
    ? {
        enter: { opacity: 0 },
        centre: { opacity: 1, transition: { duration: 0.14, staggerChildren: 0.03 } },
        leave: { opacity: 0, transition: { duration: 0.08 } }
      }
    : {
        enter: (dir: number) => ({ opacity: 0, x: dir * 28 }),
        centre: {
          opacity: 1,
          x: 0,
          transition: { duration: 0.28, ease: EASE, staggerChildren: 0.055, delayChildren: 0.05 }
        },
        leave: (dir: number) => ({ opacity: 0, x: dir * -20, transition: { duration: 0.12, ease: EASE } })
      }

  return (
    <div className="welcome-sky relative flex h-full items-center justify-center overflow-hidden px-6">
      {/* The window is frameless: this is still the strip you drag it by. */}
      <div className="drag-region absolute inset-x-0 top-0 h-[52px]" />

      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="welcome-light welcome-light-a"
          style={{ top: '-12%', left: '-8%', width: '46vw', height: '46vw', background: '#fbbf24' }}
        />
        <div
          className="welcome-light welcome-light-b"
          style={{ top: '20%', right: '-14%', width: '52vw', height: '52vw', background: '#e11d48' }}
        />
        <div
          className="welcome-light welcome-light-c"
          style={{ bottom: '-20%', left: '18%', width: '48vw', height: '48vw', background: '#7c3aed' }}
        />
      </div>

      <motion.div
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: reduce ? 0.2 : 0.5, ease: EASE }}
        className="squircle relative z-10 flex w-full max-w-[620px] flex-col overflow-hidden bg-base-100 shadow-[0_36px_90px_-24px_rgb(0_0_0/0.55)]"
        style={{ height: 'min(560px, calc(100vh - 96px))' }}
      >
        {/*
          Only the three steps that ask for something carry the rail. The pitch is not
          a task with a percentage on it, and putting one there would have said "four
          more screens of this" at the exact moment the app is making its case.
        */}
        {index >= 2 && <Rail at={index - 2} steps={rail} />}

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="scroll-area min-h-0 flex-1 px-9 py-8">
            <AnimatePresence mode="wait" custom={direction} initial={false}>
              <motion.div
                key={step}
                custom={direction}
                variants={panel}
                initial="enter"
                animate="centre"
                exit="leave"
              >
                {step === 'intro' && <Intro reduce={Boolean(reduce)} />}
                {step === 'tour' && <Tour />}
                {step === 'profile' && (
                  <Profile
                    name={name}
                    avatar={avatar}
                    onName={(next) => {
                      setTouchedName(true)
                      setName(next)
                    }}
                    onAvatar={(path, preview) => {
                      setAvatarPath(path)
                      setAvatar(preview)
                    }}
                  />
                )}
                {step === 'workspace' && (
                  <WorkspaceStep
                    name={workspaceName}
                    color={color}
                    icon={icon}
                    onName={setWorkspaceName}
                    onColor={setColor}
                    onIcon={(path, preview) => {
                      setIconPath(path)
                      setIcon(preview)
                    }}
                  />
                )}
                {step === 'notifications' && <Notifications asked={asked} />}
                {step === 'ready' && (
                  <Ready
                    name={name}
                    workspaceName={workspaceName}
                    color={color}
                    icon={icon}
                    dataDir={settings.data?.dataDir ?? ''}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="hairline flex items-center gap-3 border-t px-9 py-4">
            {index === 0 ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm gap-1.5 text-base-content/50"
                disabled={busy}
                onClick={() => void lookAround()}
              >
                <Icon name="sparkle" size={13} />
                Look around with sample data
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-sm text-base-content/50"
                disabled={busy}
                onClick={() => go(-1)}
              >
                Back
              </button>
            )}

            {error && <span className="min-w-0 flex-1 truncate text-[12px] text-error">{error}</span>}

            <div className="ml-auto flex items-center gap-3">
              {step === 'intro' && (
                <span className="hidden text-[12px] text-base-content/40 sm:block">
                  {steps.includes('notifications') ? 'Three' : 'Two'} short steps and you are in
                </span>
              )}
              {/* Declining is a button beside the one that agrees, not a link hidden
                  under it: a choice you have to hunt for is not one you were offered. */}
              {step === 'notifications' && !asked && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm text-base-content/50"
                  disabled={busy}
                  onClick={() => void declineNotifications()}
                >
                  Not now
                </button>
              )}
              <button
                ref={primary}
                type="submit"
                className="btn btn-primary btn-sm gap-1.5"
                disabled={!canContinue || busy}
              >
                {step === 'intro'
                  ? 'Show me'
                  : step === 'tour'
                    ? 'Set it up'
                    : step === 'notifications'
                      ? asked
                        ? 'Continue'
                        : 'Turn them on'
                      : step === 'ready'
                        ? busy
                          ? 'Opening…'
                          : 'Open Neo'
                        : 'Continue'}
                {!busy && <Icon name="arrowRight" size={13} />}
              </button>
            </div>
          </div>
        </form>
      </motion.div>
    </div>
  )
}

/**
 * Three segments, the first of which is already full. That is not a trick: installing
 * it and opening it is genuine work already done, and a progress bar that starts at
 * nothing tells a truthful story about the remaining effort in the least motivating
 * way available.
 */
function Rail({ at, steps }: { at: number; steps: string[] }): React.JSX.Element {
  return (
    <div className="hairline flex items-center gap-3 border-b px-9 py-3.5">
      {steps.map((label, i) => {
        const done = i <= at
        return (
          <div key={label} className="flex min-w-0 flex-1 items-center gap-2">
            <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-base-300">
              <motion.div
                className="h-full rounded-full bg-primary"
                initial={{ scaleX: done ? 1 : 0 }}
                animate={{ scaleX: done ? 1 : 0 }}
                transition={{ duration: 0.35, ease: EASE }}
                style={{ originX: 0 }}
              />
            </div>
            <span
              className={`shrink-0 text-[11px] ${
                i === at + 1 ? 'font-medium text-base-content/70' : 'text-base-content/35'
              }`}
            >
              {label}
              {i <= at && ' ✓'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

const item: Variants = {
  enter: { opacity: 0, y: 10 },
  centre: { opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE } },
  leave: { opacity: 0, transition: { duration: 0.1 } }
}

/** Every child of a panel arrives in sequence, so the panel reads top to bottom. */
function Line({ children, className = '' }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <motion.div variants={item} className={className}>
      {children}
    </motion.div>
  )
}

/** The pitch. The three questions are the README's, word for word, because they are
 *  the reason the app exists and nothing said them better. */
function Intro({ reduce }: { reduce: boolean }): React.JSX.Element {
  const questions: [IconName, string][] = [
    ['alert', 'What is on fire today, across every context?'],
    ['people', 'Who is who on this project again?'],
    ['hourglass', 'Where the hell were we on this?']
  ]

  return (
    <div>
      {/* The entrance is the panel's, so the float has to be a layer inside it: a
          child with its own `animate` object stops inheriting the parent's label. */}
      <Line className="inline-block">
        <motion.div
          animate={reduce ? undefined : { y: [0, -5, 0] }}
          transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
        >
          <Logo size={52} />
        </motion.div>
      </Line>

      <Line className="mt-6">
        <h1 className="text-[30px] font-semibold leading-[1.15] tracking-[-0.025em]">
          Everything you are running,
          <br />
          in one place.
        </h1>
      </Line>

      <Line className="mt-3">
        <p className="max-w-[30rem] text-[13.5px] leading-relaxed text-base-content/60">
          Jira, Linear and Notion are where work gets executed. Neo is the layer above them — for a
          day job, your own company and a client at once — and it answers the three questions none
          of them do.
        </p>
      </Line>

      <div className="mt-6 space-y-2.5">
        {questions.map(([glyph, question]) => (
          <Line key={question}>
            <div className="hairline flex items-center gap-3 rounded-box border bg-base-200/40 px-3.5 py-2.5">
              <Icon name={glyph} size={15} className="shrink-0 text-primary" />
              <span className="text-[13px] text-base-content/75">{question}</span>
            </div>
          </Line>
        ))}
      </div>
    </div>
  )
}

/** The second half of the pitch: the constraint the whole product is built around. */
function Tour(): React.JSX.Element {
  const cards: [IconName, string, string][] = [
    [
      'projects',
      'Separate working lives',
      'A workspace is a day job, your own company, a client. It is a hard boundary — no screen ever mixes two of them.'
    ],
    [
      'today',
      'One screen for today',
      'Overdue, due today, the next seven days. Grouped by how urgent it is rather than which project it came from.'
    ],
    [
      'alert',
      'Nothing to keep updated',
      'No status field to maintain. It works out what is pressing and says why: “2 overdue items, oldest 9 days past due”.'
    ],
    [
      'hourglass',
      'Pick anything back up',
      'Open a project after three weeks away and it tells you how long it has been and what changed while you were gone.'
    ]
  ]

  return (
    <div>
      <Line>
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Built to survive neglect</h1>
      </Line>
      <Line className="mt-2">
        <p className="max-w-[32rem] text-[13.5px] leading-relaxed text-base-content/60">
          If keeping it accurate is work, it gets abandoned in three weeks. So capture is cheap,
          almost nothing needs upkeep, and every screen stays useful when the data is a month old.
        </p>
      </Line>

      <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
        {cards.map(([glyph, title, body]) => (
          <Line key={title}>
            <div className="hairline h-full rounded-box border bg-base-200/40 p-3.5">
              <div className="flex items-center gap-2">
                <Icon name={glyph} size={14} className="text-primary" />
                <span className="text-[12.5px] font-semibold tracking-[-0.01em]">{title}</span>
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-base-content/55">{body}</p>
            </div>
          </Line>
        ))}
      </div>

      <Line className="mt-5">
        <p className="text-[11.5px] leading-relaxed text-base-content/40">
          Everything is kept on this machine, in your Documents folder, as a database and a mirror of
          plain Markdown. Nothing leaves it on its own.
        </p>
      </Line>
    </div>
  )
}

function Profile({
  name,
  avatar,
  onName,
  onAvatar
}: {
  name: string
  avatar: string | null
  onName: (next: string) => void
  onAvatar: (path: string, preview: string | null) => void
}): React.JSX.Element {
  return (
    <div>
      <Line>
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">First, you</h1>
      </Line>
      <Line className="mt-2">
        <p className="max-w-[32rem] text-[13.5px] leading-relaxed text-base-content/60">
          You are a person in here like anyone else: put on projects, given roles, assigned work,
          listed as a meeting attendee. One profile, mirrored into every workspace — change it once
          and it changes everywhere.
        </p>
      </Line>

      <Line className="mt-7">
        <div className="mx-auto flex max-w-sm flex-col items-center">
          <IconPicker
            name={name}
            color="var(--color-primary)"
            icon={avatar}
            size={84}
            layout="column"
            noun="photo"
            hint="Optional. Without one, your initials are used."
            onChange={({ iconPath, icon }) => onAvatar(iconPath, icon)}
          />
          <div className="mt-6 w-full">
            <Field label="Your name">
              <input
                autoFocus
                className="input input-bordered w-full text-center"
                placeholder="Your name"
                value={name}
                onChange={(e) => onName(e.target.value)}
              />
            </Field>
          </div>
        </div>
      </Line>
    </div>
  )
}

function WorkspaceStep({
  name,
  color,
  icon,
  onName,
  onColor,
  onIcon
}: {
  name: string
  color: string
  icon: string | null
  onName: (next: string) => void
  onColor: (next: string) => void
  onIcon: (path: string, preview: string | null) => void
}): React.JSX.Element {
  return (
    <div>
      <Line>
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Now one working life</h1>
      </Line>
      <Line className="mt-2">
        <p className="max-w-[32rem] text-[13.5px] leading-relaxed text-base-content/60">
          Start with whichever one is busiest. You can add the others whenever you like, and
          switching between them is one click at the bottom of the sidebar.
        </p>
      </Line>

      <Line className="mt-6">
        <Field label="Name">
          <input
            autoFocus
            className="input input-bordered w-full"
            placeholder="Day job"
            value={name}
            onChange={(e) => onName(e.target.value)}
          />
        </Field>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="hairline rounded-field border px-2.5 py-1 text-[12px] text-base-content/55 transition hover:bg-base-200"
              onClick={() => onName(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      </Line>

      <Line className="mt-5">
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
              onClick={() => onColor(swatch)}
              aria-label={swatch}
            />
          ))}
        </div>
        <span className="mt-1.5 block text-[11px] text-base-content/40">
          An identifier, not a theme: it tints the sidebar so you always know which one you are in.
        </span>
      </Line>

      <Line className="mt-6">
        <IconPicker
          name={name}
          color={color}
          icon={icon}
          hint="Optional — PNG, JPG, WebP, GIF or SVG, up to 2 MB."
          onChange={({ iconPath, icon: preview }) => onIcon(iconPath, preview)}
        />
      </Line>
    </div>
  )
}

/** What you made, before it is written. The two shortcuts are the two that matter on
 *  an empty app: putting something in, and finding it again. */
/**
 * The one panel in the flow that asks for something the app cannot give itself.
 *
 * It is here rather than at the first launch of the app because a permission prompt
 * with no explanation in front of it is a prompt people decline: by this point there
 * is a workspace with a name on it, and "we will tell you when something in it is
 * close" is a sentence about their own work rather than about a feature. The pitch is
 * also the honest one — what arrives is a deadline, once a day, and nothing else.
 *
 * Only shown where the operating system actually asks. See `notification:capability`.
 */
function Notifications({
  asked
}: {
  asked: { shown: boolean; reason: string } | null
}): React.JSX.Element {
  const moments: [IconName, string][] = [
    ['flag', 'A project deadline a week out, and again on the day'],
    ['clock', 'A card due tomorrow, and one due today'],
    ['alert', 'Anything still open the morning after it was due']
  ]

  return (
    <div>
      <Line>
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
          Be told before it is late
        </h1>
      </Line>
      <Line className="mt-2">
        <p className="max-w-[32rem] text-[13.5px] leading-relaxed text-base-content/60">
          Neo works out what is coming from the dates already on your work — there is no
          reminder to set, and nothing to dismiss. Once a morning it says the one thing
          worth knowing, and the rest of the day it is quiet.
        </p>
      </Line>

      <Line className="mt-6">
        <div className="hairline space-y-2.5 rounded-box border bg-base-200/40 px-4 py-3.5">
          {moments.map(([glyph, label]) => (
            <div key={label} className="flex items-center gap-2.5">
              <Icon name={glyph} size={14} className="shrink-0 text-primary" />
              <span className="text-[12.5px] text-base-content/65">{label}</span>
            </div>
          ))}
        </div>
      </Line>

      <Line className="mt-4">
        <p className="text-[11.5px] leading-relaxed text-base-content/40">
          Nine in the morning, never at weekends, and one notification however many things
          are due on it. All of it is yours to change in Settings, per workspace, and you
          can turn the whole thing off in a click.
        </p>
      </Line>

      {/*
        The answer, once there is one. A refusal and a prompt still sitting on screen
        look identical from in here, so the failing case says what to do about either
        rather than announcing which it thinks happened.
      */}
      <Line className="mt-5">
        {asked === null ? (
          <p className="text-[12px] leading-relaxed text-base-content/45">
            Your Mac will ask you to allow it. Nothing is sent anywhere — a notification is
            drawn by this machine, from work that never leaves it.
          </p>
        ) : asked.shown ? (
          <div className="flex items-start gap-2.5 text-[12.5px] text-base-content/65">
            <Icon name="check" size={15} className="mt-px shrink-0 text-success" />
            <span>
              That one just appeared on your desktop. Deadlines will arrive looking like it.
            </span>
          </div>
        ) : (
          <div className="flex items-start gap-2.5 text-[12.5px] text-base-content/65">
            <Icon name="alert" size={15} className="mt-px shrink-0 text-warning" />
            <span>
              Nothing appeared yet. If your Mac has just asked, choose Allow — otherwise you
              can switch Neo on under Notifications in System Settings, and send yourself a
              test one from Settings whenever you like.
            </span>
          </div>
        )}
      </Line>
    </div>
  )
}

function Ready({
  name,
  workspaceName,
  color,
  icon,
  dataDir
}: {
  name: string
  workspaceName: string
  color: string
  icon: string | null
  dataDir: string
}): React.JSX.Element {
  const first = name.trim().split(' ')[0] ?? ''
  return (
    <div>
      <Line>
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
          You are set{first ? `, ${first}` : ''}
        </h1>
      </Line>
      <Line className="mt-2">
        <p className="max-w-[32rem] text-[13.5px] leading-relaxed text-base-content/60">
          Neo opens on Today. It will be empty until there is a project in it — that is the next
          thing to make, and everything else hangs off one.
        </p>
      </Line>

      <Line className="mt-6">
        <div className="hairline flex items-center gap-3 rounded-box border bg-base-200/40 px-4 py-3.5">
          <Mark name={workspaceName} color={color} icon={icon} size={34} rounded="rounded-[10px]" />
          <div className="min-w-0">
            <div className="truncate text-[14px] font-medium">{workspaceName}</div>
            <div className="text-[11.5px] text-base-content/45">
              Your first workspace. Add the others from the switcher whenever you need them.
            </div>
          </div>
        </div>
      </Line>

      <Line className="mt-5">
        <div className="space-y-2">
          {[
            ['⌘N', 'Capture a task, a decision, a log entry or a meeting from anywhere'],
            ['⌘K', 'Find any of it again — projects, people, notes, decisions'],
            ['⌘⇧N', 'Start a project']
          ].map(([key, label]) => (
            <div key={key} className="flex items-center gap-3">
              <Kbd>{key}</Kbd>
              <span className="text-[12.5px] text-base-content/60">{label}</span>
            </div>
          ))}
        </div>
      </Line>

      {dataDir && (
        <Line className="mt-5">
          <p className="text-[11.5px] leading-relaxed text-base-content/40">
            Everything you write lands in{' '}
            <code className="font-mono text-[11px] text-base-content/55">{dataDir}</code>, including a
            plain-Markdown copy of it. Back it up by copying that folder.
          </p>
        </Line>
      )}
    </div>
  )
}
