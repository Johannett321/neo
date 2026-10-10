import type { ChangelogEntry } from '@shared/update'
import { Icon, isIconName } from '@/components/Icon'
import { Kbd } from '@/components/primitives'
import { Markdown } from '@/components/Markdown'

/**
 * A changelog, drawn the same way wherever it appears — the dialog after an update
 * and the history in Settings → Updates.
 *
 * Written as a short list, it is a tile and a line per feature: something to glance
 * down, not a page to read. An older file written as prose still draws, as the
 * Markdown it always was.
 */
export function ChangelogBody({
  entry,
  compact = false
}: {
  entry: ChangelogEntry
  /** Smaller tiles and type, for the history list where several sit together. */
  compact?: boolean
}): React.JSX.Element {
  if (!entry.items.length) {
    return <Markdown source={entry.body} className={compact ? 'text-[12.5px]' : 'text-[13px]'} />
  }

  return (
    <ul className={compact ? 'space-y-2.5' : 'space-y-3.5'}>
      {entry.items.map((item, i) => (
        <li key={i} className="flex items-start gap-3">
          <div
            className={`flex shrink-0 items-center justify-center bg-primary/10 text-primary ${
              compact ? 'size-7 rounded-lg' : 'size-9 rounded-xl'
            }`}
          >
            <Icon name={isIconName(item.icon) ? item.icon : 'sparkle'} size={compact ? 14 : 17} />
          </div>
          <div className={`min-w-0 flex-1 ${compact ? 'pt-0.5' : 'pt-[3px]'}`}>
            <div className={`font-medium leading-snug ${compact ? 'text-[12.5px]' : 'text-[13px]'}`}>
              {item.title}
            </div>
            {item.detail && (
              <p
                className={`mt-0.5 leading-relaxed text-base-content/55 ${
                  compact ? 'text-[11.5px]' : 'text-[12px]'
                }`}
              >
                <Inline text={item.detail} />
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * The one piece of Markdown a single line needs: a `⌘K` in backticks is a key, and
 * a release that adds a shortcut wants to show it. Everything else is plain text.
 */
function Inline({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/`([^`]+)`/)
  return <>{parts.map((part, i) => (i % 2 ? <Kbd key={i}>{part}</Kbd> : part))}</>
}
