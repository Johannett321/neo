import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Health } from '@shared/types'
import { Icon, type IconName } from './Icon'
import { initials } from '@/lib/format'

/** Workspace identity: a dot, never a filled surface. */
export function Dot({ color, size = 7 }: { color: string; size?: number }): React.JSX.Element {
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, backgroundColor: color }}
    />
  )
}

const HEALTH_COLOR: Record<Health['level'], string> = {
  good: 'bg-success',
  watch: 'bg-warning',
  risk: 'bg-error',
  idle: 'bg-base-content/25'
}

const HEALTH_TEXT: Record<Health['level'], string> = {
  good: 'On track',
  watch: 'Watch',
  risk: 'At risk',
  idle: 'Idle'
}

/** The colour always carries its reasons — hover explains why it is what it is. */
export function HealthDot({ health, showLabel = false }: { health: Health; showLabel?: boolean }): React.JSX.Element {
  return (
    <span className="tooltip tooltip-bottom max-w-full" data-tip={health.reasons.join(' · ')}>
      <span className="flex items-center gap-1.5">
        <span className={`inline-block size-2 rounded-full ${HEALTH_COLOR[health.level]}`} />
        {showLabel && <span className="text-xs text-base-content/60">{HEALTH_TEXT[health.level]}</span>}
      </span>
    </span>
  )
}

export function Avatar({
  name,
  color,
  image,
  size = 28
}: {
  name: string
  color: string
  /** An uploaded photo, if the person has one. */
  image?: string | null
  size?: number
}): React.JSX.Element {
  if (image) {
    return (
      <img
        src={image}
        alt=""
        title={name}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white"
      style={{ width: size, height: size, backgroundColor: color, fontSize: size * 0.36 }}
      title={name}
    >
      {initials(name)}
    </span>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-7 flex items-start justify-between gap-6">
      <div className="min-w-0">
        <h1 className="truncate text-[26px] font-semibold tracking-[-0.02em]">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-base-content/55">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Section({
  title,
  count,
  tone = 'default',
  action,
  children
}: {
  title: string
  count?: number
  tone?: 'default' | 'danger' | 'warn'
  action?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  const toneClass =
    tone === 'danger' ? 'text-error' : tone === 'warn' ? 'text-warning' : 'text-base-content/45'
  return (
    <section className="mb-9">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h2 className={`text-[11px] font-semibold uppercase tracking-[0.09em] ${toneClass}`}>
          {title}
          {count !== undefined && count > 0 && (
            <span className="ml-1.5 font-normal tabular-nums opacity-70">{count}</span>
          )}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

export function Panel({
  children,
  className = '',
  padded = true
}: {
  children: ReactNode
  className?: string
  padded?: boolean
}): React.JSX.Element {
  return (
    <div className={`hairline rounded-box border bg-base-100 ${padded ? 'p-4' : ''} ${className}`}>
      {children}
    </div>
  )
}

export function EmptyState({
  icon = 'sparkle',
  title,
  hint,
  action
}: {
  icon?: IconName
  title: string
  hint?: string
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="hairline flex flex-col items-center gap-2 rounded-box border border-dashed px-6 py-10 text-center">
      <Icon name={icon} size={20} className="text-base-content/25" />
      <div className="text-sm font-medium text-base-content/70">{title}</div>
      {hint && <div className="max-w-sm text-xs leading-relaxed text-base-content/45">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  onSubmit,
  isDirty = false,
  width = 'max-w-xl'
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  /** When given, the body becomes a form so Enter in any field submits it. */
  onSubmit?: () => void
  /** Guards the accidental ways out — the backdrop, Escape and the close button. */
  isDirty?: boolean
  width?: string
}): React.JSX.Element | null {
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!open) setConfirming(false)
  }, [open])

  // Clicking away is easy to do by accident, so it asks first when there is work to lose.
  const attemptClose = useCallback((): void => {
    if (isDirty) setConfirming(true)
    else onClose()
  }, [isDirty, onClose])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (confirming) setConfirming(false)
      else attemptClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, confirming, attemptClose])

  if (!open) return null
  return (
    <div
      data-modal-backdrop
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/25 p-8 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        // Only a press that both starts and ends on the backdrop counts, so a text
        // selection dragged out of the dialog does not throw the work away.
        if (e.target === e.currentTarget) attemptClose()
      }}
    >
      <div
        className={`rise hairline relative w-full ${width} rounded-box border bg-base-100 shadow-2xl shadow-black/10`}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/*
          The dialog blurs *itself* while confirming rather than sitting behind a
          backdrop-filter: a focused input gets its own compositing layer, which a
          backdrop filter does not capture, leaving it sharp over the blur.
        */}
        <div
          className={
            confirming ? 'pointer-events-none select-none opacity-50 blur-[2px] transition' : 'transition'
          }
          aria-hidden={confirming}
        >
          <div className="hairline flex items-start justify-between gap-4 border-b px-5 py-4">
            <div>
              <h3 className="font-semibold tracking-[-0.01em]">{title}</h3>
              {description && <p className="mt-0.5 text-xs text-base-content/50">{description}</p>}
            </div>
            <button className="btn btn-ghost btn-xs btn-circle" onClick={attemptClose} aria-label="Close">
              <Icon name="close" size={14} />
            </button>
          </div>

          {onSubmit ? (
            <form
              className="px-5 py-4"
              onSubmit={(e) => {
                e.preventDefault()
                onSubmit()
              }}
            >
              {children}
              {/* Gives the form a submit target so Enter works in every field. */}
              <button type="submit" className="hidden" tabIndex={-1} aria-hidden="true" />
            </form>
          ) : (
            <div className="px-5 py-4">{children}</div>
          )}

          {footer && <div className="hairline flex justify-end gap-2 border-t px-5 py-3">{footer}</div>}
        </div>

        {confirming && (
          <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
            <div className="rise hairline w-[19rem] rounded-box border bg-base-100 p-4 text-center shadow-xl shadow-black/15">
              <h4 className="text-sm font-semibold">Discard your changes?</h4>
              <p className="mt-1 text-[12px] leading-relaxed text-base-content/55">
                What you have typed here has not been saved.
              </p>
              <div className="mt-4 flex gap-2">
                <button autoFocus className="btn btn-sm flex-1" onClick={() => setConfirming(false)}>
                  Keep editing
                </button>
                <button
                  className="btn btn-error btn-sm flex-1"
                  onClick={() => {
                    setConfirming(false)
                    onClose()
                  }}
                >
                  Discard
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function Field({
  label,
  hint,
  children,
  className = ''
}: {
  label: string
  hint?: string
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-xs font-medium text-base-content/65">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-base-content/40">{hint}</span>}
    </label>
  )
}

/** Grows with its content so long prose never hides behind a scrollbar. */
export function AutoTextarea({
  value,
  onChange,
  placeholder,
  minRows = 3,
  className = '',
  onBlur
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  minRows?: number
  className?: string
  onBlur?: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={minRows}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      className={`w-full resize-none px-3 py-2 text-sm leading-relaxed ${className}`}
    />
  )
}

/**
 * A destructive action always states what it is about to do before doing it. Sits above
 * dialogs, so it works from inside one.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel
}: {
  open: boolean
  title: string
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onCancel])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-8 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="rise hairline w-full max-w-sm rounded-box border bg-base-100 p-5 shadow-2xl shadow-black/20"
        role="alertdialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h3>
        {body && <div className="mt-1.5 text-[12px] leading-relaxed text-base-content/60">{body}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn btn-sm" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button autoFocus className="btn btn-error btn-sm" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ConfirmButton({
  onConfirm,
  label = 'Delete',
  title,
  body,
  confirmLabel,
  className = 'btn btn-ghost btn-xs text-base-content/40 hover:text-error'
}: {
  onConfirm: () => void
  label?: string
  /** Defaults to the button's own label, phrased as a question. */
  title?: string
  body?: ReactNode
  confirmLabel?: string
  className?: string
}): React.JSX.Element {
  const [asking, setAsking] = useState(false)
  return (
    <>
      <button
        className={className}
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          setAsking(true)
        }}
      >
        {label}
      </button>
      <ConfirmDialog
        open={asking}
        title={title ?? `${label}?`}
        body={body ?? 'This cannot be undone.'}
        confirmLabel={confirmLabel ?? label}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false)
          onConfirm()
        }}
      />
    </>
  )
}

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <kbd className="hairline rounded border px-1.5 py-0.5 font-mono text-[10px] text-base-content/50">
      {children}
    </kbd>
  )
}

export function Stat({ value, label }: { value: number | string; label: string }): React.JSX.Element {
  return (
    <div>
      <div className="text-2xl font-semibold tracking-[-0.02em] tabular-nums">{value}</div>
      <div className="text-xs text-base-content/50">{label}</div>
    </div>
  )
}
