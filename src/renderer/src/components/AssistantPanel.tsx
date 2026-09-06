import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useMatch } from 'react-router-dom'
import type { AttachmentUpload, ChatMessage, ToolRecord } from '@shared/types'
import { call, useApi } from '@/lib/api'
import { PanelResizeHandle, useResizablePanel } from '@/lib/resize'
import { ENTER, EXIT } from '@/lib/motion'
import { readFileForUpload, useAssistant, type LiveTool } from '@/lib/assistant'
import { useWorkspace } from '@/lib/workspace'
import { useContextMenu } from '@/lib/contextMenu'
import { Icon } from './Icon'
import { Markdown } from './Markdown'
import { EmptyState } from './primitives'

/**
 * The assistant, in a panel down the right-hand side.
 *
 * It pushes the page rather than floating over it. A reply is usually about
 * something you are looking at — a board, a person, a meeting write-up — and an
 * overlay would cover the very thing you asked about.
 *
 * Your messages are the app's orange; its own are plain prose on the page's own
 * background. That asymmetry is the point: what you said is a handful of words worth
 * marking, and what it said is a document worth reading, and dressing a long Markdown
 * answer in a coloured bubble makes it harder to read, not easier to place.
 */

/* ------------------------------------------------------------------- transcript */

/** Text the model wrote, pulled out of the API's own output items. */
/* eslint-disable @typescript-eslint/no-explicit-any */
function assistantText(message: ChatMessage): string {
  return message.blocks
    .filter((item: any) => item?.type === 'message')
    .flatMap((item: any) => item.content ?? [])
    .filter((part: any) => part?.type === 'output_text')
    .map((part: any) => part.text ?? '')
    .join('')
}

/** What the user typed, without the attachments that travelled with it. */
function userText(message: ChatMessage): string {
  return message.blocks
    .filter((item: any) => item?.role === 'user')
    .flatMap((item: any) => (Array.isArray(item.content) ? item.content : []))
    .filter((part: any) => part?.type === 'input_text' && !String(part.text ?? '').startsWith('Attached file — '))
    .map((part: any) => part.text ?? '')
    .join('\n')
}

/** Calls in the order the model made them, matched to what came of each. */
function toolsOf(message: ChatMessage): (ToolRecord & { id: string })[] {
  return message.blocks
    .filter((item: any) => item?.type === 'function_call')
    .map((item: any) => {
      const record = message.tools[item.call_id]
      return {
        id: item.call_id,
        name: record?.name ?? item.name,
        label: record?.label ?? item.name,
        status: record?.status ?? 'done',
        detail: record?.detail ?? ''
      }
    })
}

/* ------------------------------------------------------------------------ parts */

const STATUS_ICON = {
  running: 'refresh',
  asking: 'alert',
  done: 'check',
  declined: 'close',
  error: 'alert'
} as const

/**
 * One line saying what the assistant did. Reads are quiet grey — you can see it
 * looked, and you do not have to care. A write that happened is stated plainly,
 * because that one is a change to your data and it should be legible after the fact.
 */
function ToolLine({ tool }: { tool: LiveTool | (ToolRecord & { id: string }) }): React.JSX.Element {
  const status = tool.status
  const tone =
    status === 'error'
      ? 'text-error'
      : status === 'declined'
        ? 'text-base-content/35 line-through decoration-base-content/25'
        : 'text-base-content/45'
  return (
    <div className={`flex items-start gap-1.5 py-[3px] text-[11.5px] leading-relaxed ${tone}`}>
      <Icon
        name={STATUS_ICON[status]}
        size={11}
        className={`mt-[3px] shrink-0 ${status === 'running' ? 'animate-spin' : ''}`}
      />
      <span className="min-w-0">
        {tool.label}
        {tool.detail && <span className="text-error"> — {tool.detail}</span>}
      </span>
    </div>
  )
}

/**
 * The confirmation. Every write stops here, and the sentence it shows is written for
 * someone who has not read the arguments — names resolved, dates spelled out —
 * because a confirmation you cannot check is one you learn to click through.
 */
function ApprovalCard({ tool }: { tool: LiveTool }): React.JSX.Element {
  const { respond } = useAssistant()
  return (
    <div className="rise hairline my-2 rounded-box border border-primary/30 bg-primary/[0.045] p-3">
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-primary">
        <Icon name="alert" size={12} />
        Wants to change something
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-base-content/85">{tool.label}</p>
      <div className="mt-3 flex gap-2">
        <button className="btn btn-primary btn-xs" onClick={() => respond(tool.id, true)}>
          Do it
        </button>
        <button className="btn btn-ghost btn-xs" onClick={() => respond(tool.id, false)}>
          Don’t
        </button>
      </div>
    </div>
  )
}

function AttachmentChips({ names }: { names: string[] }): React.JSX.Element | null {
  if (names.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-wrap justify-end gap-1">
      {names.map((name, i) => (
        <span
          key={i}
          className="flex max-w-full items-center gap-1 rounded-field bg-primary-content/20 px-1.5 py-0.5 text-[10.5px] text-primary-content/85"
        >
          <Icon name="note" size={10} />
          <span className="truncate">{name}</span>
        </span>
      ))}
    </div>
  )
}

function UserBubble({ text, files }: { text: string; files: string[] }): React.JSX.Element {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-box rounded-br-sm bg-primary px-3 py-2 text-[13.5px] leading-relaxed text-primary-content">
        {text && <div className="whitespace-pre-wrap break-words">{text}</div>}
        <AttachmentChips names={files} />
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- conversations */

function ConversationMenu(): React.JSX.Element {
  const workspace = useWorkspace()
  const { conversationId, openConversation, running } = useAssistant()
  const conversations = useApi('chat:list', { workspaceId: workspace.id })
  const openMenu = useContextMenu()
  const list = conversations.data ?? []
  const current = list.find((c) => c.id === conversationId)

  return (
    <button
      className="flex min-w-0 items-center gap-1 rounded-field px-1.5 py-1 text-[12.5px] font-medium text-base-content/70 transition hover:bg-base-content/5 disabled:opacity-40"
      disabled={running}
      title="Your conversations"
      onClick={(e) =>
        // The app has one menu system and this is it — position, edge-flipping and
        // dismissal are its job, so the call site only says what is in the list.
        openMenu(
          e,
          list.length === 0
            ? [{ label: 'No conversations yet', disabled: true, onSelect: () => {} }]
            : list.slice(0, 30).map((c) => ({
                label: c.title || 'Untitled',
                icon: c.id === conversationId ? ('check' as const) : ('note' as const),
                onSelect: () => openConversation(c.id)
              }))
        )
      }
    >
      <span className="truncate">{current?.title || 'New conversation'}</span>
      <Icon name="chevronDown" size={12} className="shrink-0 opacity-50" />
    </button>
  )
}

/* ---------------------------------------------------------------------- composer */

function Composer({ projectId }: { projectId?: string }): React.JSX.Element {
  const { send, running, cancel } = useAssistant()
  const [text, setText] = useState('')
  const [files, setFiles] = useState<AttachmentUpload[]>([])
  const [dragging, setDragging] = useState(false)
  const [reading, setReading] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    // Grows with what you are writing, up to about eight lines, then scrolls.
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [text])

  const take = useCallback(async (list: FileList | File[]): Promise<void> => {
    setReading(true)
    try {
      const read = await Promise.all(Array.from(list).map(readFileForUpload))
      setFiles((current) => [...current, ...read])
    } finally {
      setReading(false)
    }
  }, [])

  const submit = useCallback((): void => {
    if (running || reading) return
    if (!text.trim() && files.length === 0) return
    void send({ text: text.trim(), files, projectId })
    setText('')
    setFiles([])
  }, [files, projectId, reading, running, send, text])

  return (
    <div
      className={`hairline shrink-0 border-t p-3 transition ${dragging ? 'bg-primary/5' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (e.dataTransfer.files.length) void take(e.dataTransfer.files)
      }}
    >
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {files.map((file, i) => (
            <span
              key={i}
              className="hairline flex max-w-full items-center gap-1 rounded-field border bg-base-200/60 py-0.5 pl-1.5 pr-1 text-[11px]"
            >
              <Icon name="note" size={10} className="opacity-50" />
              <span className="truncate">{file.name}</span>
              <button
                className="rounded p-0.5 opacity-40 transition hover:opacity-100"
                onClick={() => setFiles((list) => list.filter((_, x) => x !== i))}
                aria-label={`Remove ${file.name}`}
              >
                <Icon name="close" size={9} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="hairline flex items-end gap-1 rounded-box border bg-base-100 p-1.5 focus-within:border-primary/40">
        <label
          className="cursor-pointer rounded-field p-1.5 text-base-content/40 transition hover:bg-base-content/5 hover:text-base-content/70"
          title="Attach a file"
        >
          <Icon name="paperclip" size={15} />
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void take(e.target.files)
              e.target.value = ''
            }}
          />
        </label>

        <textarea
          ref={box}
          rows={1}
          value={text}
          placeholder={dragging ? 'Drop the file here' : 'Ask about this workspace…'}
          className="max-h-[180px] flex-1 resize-none bg-transparent py-1.5 text-[13.5px] leading-relaxed outline-none placeholder:text-base-content/35"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift-Enter is a new line, as everywhere else that chats.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />

        {running ? (
          <button
            className="btn btn-ghost btn-sm btn-circle text-base-content/50"
            onClick={cancel}
            title="Stop"
          >
            <Icon name="stop" size={13} />
          </button>
        ) : (
          <button
            className="btn btn-primary btn-sm btn-circle"
            onClick={submit}
            disabled={reading || (!text.trim() && files.length === 0)}
            title="Send"
          >
            <Icon name="arrowUp" size={14} />
          </button>
        )}
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------------- panel */

function Transcript({ projectId }: { projectId?: string }): React.JSX.Element {
  const { conversationId, streaming, tools, pending, settled, running, error, dismissError } = useAssistant()
  const conversation = useApi('chat:get', { id: conversationId ?? '' }, { enabled: Boolean(conversationId) })
  const bottom = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  // Following the answer down is right until you scroll up to read something, at
  // which point yanking you back to the bottom every few tokens is intolerable.
  const stuck = useRef(true)

  const messages = conversation.data?.messages ?? []

  useEffect(() => {
    if (pending?.id && messages.some((m) => m.id === pending.id)) settled(pending.id)
  }, [messages, pending, settled])

  useEffect(() => {
    if (stuck.current) bottom.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, streaming, tools, pending])

  const asking = tools.find((t) => t.status === 'asking')
  const shown = useMemo(() => tools.filter((t) => t.status !== 'asking'), [tools])

  const empty = messages.length === 0 && !pending && !running

  return (
    <div
      ref={scroller}
      className="scroll-area min-h-0 flex-1 px-4 py-4"
      onScroll={(e) => {
        const el = e.currentTarget
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      }}
    >
      {empty ? (
        <div className="pt-10">
          <EmptyState
            icon="sparkle"
            title="Ask about this workspace"
            hint="It can read your board, your people, your notes, meetings and decisions — and change them, once you have said yes."
          />
          <div className="mt-4 space-y-1.5">
            {[
              'What needs me this week?',
              'Where were we on the migration?',
              'Who should I chase, and about what?'
            ].map((suggestion) => (
              <Suggestion key={suggestion} text={suggestion} projectId={projectId} />
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {messages.map((message) => {
            if (message.role === 'user') {
              const text = userText(message)
              const files = message.attachments.map((a) => a.name)
              // A turn carrying only function output is bookkeeping, not something said.
              if (!text && files.length === 0) return null
              return <UserBubble key={message.id} text={text} files={files} />
            }
            const text = assistantText(message)
            const used = toolsOf(message)
            return (
              <div key={message.id}>
                {used.length > 0 && (
                  <div className="mb-1.5">
                    {used.map((tool) => (
                      <ToolLine key={tool.id} tool={tool} />
                    ))}
                  </div>
                )}
                {text && <Markdown source={text} />}
              </div>
            )
          })}

          {pending && <UserBubble text={pending.text} files={pending.files} />}

          {(shown.length > 0 || streaming || asking) && (
            <div>
              {shown.length > 0 && (
                <div className="mb-1.5">
                  {shown.map((tool) => (
                    <ToolLine key={tool.id} tool={tool} />
                  ))}
                </div>
              )}
              {asking && <ApprovalCard tool={asking} />}
              {streaming && <Markdown source={streaming} />}
            </div>
          )}

          {running && !streaming && !asking && shown.length === 0 && (
            <div className="flex items-center gap-2 text-[12px] text-base-content/40">
              <span className="size-1.5 animate-pulse rounded-full bg-primary" />
              Thinking…
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="hairline mt-4 flex items-start gap-2 rounded-box border border-error/30 bg-error/5 p-3 text-[12px] leading-relaxed text-error">
          <Icon name="alert" size={13} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button className="shrink-0 opacity-60 hover:opacity-100" onClick={dismissError} aria-label="Dismiss">
            <Icon name="close" size={11} />
          </button>
        </div>
      )}

      <div ref={bottom} />
    </div>
  )
}

function Suggestion({ text, projectId }: { text: string; projectId?: string }): React.JSX.Element {
  const { send } = useAssistant()
  return (
    <button
      className="hairline w-full rounded-field border border-dashed px-3 py-2 text-left text-[12.5px] text-base-content/60 transition hover:border-solid hover:bg-base-200/60 hover:text-base-content"
      onClick={() => void send({ text, projectId })}
    >
      {text}
    </button>
  )
}

export function AssistantPanel(): React.JSX.Element {
  const workspace = useWorkspace()
  const { open, setOpen, openConversation, conversationId, running } = useAssistant()
  const inProject = useMatch('/projects/:id/*')
  const projectId = inProject?.params.id
  const reduceMotion = useReducedMotion() ?? false
  const openMenu = useContextMenu()
  const { width, dragging, ref, onGrab, onReset } = useResizablePanel<HTMLElement>('assistant')

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.aside
          ref={ref}
          className="glass-chrome hairline relative flex shrink-0 flex-col overflow-hidden border-l bg-base-100"
          initial={{ width: reduceMotion ? width : 0 }}
          // While dragging the width *is* the pointer, so animating towards it would
          // only ever lag behind the hand moving it.
          animate={{ width, transition: dragging ? { duration: 0 } : ENTER }}
          exit={{ width: reduceMotion ? width : 0, transition: EXIT }}
        >
          <PanelResizeHandle
            side="right"
            dragging={dragging}
            onGrab={onGrab}
            onReset={onReset}
            label="Resize the assistant"
          />

          {/* Fixed inner width so nothing reflows while the panel is opening. */}
          <div className="flex h-full flex-col" style={{ width }}>
            <header className="drag-region hairline flex h-[52px] shrink-0 items-center gap-1 border-b pl-3 pr-2">
              <Icon name="sparkle" size={15} className="shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <ConversationMenu />
              </div>

              <button
                className="btn btn-ghost btn-xs btn-circle"
                title="New conversation"
                disabled={running}
                onClick={() => openConversation(null)}
              >
                <Icon name="plus" size={14} />
              </button>

              <button
                className="btn btn-ghost btn-xs btn-circle"
                title="More"
                disabled={!conversationId || running}
                onClick={(e) =>
                  openMenu(e, [
                    {
                      label: 'Delete conversation',
                      icon: 'trash',
                      danger: true,
                      confirm: {
                        title: 'Delete this conversation?',
                        body: 'The whole thing goes, along with anything you attached to it.'
                      },
                      onSelect: () => {
                        void call('chat:delete', { id: conversationId! }).then(() => openConversation(null))
                      }
                    }
                  ])
                }
              >
                <Icon name="more" size={14} />
              </button>

              <button className="btn btn-ghost btn-xs btn-circle" title="Close" onClick={() => setOpen(false)}>
                <Icon name="close" size={14} />
              </button>
            </header>

            {workspace.aiKeySet ? (
              <>
                <Transcript projectId={projectId} />
                <Composer projectId={projectId} />
              </>
            ) : (
              <NoKey />
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

/** Nothing works without a key, so say so once, plainly, with the way to fix it. */
function NoKey(): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center px-6 pb-10">
      <EmptyState
        icon="sparkle"
        title="Add an API key to use the assistant"
        hint="The assistant runs on your own OpenAI key, and the key stays on this machine. Each workspace has its own, so the one you use for a client is never the one you use at work."
        action={
          <a className="btn btn-primary btn-sm" href="#/workspace?pane=assistant">
            Add a key
          </a>
        }
      />
    </div>
  )
}
