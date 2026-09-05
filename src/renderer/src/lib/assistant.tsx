import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AiEvent, AttachmentUpload } from '@shared/types'
import { call } from './api'

/**
 * The panel's state, held above the panel itself.
 *
 * It lives here rather than inside the component for one reason: a turn can take a
 * minute, and closing the panel — or walking to another screen — must not abandon it.
 * The run belongs to the session, not to whatever is currently on screen.
 *
 * What is streaming is kept apart from what is saved. The main process writes every
 * turn to the database as it completes, so the transcript is a query like any other;
 * this holds only the part that has not landed yet — the half-written sentence, the
 * tools running, the confirmation waiting for an answer — and drops all of it the
 * moment the run says it is done and the query refetches.
 */

/** A tool the assistant used, or is asking to. */
export interface LiveTool {
  id: string
  name: string
  label: string
  status: 'running' | 'done' | 'error' | 'asking' | 'declined'
  detail: string
}

interface AssistantState {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
  /** The conversation on screen. Null means a new, unsaved one. */
  conversationId: string | null
  openConversation: (id: string | null) => void
  /** True from send until the turn finishes. */
  running: boolean
  /** The answer as it is being written. */
  streaming: string
  /** Tools from the current turn, in the order they happened. */
  tools: LiveTool[]
  /**
   * The turn just sent, drawn immediately so pressing send feels like sending, and
   * dropped the moment the saved copy of that same turn arrives in the transcript.
   */
  pending: { id: string | null; text: string; files: string[] } | null
  /** Called by the transcript once it can see the saved turn. */
  settled: (messageId: string) => void
  error: string
  send: (input: { text: string; files?: AttachmentUpload[]; projectId?: string }) => Promise<void>
  respond: (toolUseId: string, approved: boolean) => void
  cancel: () => void
  dismissError: () => void
}

const AssistantContext = createContext<AssistantState | null>(null)

export function AssistantProvider({
  workspaceId,
  children
}: {
  workspaceId: string
  children: ReactNode
}): React.JSX.Element {
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [streaming, setStreaming] = useState('')
  const [tools, setTools] = useState<LiveTool[]>([])
  const [pending, setPending] = useState<{ id: string | null; text: string; files: string[] } | null>(null)
  const [error, setError] = useState('')

  /*
   * Events arrive on a channel with no memory of which React render subscribed, so
   * the run they belong to is read from a ref rather than from the closure — a
   * listener re-registered on every state change would drop events in the gap.
   */
  const activeRun = useRef<string | null>(null)
  activeRun.current = runId

  const reset = useCallback((): void => {
    setRunId(null)
    setStreaming('')
    setTools([])
    setPending(null)
  }, [])

  // A workspace is a hard boundary, so switching one closes whatever was open in it.
  useEffect(() => {
    setConversationId(null)
    setError('')
    reset()
  }, [workspaceId, reset])

  useEffect(() => {
    return window.api.onAi((event: AiEvent) => {
      if (activeRun.current && event.runId !== activeRun.current) return

      switch (event.type) {
        case 'text':
          setStreaming((text) => text + event.delta)
          break

        case 'tool':
          setTools((list) => {
            const next = [...list]
            const at = next.findIndex((t) => t.id === event.id)
            const entry: LiveTool = {
              id: event.id,
              name: event.name,
              label: event.label,
              status: event.status,
              detail: event.detail
            }
            if (at === -1) next.push(entry)
            else next[at] = entry
            return next
          })
          break

        case 'approval':
          setTools((list) => [
            ...list.filter((t) => t.id !== event.id),
            { id: event.id, name: event.name, label: event.label, status: 'asking', detail: event.detail }
          ])
          break

        case 'title':
          setConversationId((current) => current ?? event.conversationId)
          void client.invalidateQueries({ queryKey: ['chat:list'] })
          break

        case 'error':
          setError(event.message)
          break

        case 'done':
          reset()
          // The turn is on disk now, so the transcript is refetched and the live
          // copy thrown away — there is never a moment showing both.
          void client.invalidateQueries()
          break
      }
    })
  }, [client, reset])

  const send = useCallback(
    async (input: { text: string; files?: AttachmentUpload[]; projectId?: string }): Promise<void> => {
      setError('')
      setStreaming('')
      setTools([])
      setPending({ id: null, text: input.text, files: (input.files ?? []).map((f) => f.name) })
      try {
        const started = await call('chat:send', {
          workspaceId,
          conversationId: conversationId ?? undefined,
          text: input.text,
          files: input.files,
          projectId: input.projectId
        })
        setRunId(started.runId)
        setConversationId(started.conversationId)
        setPending((current) => (current ? { ...current, id: started.messageId } : current))
        void client.invalidateQueries({ queryKey: ['chat:list'] })
        void client.invalidateQueries({ queryKey: ['chat:get'] })
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setPending(null)
      }
    },
    [client, conversationId, workspaceId]
  )

  const respond = useCallback(
    (toolUseId: string, approved: boolean): void => {
      if (!activeRun.current) return
      // Marked answered straight away: waiting for the round trip would leave the
      // buttons live long enough to press twice.
      setTools((list) =>
        list.map((t) =>
          t.id === toolUseId ? { ...t, status: approved ? 'running' : 'declined' } : t
        )
      )
      void call('chat:respond', { runId: activeRun.current, toolUseId, approved })
    },
    []
  )

  const cancel = useCallback((): void => {
    if (!activeRun.current) return
    void call('chat:cancel', { runId: activeRun.current })
    reset()
    void client.invalidateQueries()
  }, [client, reset])

  const openConversation = useCallback(
    (id: string | null): void => {
      if (activeRun.current) return
      setConversationId(id)
      setError('')
      reset()
    },
    [reset]
  )

  const value = useMemo<AssistantState>(
    () => ({
      open,
      setOpen,
      toggle: () => setOpen((v) => !v),
      conversationId,
      openConversation,
      running: runId !== null,
      streaming,
      tools,
      pending,
      settled: (messageId: string) =>
        setPending((current) => (current && current.id === messageId ? null : current)),
      error,
      send,
      respond,
      cancel,
      dismissError: () => setError('')
    }),
    [open, conversationId, openConversation, runId, streaming, tools, pending, error, send, respond, cancel]
  )

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>
}

export function useAssistant(): AssistantState {
  const value = useContext(AssistantContext)
  if (!value) throw new Error('useAssistant used outside AssistantProvider')
  return value
}

/** Read a dropped or chosen file into what the bridge can carry. */
export function readFileForUpload(file: File): Promise<AttachmentUpload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
    reader.onload = () => {
      const result = String(reader.result)
      resolve({
        name: file.name,
        // Finder hands over an empty type for plenty of text files; main works the
        // rest out from the extension.
        mime: file.type || 'application/octet-stream',
        data: result.slice(result.indexOf(',') + 1)
      })
    }
    reader.readAsDataURL(file)
  })
}
