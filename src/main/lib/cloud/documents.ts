import type { Draft } from '@shared/api'
import type { Canvas, ChatMessage, JSONCanvas, ProjectDetail, TeamCanvas, TeamChart, ToolRecord } from '@shared/types'
import type { components } from './schema'

type Schemas = components['schemas']

/**
 * The documents Neo Cloud keeps without reading them.
 *
 * Everything else a handler returns is checked against the contract field by field. A
 * canvas's board (the open JSON Canvas format), a project's team chart and the record of what the assistant's
 * tools did are stored as they arrive and handed back unchanged, so the spec honestly
 * calls them open objects. Their shape is this app's to know, and it is asserted here,
 * once, for that one field — never with a cast over the whole response, which would stop
 * the contract checking the rest of it.
 */

export const canvasOf = (canvas: Schemas['Canvas']): Canvas => ({
  ...canvas,
  data: canvas.data as unknown as JSONCanvas
})

export const messageOf = (message: Schemas['ChatMessage']): ChatMessage => ({
  ...message,
  tools: message.tools as Record<string, ToolRecord>
})

export const detailOf = (detail: Schemas['ProjectDetail']): ProjectDetail => ({
  ...detail,
  canvases: detail.canvases.map(canvasOf)
})

/** And the other way: a board on its way in is an open object as far as the contract goes. */
export const canvasDraftOf = ({ id: _id, data, ...rest }: Draft<Canvas>): Schemas['CanvasDraft'] => ({
  ...rest,
  ...(data !== undefined ? { data: data as unknown as Record<string, unknown> } : {})
})

/**
 * A team chart. A project whose team has never been drawn comes back as `{}`, which is
 * an empty drawing rather than a malformed one.
 */
export const teamCanvasOf = (team: Schemas['TeamCanvas']): TeamCanvas => {
  const data = team.data as Partial<TeamChart>
  return {
    ...team,
    data: { version: 1, nodes: Array.isArray(data.nodes) ? data.nodes : [] }
  }
}
