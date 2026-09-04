import type { ReentryBrief as Brief } from '@shared/types'
import { plural, relativeFromIso } from '@/lib/format'
import { Icon } from '@/components/Icon'

const KIND_LABEL: Record<string, string> = {
  task_created: 'added',
  task_completed: 'completed',
  note: 'note',
  decision: 'decision',
  journal: 'journal',
  state_updated: 'updated',
  person_added: 'people',
  link_added: 'link',
  project_created: 'created'
}

/**
 * The cure for "where were we". Shown only when you have actually been away —
 * it diffs what changed against your previous visit rather than reciting history
 * you already know.
 */
export function ReentryBrief({ brief }: { brief: Brief }): React.JSX.Element | null {
  if (!brief.isReturning) return null

  return (
    <div className="rise mb-7 rounded-box border border-primary/25 bg-primary/[0.05] px-5 py-4">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-primary">
        <Icon name="refresh" size={13} />
        Picking this back up
      </div>

      <p className="mt-2 text-sm leading-relaxed">
        You last opened this{' '}
        <strong className="font-medium">
          {brief.daysSinceOpened === null ? 'never' : `${plural(brief.daysSinceOpened, 'day')} ago`}
        </strong>
        {brief.changes.length > 0 ? (
          <>
            {' '}and <strong className="font-medium">{plural(brief.changes.length, 'thing')}</strong> changed since.
          </>
        ) : (
          <> and nothing has changed since.</>
        )}
      </p>

      {brief.changes.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-primary/15 pt-3">
          {brief.changes.slice(0, 6).map((change) => (
            <li key={change.id} className="flex items-baseline gap-2 text-[12px] text-base-content/70">
              <span className="w-16 shrink-0 text-[10px] uppercase tracking-wide text-base-content/40">
                {KIND_LABEL[change.kind] ?? change.kind}
              </span>
              <span className="min-w-0 flex-1 truncate">{change.summary}</span>
              <span className="shrink-0 text-[11px] text-base-content/35">
                {relativeFromIso(change.createdAt)}
              </span>
            </li>
          ))}
          {brief.changes.length > 6 && (
            <li className="pt-1 text-[11px] text-base-content/40">
              and {brief.changes.length - 6} more in the activity log below
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
