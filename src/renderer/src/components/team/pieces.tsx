import { useEffect, useRef, useState } from 'react'
import { motion, useTransform, type MotionValue } from 'framer-motion'
import type { CastMember } from '@shared/types'
import { Avatar } from '@/components/primitives'
import { Icon } from '@/components/Icon'
import { parseRoles } from '@/components/RoleInput'

/*
 * The things drawn on the team board. Each is told where it is through motion values
 * owned by the board, so a card and the line into it are always read off the same
 * numbers — a connector can never lag a card that is springing into place.
 */

export interface NodeMotion {
  x: MotionValue<number>
  y: MotionValue<number>
  w: MotionValue<number>
  h: MotionValue<number>
}

/** The open items on this project that are someone's — "who works on what", quietly. */
export type OpenCounts = Map<string, number>

export function PersonCard({
  member,
  open,
  selected,
  targeted,
  lifted,
  onEditRole
}: {
  member: CastMember
  open: number
  selected: boolean
  targeted: boolean
  lifted: boolean
  onEditRole: () => void
}): React.JSX.Element {
  const roles = parseRoles(member.role)
  return (
    <div
      className={[
        'flex h-full w-full items-center gap-2.5 rounded-[12px] border bg-base-100 px-3 transition-[box-shadow,border-color,background-color] duration-150',
        targeted
          ? 'border-primary/60 shadow-[0_0_0_4px_color-mix(in_oklch,var(--color-primary)_16%,transparent),0_10px_30px_-12px_color-mix(in_oklch,var(--color-primary)_55%,transparent)]'
          : selected
            ? 'border-primary/45 shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-primary)_14%,transparent)]'
            : 'hairline',
        lifted
          ? 'shadow-[0_22px_45px_-18px_rgb(0_0_0/0.45),0_6px_14px_-8px_rgb(0_0_0/0.25)]'
          : !targeted && !selected
            ? 'shadow-[0_1px_2px_rgb(0_0_0/0.05)] hover:shadow-[0_6px_18px_-10px_rgb(0_0_0/0.3)]'
            : ''
      ].join(' ')}
    >
      <Avatar name={member.name} color={member.avatarColor} image={member.avatar} size={34} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-[13px] font-semibold leading-tight">{member.name}</span>
          {member.isMe && <span className="shrink-0 text-[10px] text-base-content/40">You</span>}
        </div>
        <div className="mt-0.5 flex items-baseline gap-2">
          <button
            type="button"
            className={`min-w-0 truncate rounded text-left text-[11.5px] leading-tight transition hover:text-primary ${
              roles.length ? 'text-base-content/55' : 'italic text-base-content/30'
            }`}
            onClick={(e) => {
              e.stopPropagation()
              onEditRole()
            }}
            title="Change the role on this project"
          >
            {roles.length ? roles.join(' · ') : 'Add a role'}
          </button>
          {open > 0 && (
            <span
              className="ml-auto shrink-0 text-[11px] tabular-nums text-base-content/45"
              title={`${open} open item${open === 1 ? '' : 's'} on this project`}
            >
              {open} open
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export function BoxCard({
  label,
  count,
  empty,
  depth,
  selected,
  targeted,
  lifted,
  editing,
  onRename,
  onStartRename
}: {
  label: string
  /** People inside, at any depth. */
  count: number
  /** Nothing at all sits in it — not a person, not a box. */
  empty: boolean
  /** How many boxes it sits inside: alternate tints keep a box inside a box legible. */
  depth: number
  selected: boolean
  targeted: boolean
  lifted: boolean
  editing: boolean
  onRename: (label: string) => void
  onStartRename: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(label)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) {
      setDraft(label)
      requestAnimationFrame(() => input.current?.select())
    }
  }, [editing, label])

  return (
    <div
      className={[
        'relative h-full w-full rounded-[16px] border transition-[box-shadow,border-color,background-color] duration-150',
        targeted
          ? 'border-primary/55 bg-primary/[0.06] shadow-[0_0_0_5px_color-mix(in_oklch,var(--color-primary)_13%,transparent)]'
          : selected
            ? 'border-primary/40 bg-base-200/60 shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-primary)_12%,transparent)]'
            : depth % 2
              ? 'hairline bg-base-100'
              : 'hairline bg-base-200/50',
        lifted ? 'shadow-[0_26px_50px_-20px_rgb(0_0_0/0.4)]' : depth > 0 ? 'shadow-[0_1px_2px_rgb(0_0_0/0.05)]' : ''
      ].join(' ')}
    >
      <div className="flex h-[38px] items-center gap-2 px-3.5" data-handle="box">
        <Icon name="box" size={13} className="text-base-content/35" />
        {editing ? (
          <input
            ref={input}
            className="quiet-input -mx-1 min-w-0 flex-1 px-1 text-[12.5px] font-semibold"
            value={draft}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => onRename(draft.trim() || label)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') {
                setDraft(label)
                onRename(label)
              }
              e.stopPropagation()
            }}
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-[12.5px] font-semibold tracking-[0.01em]"
            onDoubleClick={(e) => {
              e.stopPropagation()
              onStartRename()
            }}
          >
            {label || 'Untitled box'}
          </span>
        )}
        <span className="shrink-0 text-[11px] tabular-nums text-base-content/40">{count || ''}</span>
      </div>
      {empty && (
        <div
          className={`pointer-events-none absolute inset-x-[14px] bottom-[14px] top-[38px] flex items-center justify-center rounded-[12px] border border-dashed text-[11.5px] transition-colors ${
            targeted ? 'border-primary/50 text-primary' : 'border-base-content/15 text-base-content/35'
          }`}
        >
          Drop people here
        </div>
      )}
    </div>
  )
}

/**
 * A line from the bottom of one node to the top of the one under it: an S of two
 * vertical tangents, which reads as "under" from any angle the tree can grow at.
 */
export function Connector({
  from,
  to,
  pending,
  reduced
}: {
  from: NodeMotion
  to: NodeMotion
  pending: boolean
  reduced: boolean
}): React.JSX.Element {
  const d = useTransform(
    [from.x, from.y, from.w, from.h, to.x, to.y, to.w] as MotionValue<number>[],
    ([fx, fy, fw, fh, tx, ty, tw]: number[]) => {
      const x1 = fx + fw / 2
      const y1 = fy + fh
      const x2 = tx + tw / 2
      const y2 = ty
      const k = Math.max(18, Math.abs(y2 - y1) / 2)
      return `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`
    }
  )
  return (
    <g>
      <motion.path
        d={d}
        fill="none"
        stroke={pending ? 'var(--color-primary)' : 'color-mix(in oklch, var(--color-base-content) 22%, transparent)'}
        strokeWidth={pending ? 2 : 1.5}
        strokeDasharray={pending ? '5 5' : undefined}
        strokeLinecap="round"
        initial={reduced ? false : { pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.38, ease: [0.32, 0.72, 0, 1] }}
      />
      {/* The joint where a line meets the card under it, so the two read as attached. */}
      <ConnectorJoint to={to} pending={pending} />
    </g>
  )
}

function ConnectorJoint({ to, pending }: { to: NodeMotion; pending: boolean }): React.JSX.Element {
  const cx = useTransform([to.x, to.w] as MotionValue<number>[], ([x, w]: number[]) => x + w / 2)
  return (
    <motion.circle
      cx={cx}
      cy={to.y}
      r={pending ? 3.5 : 2.5}
      fill={pending ? 'var(--color-primary)' : 'color-mix(in oklch, var(--color-base-content) 30%, transparent)'}
    />
  )
}

/** The little celebration where something lands: a ring and a scatter of sparks. */
export function Burst({ x, y, tone }: { x: number; y: number; tone: 'primary' | 'muted' }): React.JSX.Element {
  const colour = tone === 'primary' ? 'var(--color-primary)' : 'color-mix(in oklch, var(--color-base-content) 45%, transparent)'
  const sparks = 10
  return (
    <div className="pointer-events-none absolute" style={{ left: x, top: y }}>
      <motion.span
        className="absolute block rounded-full border-2"
        style={{ borderColor: colour, width: 64, height: 64, left: -32, top: -32 }}
        initial={{ scale: 0.25, opacity: 0.7 }}
        animate={{ scale: 1.9, opacity: 0 }}
        transition={{ duration: 0.6, ease: [0.2, 0.7, 0.3, 1] }}
      />
      {Array.from({ length: sparks }, (_, i) => {
        const angle = (i / sparks) * Math.PI * 2 + (i % 2 ? 0.2 : -0.1)
        const reach = 34 + (i % 3) * 10
        return (
          <motion.span
            key={i}
            className="absolute block rounded-full"
            style={{ backgroundColor: colour, width: 5, height: 5, left: -2.5, top: -2.5 }}
            initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
            animate={{ x: Math.cos(angle) * reach, y: Math.sin(angle) * reach, opacity: 0, scale: 0.3 }}
            transition={{ duration: 0.55 + (i % 3) * 0.06, ease: [0.15, 0.8, 0.3, 1] }}
          />
        )
      })}
    </div>
  )
}

/**
 * The project's people, down the side of the board. Who is already on the chart is
 * shown as placed rather than hidden — the list is also the answer to "who have I not
 * put anywhere yet?", and the count at the top is how close the drawing is to done.
 */
export function Tray({
  cast,
  placed,
  dragging,
  removing,
  trayRef,
  onPick,
  onClickPerson,
  onAddPeople,
  onMenu
}: {
  cast: CastMember[]
  placed: Map<string, number>
  dragging: boolean
  removing: boolean
  trayRef: React.RefObject<HTMLDivElement | null>
  onPick: (e: React.PointerEvent, member: CastMember) => void
  onClickPerson: (member: CastMember) => void
  onAddPeople: () => void
  onMenu: (e: React.MouseEvent, member: CastMember) => void
}): React.JSX.Element {
  const count = cast.filter((m) => placed.has(m.personId)).length
  const unplaced = cast.filter((m) => !placed.has(m.personId))
  const done = cast.filter((m) => placed.has(m.personId))
  return (
    <div
      ref={trayRef}
      data-tray
      className={`glass-raised absolute bottom-3 right-3 top-3 z-20 flex w-[236px] flex-col rounded-box border bg-base-100/95 shadow-[0_12px_40px_-20px_rgb(0_0_0/0.35)] backdrop-blur transition-[border-color,box-shadow] duration-150 ${
        removing ? 'border-error/50 shadow-[0_0_0_4px_color-mix(in_oklch,var(--color-error)_14%,transparent)]' : 'hairline'
      }`}
    >
      <div className="px-3.5 pb-2 pt-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[12.5px] font-semibold">People</span>
          <span className="text-[11px] tabular-nums text-base-content/45">
            {count} of {cast.length} placed
          </span>
        </div>
        <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-base-content/[0.07]">
          <motion.div
            className="h-full rounded-full bg-primary/70"
            initial={false}
            animate={{ width: `${cast.length ? (count / cast.length) * 100 : 0}%` }}
            transition={{ type: 'spring', stiffness: 260, damping: 30 }}
          />
        </div>
      </div>

      {removing ? (
        <div className="m-3 flex flex-1 flex-col items-center justify-center gap-2 rounded-[12px] border border-dashed border-error/40 text-center text-[12px] text-error">
          <Icon name="trash" size={18} />
          Drop to take off the chart
        </div>
      ) : (
        <div className="scroll-area min-h-0 flex-1 px-2 pb-2">
          {unplaced.length > 0 && <TrayHeading>Not on the chart yet</TrayHeading>}
          {unplaced.map((m) => (
            <TrayRow key={m.id} member={m} placed={0} dragging={dragging} onPick={onPick} onClick={onClickPerson} onMenu={onMenu} />
          ))}
          {done.length > 0 && <TrayHeading>On the chart</TrayHeading>}
          {done.map((m) => (
            <TrayRow
              key={m.id}
              member={m}
              placed={placed.get(m.personId) ?? 0}
              dragging={dragging}
              onPick={onPick}
              onClick={onClickPerson}
              onMenu={onMenu}
            />
          ))}
        </div>
      )}

      <button
        className="hairline flex items-center gap-1.5 border-t px-3.5 py-2.5 text-left text-[11.5px] text-base-content/50 transition hover:text-base-content"
        onClick={onAddPeople}
      >
        <Icon name="plus" size={12} />
        Add someone to the project
      </button>
    </div>
  )
}

function TrayHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="px-1.5 pb-1 pt-2.5 text-[10px] font-medium uppercase tracking-[0.12em] text-base-content/35">
      {children}
    </div>
  )
}

function TrayRow({
  member,
  placed,
  dragging,
  onPick,
  onClick,
  onMenu
}: {
  member: CastMember
  placed: number
  dragging: boolean
  onPick: (e: React.PointerEvent, member: CastMember) => void
  onClick: (member: CastMember) => void
  onMenu: (e: React.MouseEvent, member: CastMember) => void
}): React.JSX.Element {
  const roles = parseRoles(member.role)
  return (
    <div
      role="button"
      tabIndex={0}
      className={`group flex cursor-grab touch-none select-none items-center gap-2.5 rounded-field px-1.5 py-1.5 transition active:cursor-grabbing ${
        dragging ? '' : 'hover:bg-base-content/[0.05]'
      } ${placed ? 'opacity-50 hover:opacity-90' : ''}`}
      onPointerDown={(e) => {
        if (e.button === 0) onPick(e, member)
      }}
      onContextMenu={(e) => onMenu(e, member)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick(member)
      }}
      title={placed ? 'On the chart — click to find, drag to place again' : 'Drag onto the board, or click to place'}
    >
      <Avatar name={member.name} color={member.avatarColor} image={member.avatar} size={28} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium leading-tight">{member.name}</div>
        <div className="truncate text-[11px] leading-tight text-base-content/45">
          {roles.length ? roles.join(' · ') : 'No role yet'}
        </div>
      </div>
      {placed ? (
        <Icon name="check" size={13} className="shrink-0 text-base-content/40" />
      ) : (
        <Icon name="grip" size={13} className="shrink-0 text-base-content/25 opacity-0 transition group-hover:opacity-100" />
      )}
    </div>
  )
}

/**
 * An empty board offers two ways to begin, each placing the whole project for you —
 * a drawing to adjust is far less work than a blank one to compose.
 */
export function StartChoices({
  people,
  onTree,
  onBoxes,
  onAddPeople
}: {
  people: number
  onTree: () => void
  onBoxes: () => void
  onAddPeople: () => void
}): React.JSX.Element {
  /*
   * Nobody on the project yet, so neither start has anyone to place: the one useful
   * thing to offer is the person. Once somebody is added the templates take over.
   */
  if (people === 0) {
    return (
      <motion.div
        className="pointer-events-auto flex w-[min(420px,calc(100%-32px))] flex-col items-center text-center"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
      >
        <div className="flex h-[92px] w-[132px] items-center justify-center rounded-[10px] bg-base-200/60 text-base-content/30">
          <TreeSketch />
        </div>
        <div className="mt-4 text-[17px] font-semibold tracking-[-0.01em]">Who is on this project?</div>
        <div className="mt-1.5 text-[12.5px] leading-relaxed text-base-content/55">
          Add the people involved — someone from the workspace or someone new — and draw how they fit together.
        </div>
        <button className="btn btn-primary btn-sm mt-5 gap-1.5" onClick={onAddPeople}>
          <Icon name="plus" size={14} />
          Add the first person
        </button>
      </motion.div>
    )
  }
  return (
    <motion.div
      className="pointer-events-auto flex w-[min(560px,calc(100%-32px))] flex-col items-center text-center"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
    >
      <div className="text-[17px] font-semibold tracking-[-0.01em]">Draw the team</div>
      <div className="mt-1.5 max-w-[420px] text-[12.5px] leading-relaxed text-base-content/55">
        Pick a start and all {people === 1 ? 'one person' : `${people} people`} on this project are placed for you.
        Then drag them where they belong.
      </div>
      <div className="mt-5 grid w-full grid-cols-2 gap-3">
        <StartCard title="As a tree" hint="Who reports to whom, lead at the top" onClick={onTree}>
          <TreeSketch />
        </StartCard>
        <StartCard title="In boxes" hint="Grouped by the role each person holds" onClick={onBoxes}>
          <BoxesSketch />
        </StartCard>
      </div>
      <div className="mt-4 text-[11.5px] text-base-content/40">
        or drag someone from the list onto the board
      </div>
    </motion.div>
  )
}

function StartCard({
  title,
  hint,
  onClick,
  children
}: {
  title: string
  hint: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <motion.button
      type="button"
      className="hairline group flex flex-col items-start rounded-box border bg-base-100 p-3 text-left shadow-[0_1px_2px_rgb(0_0_0/0.05)] transition-[border-color,box-shadow] hover:border-primary/45 hover:shadow-[0_14px_34px_-18px_color-mix(in_oklch,var(--color-primary)_60%,transparent)]"
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
    >
      <div className="flex h-[92px] w-full items-center justify-center rounded-[10px] bg-base-200/60 text-base-content/30 transition-colors group-hover:text-primary/70">
        {children}
      </div>
      <div className="mt-2.5 text-[13px] font-semibold">{title}</div>
      <div className="text-[11.5px] text-base-content/50">{hint}</div>
    </motion.button>
  )
}

function TreeSketch(): React.JSX.Element {
  return (
    <svg width="132" height="72" viewBox="0 0 132 72" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="46" y="4" width="40" height="16" rx="4" fill="currentColor" fillOpacity="0.15" />
      <path d="M66 20 C66 32, 22 30, 22 44 M66 20 V44 M66 20 C66 32, 110 30, 110 44" strokeLinecap="round" />
      <rect x="4" y="46" width="36" height="16" rx="4" />
      <rect x="48" y="46" width="36" height="16" rx="4" />
      <rect x="92" y="46" width="36" height="16" rx="4" />
    </svg>
  )
}

function BoxesSketch(): React.JSX.Element {
  return (
    <svg width="132" height="72" viewBox="0 0 132 72" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="4" y="6" width="58" height="60" rx="7" strokeDasharray="0" />
      <rect x="70" y="6" width="58" height="60" rx="7" />
      <rect x="11" y="20" width="44" height="11" rx="3" fill="currentColor" fillOpacity="0.15" />
      <rect x="11" y="36" width="44" height="11" rx="3" fill="currentColor" fillOpacity="0.15" />
      <rect x="77" y="20" width="44" height="11" rx="3" fill="currentColor" fillOpacity="0.15" />
      <rect x="77" y="36" width="44" height="11" rx="3" fill="currentColor" fillOpacity="0.15" />
      <rect x="77" y="52" width="44" height="9" rx="3" fill="currentColor" fillOpacity="0.15" />
    </svg>
  )
}
