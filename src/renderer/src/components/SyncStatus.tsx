import { useEffect, useRef, useState } from 'react'
import type { QueuedWrite } from '@shared/sync'
import { call } from '@/lib/api'
import { relativeFromIso } from '@/lib/format'
import { useSync } from '@/lib/sync'
import { useDismissToast, useToast } from '@/lib/toast'
import { Icon } from './Icon'

/**
 * Whether what you are doing has reached Neo Cloud yet — said only when it has not.
 *
 * Online with nothing waiting, which is nearly always, this draws nothing at all: a
 * permanent "Synced ✓" is a badge you learn to stop seeing, and then it is not there
 * for the day it matters. It appears in three cases, quietest first:
 *
 * - **Saving** — writes have been waiting more than a moment. Grey, no colour.
 * - **Offline** — Neo Cloud cannot be reached. Still grey: nothing is wrong with your
 *   work, it is waiting, and the count says how much.
 * - **Not saved** — Neo Cloud refused something made offline. The one warm state,
 *   because it is the one that needs you.
 *
 * Pressing it says what is happening in a sentence and lists the writes by name, with
 * Retry and Discard on anything refused.
 */
export function SyncStatus({ floating = false }: { floating?: boolean }): React.JSX.Element | null {
  const sync = useSync()
  const [open, setOpen] = useState(false)
  const slow = useSlow(sync.online && sync.pending.length > 0)
  useFailureToast(sync.failed)
  useBackOnlineToast(sync.online, sync.pending.length)

  const failed = sync.failed.length
  const waiting = sync.pending.length
  const showing = !sync.online || failed > 0 || slow
  if (!showing && !open) return null

  const label =
    failed > 0
      ? `${failed} not saved`
      : !sync.online
        ? waiting > 0
          ? `Offline · ${waiting} waiting`
          : 'Offline'
        : `Saving ${waiting} ${waiting === 1 ? 'change' : 'changes'}…`

  return (
    <div className={floating ? 'absolute bottom-4 left-4 z-30' : 'relative'}>
      <button
        className={`flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition ${
          failed > 0
            ? 'border-warning/40 bg-warning/10 text-warning hover:bg-warning/15'
            : 'hairline bg-base-200/70 text-base-content/60 hover:bg-base-200 hover:text-base-content'
        } ${floating ? 'glass-raised shadow-lg shadow-black/5' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={sync.online ? 'Changes waiting for Neo Cloud' : 'Neo Cloud cannot be reached'}
      >
        <Icon
          name={failed > 0 ? 'alert' : sync.online ? 'refresh' : 'cloudOff'}
          size={13}
          className={sync.online && failed === 0 ? 'animate-spin [animation-duration:2s]' : ''}
        />
        <span className="tabular-nums">{label}</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className={`rise glass-raised hairline absolute z-50 w-80 rounded-box border bg-base-100 p-4 shadow-xl shadow-black/10 ${
              floating ? 'bottom-full left-0 mb-2' : 'right-0 top-full mt-2'
            }`}
          >
            <Explainer online={sync.online} waiting={waiting} failed={failed} />
            {waiting > 0 && <WriteList title="Waiting to be sent" writes={sync.pending} />}
            {failed > 0 && <FailedList writes={sync.failed} />}
          </div>
        </>
      )}
    </div>
  )
}

function Explainer({ online, waiting, failed }: { online: boolean; waiting: number; failed: number }): React.JSX.Element {
  if (failed > 0) {
    return (
      <div>
        <div className="text-[13px] font-medium">Some changes were not saved</div>
        <p className="mt-1 text-[12px] leading-relaxed text-base-content/55">
          Neo Cloud turned these down when they were sent. Try them again, or let them go — the screen will show
          what Neo Cloud has.
        </p>
      </div>
    )
  }
  if (!online) {
    return (
      <div>
        <div className="flex items-center gap-1.5 text-[13px] font-medium">
          <Icon name="cloudOff" size={14} className="text-base-content/50" />
          Neo Cloud cannot be reached
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-base-content/55">
          Keep working. {waiting > 0 ? 'What you change' : 'Anything you change'} is kept on this Mac and sent to Neo
          Cloud, in order, the moment it can be reached. You are looking at the last copy this Mac has.
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-base-content/40">
          The assistant, recording a meeting and adding pictures need Neo Cloud, so they wait until it is back.
        </p>
      </div>
    )
  }
  return (
    <div>
      <div className="text-[13px] font-medium">Sending to Neo Cloud</div>
      <p className="mt-1 text-[12px] leading-relaxed text-base-content/55">
        These are on screen already and go one after another, in the order you made them.
      </p>
    </div>
  )
}

const SHOWN = 6

function WriteList({ title, writes }: { title: string; writes: QueuedWrite[] }): React.JSX.Element {
  return (
    <div className="mt-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-base-content/40">{title}</div>
      <ul className="mt-1.5 space-y-1">
        {writes.slice(0, SHOWN).map((write) => (
          <li key={write.id} className="flex items-baseline justify-between gap-3 text-[12px]">
            <span className="min-w-0 truncate">{write.label}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-base-content/35">{relativeFromIso(write.at)}</span>
          </li>
        ))}
      </ul>
      {writes.length > SHOWN && (
        <div className="mt-1 text-[11px] text-base-content/40">and {writes.length - SHOWN} more</div>
      )}
    </div>
  )
}

function FailedList({ writes }: { writes: QueuedWrite[] }): React.JSX.Element {
  return (
    <div className="mt-3">
      <ul className="space-y-2">
        {writes.map((write) => (
          <li key={write.id} className="text-[12px]">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate font-medium">{write.label}</span>
              <span className="flex shrink-0 gap-2.5 text-[11px]">
                <button className="font-medium text-primary hover:underline" onClick={() => void call('sync:retry', { id: write.id })}>
                  Retry
                </button>
                <button
                  className="text-base-content/45 hover:text-base-content"
                  onClick={() => void call('sync:discard', { id: write.id })}
                >
                  Discard
                </button>
              </span>
            </div>
            {write.error && <div className="mt-0.5 line-clamp-2 text-[11px] text-base-content/45">{write.error}</div>}
          </li>
        ))}
      </ul>
      {writes.length > 1 && (
        <div className="hairline mt-3 flex justify-end gap-2 border-t pt-3">
          <button className="btn btn-ghost btn-xs" onClick={() => void call('sync:discard', {})}>
            Discard all
          </button>
          <button className="btn btn-primary btn-xs" onClick={() => void call('sync:retry', {})}>
            Retry all
          </button>
        </div>
      )}
    </div>
  )
}

/** True once `on` has held for a moment — a write that lands in 200 ms is not worth a word. */
function useSlow(on: boolean, after = 1_500): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!on) {
      setSlow(false)
      return
    }
    const timer = setTimeout(() => setSlow(true), after)
    return () => clearTimeout(timer)
  }, [on, after])
  return slow
}

/**
 * Writes made offline and refused on the way back have nobody waiting on them — the
 * dialog closed hours ago — so the refusal is said once, out loud, where it is seen,
 * with the two answers to it.
 */
function useFailureToast(failed: QueuedWrite[]): void {
  const toast = useToast()
  const dismiss = useDismissToast()
  const seen = useRef(failed.length)
  useEffect(() => {
    const before = seen.current
    seen.current = failed.length
    if (failed.length === 0) {
      dismiss('sync-failed')
      return
    }
    if (failed.length <= before) return
    toast({
      key: 'sync-failed',
      tone: 'error',
      icon: 'alert',
      title:
        failed.length === 1
          ? `Not saved: ${failed[0]!.label}`
          : `${failed.length} changes made offline were not saved`,
      detail: failed.length === 1 ? failed[0]!.error : failed.map((f) => f.label).join(' · '),
      actions: [
        { label: failed.length === 1 ? 'Try again' : 'Try them again', onClick: () => void call('sync:retry', {}) },
        { label: 'Discard', onClick: () => void call('sync:discard', {}) }
      ]
    })
  }, [failed, toast, dismiss])
}

/** Coming back is worth one quiet line when there was something waiting to go. */
function useBackOnlineToast(online: boolean, waiting: number): void {
  const toast = useToast()
  const owed = useRef(false)
  useEffect(() => {
    if (!online && waiting > 0) owed.current = true
    if (online && waiting === 0 && owed.current) {
      owed.current = false
      toast({ tone: 'info', icon: 'cloud', title: 'Back online', detail: 'Everything you changed is in Neo Cloud.' })
    }
  }, [online, waiting, toast])
}
