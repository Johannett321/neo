import { useState } from 'react'
import type { Link, LinkKind } from '@shared/types'
import { openExternal, useApiMutation } from '@/lib/api'
import { differs, LINK_KIND_LABEL } from '@/lib/format'
import { Icon, type IconName } from '@/components/Icon'
import { ConfirmDialog, EmptyState, Field, Modal, Section } from '@/components/primitives'
import { useContextMenu } from '@/lib/contextMenu'

const KIND_ICON: Record<LinkKind, IconName> = {
  repo: 'folder',
  board: 'projects',
  design: 'sparkle',
  docs: 'note',
  chat: 'people',
  drive: 'folder',
  staging: 'external',
  other: 'link'
}

const KINDS = Object.keys(LINK_KIND_LABEL) as LinkKind[]

/**
 * The cheapest feature here and one of the most useful: the work lives in eight
 * other apps, and this is the one place that remembers where they all are.
 */
export function LinksPanel({ projectId, links }: { projectId: string; links: Link[] }): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Link | null>(null)
  const remove = useApiMutation('link:delete')
  const openMenu = useContextMenu()

  return (
    <Section
      title="Links"
      count={links.length}
      action={
        <button className="btn btn-ghost btn-xs gap-1" onClick={() => setAdding(true)}>
          <Icon name="plus" size={12} />
          Add
        </button>
      }
    >
      {links.length === 0 ? (
        <EmptyState
          icon="link"
          title="No links yet."
          hint="The board, the repo, the Figma file, the client's folder — whatever you keep hunting for."
        />
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {links.map((link) => (
            <div key={link.id} className="group relative">
              <button
                className="hairline row-hover flex items-center gap-2 rounded-field border bg-base-100 py-1.5 pl-2.5 pr-7 text-[12px]"
                onClick={() => openExternal(link.url)}
                onContextMenu={(e) =>
                  openMenu(e, [
                    { label: 'Open link', icon: 'external', onSelect: () => openExternal(link.url) },
                    'separator',
                    {
                      label: 'Remove link',
                      icon: 'trash',
                      danger: true,
                      onSelect: () => remove.mutate({ id: link.id }),
                      confirm: { title: `Remove ${link.label}?`, body: link.url, confirmLabel: 'Remove' }
                    }
                  ])
                }
                title={link.url}
              >
                <Icon name={KIND_ICON[link.kind]} size={13} className="text-base-content/40" />
                {link.label}
              </button>
              <button
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-base-content/25 opacity-0 transition hover:text-error group-hover:opacity-100"
                onClick={() => setRemoving(link)}
                aria-label={`Remove ${link.label}`}
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      <AddLinkModal open={adding} onClose={() => setAdding(false)} projectId={projectId} />
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.label}?`}
        body={removing?.url}
        confirmLabel="Remove"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) remove.mutate({ id: removing.id })
          setRemoving(null)
        }}
      />
    </Section>
  )
}

function AddLinkModal({
  open,
  onClose,
  projectId
}: {
  open: boolean
  onClose: () => void
  projectId: string
}): React.JSX.Element {
  const save = useApiMutation('link:save')
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [kind, setKind] = useState<LinkKind>('other')

  const submit = async (): Promise<void> => {
    if (!label.trim() || !url.trim()) return
    await save.mutateAsync({ projectId, label: label.trim(), url: url.trim(), kind })
    setLabel('')
    setUrl('')
    setKind('other')
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a link"
      onSubmit={() => void submit()}
      isDirty={differs({ label, url, kind }, { label: '', url: '', kind: 'other' })}
      footer={
        <>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={!label.trim() || !url.trim()}
            onClick={() => void submit()}
          >
            Add
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Label">
          <input
            autoFocus
            className="input input-bordered w-full"
            placeholder="Jira board"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label="URL">
          <input
            className="input input-bordered w-full font-mono text-xs"
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </Field>
        <Field label="Type">
          <select
            className="select select-bordered w-full"
            value={kind}
            onChange={(e) => setKind(e.target.value as LinkKind)}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {LINK_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  )
}
