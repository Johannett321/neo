import { DEFAULT_RECAP_PROMPT, speakerLabel } from '@shared/recording'
import type { Recap, RecapCommitment } from '@shared/types'
import { EMPTY_RECAP } from '@shared/types'
import type { EngineConfig } from './engine'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Turning a transcript into something worth reading.
 *
 * Two passes, and they are separate on purpose. The first works out who is speaking,
 * because a wall of undifferentiated text hides exactly the thing a recap is looking
 * for — one person committing to something in answer to another. The second reads
 * the attributed transcript and pulls out what was decided, what was promised and
 * what changed the picture.
 *
 * The *instructions* for the second pass are the workspace's, and editable. The
 * *shape* of its answer is not: the screen reads decisions and commitments as data
 * so it can put one on the board in a click, and a prompt that could change the
 * shape would be a prompt that could break the screen. So the two are concatenated,
 * yours first, and the schema always has the last word.
 */

const MODEL_JSON_HINT = 'Reply with a single JSON object and nothing else.'

/** Local models like to wrap JSON in prose or a fence. Take the object out of it. */
export function parseJsonObject(raw: string): any {
  const text = raw.trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced?.[1] ?? text).trim()
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end <= start) throw new Error('The model did not answer with JSON.')
    return JSON.parse(candidate.slice(start, end + 1))
  }
}

async function ask(config: EngineConfig, system: string, user: string): Promise<string> {
  // Chat completions rather than the Responses API: it is the one every
  // OpenAI-compatible server implements, and the local half of this feature depends
  // on there being exactly one code path.
  const response = await config.client.chat.completions.create({
    model: config.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    response_format: { type: 'json_object' }
  } as any)
  return String((response as any)?.choices?.[0]?.message?.content ?? '')
}

/* ------------------------------------------------------------------ speakers */

export interface SpeakerLine {
  ord: number
  startMs: number
  text: string
}

/**
 * Who said which line.
 *
 * This is attribution, not diarisation. Telling voices apart needs the audio and a
 * model trained on it, and there is not one of those on a stock Mac — so what
 * happens instead is that a language model reads the transcript and works out where
 * the turns change from the shape of the conversation: questions and their answers,
 * names used in address, a topic handed over. It is good at the handovers and
 * unreliable in the middle of a monologue, and the screen says so rather than
 * presenting a guess as a measurement.
 *
 * The names of the people in the room are handed over as candidates, because a
 * transcript in which somebody says "thanks, Ida" identifies Ida, and "Speaker 2"
 * is only ever the answer when nothing in the words gives a better one.
 */
export async function attributeSpeakers(
  config: EngineConfig,
  lines: SpeakerLine[],
  attendees: string[],
  /** The labels already settled on earlier in the same transcript, for continuity. */
  known: string[]
): Promise<Record<number, string>> {
  if (lines.length === 0) return {}

  const system = [
    'You label the lines of a meeting transcript with who is speaking.',
    '',
    'Rules:',
    '- Consecutive lines are usually the same person. Only change speaker where the transcript actually indicates a turn: a question answered, a name used to address someone, a clear handover, a change of stance.',
    `- Label people "${speakerLabel(0)}", "${speakerLabel(1)}" and so on, numbering in the order they first speak.`,
    attendees.length
      ? `- The people in the room were: ${attendees.join(', ')}. Where the transcript makes it genuinely clear which of them is speaking — they are addressed by name, or they name themselves — use that name instead of a "Speaker N" label. If you are not sure, use the label. Never guess a name.`
      : '',
    known.length
      ? `- Labels already used earlier in this same transcript, which you must stay consistent with: ${known.join(', ')}.`
      : '',
    '',
    'Input is a JSON array of { "i": line number, "t": text }.',
    `Answer with { "speakers": [ { "i": line number, "s": "label or name" } ] } covering every line you were given. ${MODEL_JSON_HINT}`
  ]
    .filter(Boolean)
    .join('\n')

  const user = JSON.stringify(lines.map((l) => ({ i: l.ord, t: l.text })))
  const parsed = parseJsonObject(await ask(config, system, user))

  const out: Record<number, string> = {}
  for (const entry of (parsed?.speakers ?? []) as any[]) {
    const index = Number(entry?.i)
    const speaker = String(entry?.s ?? '').trim()
    if (Number.isFinite(index) && speaker) out[index] = speaker.slice(0, 60)
  }
  return out
}

/* -------------------------------------------------------------------- recap */

export interface RecapContext {
  meetingTitle: string
  occurredOn: string
  projectName: string
  attendees: string[]
  /** What the workspace asked for. Empty falls back to the default. */
  prompt: string
}

const contextLines = (context: RecapContext): string =>
  [
    `The meeting: ${context.meetingTitle || 'untitled'}, on ${context.occurredOn}, for the project "${context.projectName}".`,
    context.attendees.length ? `In the room: ${context.attendees.join(', ')}.` : '',
    'Speaker labels in the transcript may be wrong. Trust the words over the label, and do not attribute something to a named person unless the transcript makes it clear.'
  ]
    .filter(Boolean)
    .join('\n')

/**
 * A slice of a long transcript, reduced to notes.
 *
 * Only used when a meeting is too long to read in one pass. The notes stay prose
 * rather than becoming a half-finished recap, because a decision taken in the first
 * hour is often reversed in the second, and only the pass that reads all of it can
 * tell.
 */
export async function summarisePart(
  config: EngineConfig,
  context: RecapContext,
  transcript: string,
  part: number,
  parts: number
): Promise<string> {
  const system = [
    context.prompt || DEFAULT_RECAP_PROMPT,
    '',
    `You are reading part ${part} of ${parts} of a long meeting, so this is a working note rather than the final write-up — another pass will read all of your notes together and produce that.`,
    contextLines(context),
    '',
    'Note everything from this part that could matter to the final write-up: what was decided, what anyone took on, and anything that changes the picture. Leave out small talk entirely. Keep the speaker attached to each point. Do not conclude anything about the meeting as a whole — you have only seen part of it.',
    '',
    `Answer with { "notes": "your notes as Markdown bullet points" }. ${MODEL_JSON_HINT}`
  ].join('\n')

  const parsed = parseJsonObject(await ask(config, system, transcript))
  return String(parsed?.notes ?? '').trim()
}

/**
 * The write-up itself. Reads either the whole transcript or the notes above, and
 * answers in the one shape the screen knows how to draw.
 */
export async function writeRecap(
  config: EngineConfig,
  context: RecapContext,
  body: string,
  fromNotes: boolean
): Promise<{ title: string; summary: string; recap: Recap }> {
  const system = [
    context.prompt || DEFAULT_RECAP_PROMPT,
    '',
    contextLines(context),
    fromNotes
      ? 'What follows is a set of notes taken over the parts of a long meeting, in order. Read all of them before answering: something settled early may have been reopened later, and the later word wins.'
      : 'What follows is the transcript of the meeting.',
    '',
    'Answer with exactly this shape:',
    '{',
    '  "title": "what this meeting should be called, in three to six words. A name, not a sentence: no full stop, no date, no \'meeting\' at the end of it.",',
    '  "summary": "one or two sentences of Markdown saying what this meeting was and what came out of it. No heading, no bullet list.",',
    '  "decisions": [ { "what": "what was settled, in one sentence", "who": "who settled it, or an empty string" } ],',
    '  "commitments": [ { "who": "the person it belongs to, or an empty string if the transcript does not say", "what": "the thing that has to be done", "due": "YYYY-MM-DD, or an empty string if no date was said" } ],',
    '  "insights": [ "one sentence each" ]',
    '}',
    '',
    'Every list may be empty, and an empty list is the right answer when nothing of that kind happened — but a meeting that lists things to be done has commitments, even if nobody used the word. Never invent a date, a name, or a decision. ' + MODEL_JSON_HINT
  ].join('\n')

  const parsed = parseJsonObject(await ask(config, system, body))

  const text = (value: unknown): string => String(value ?? '').trim()
  const list = (value: unknown): any[] => (Array.isArray(value) ? value : [])

  const recap: Recap = {
    ...EMPTY_RECAP,
    decisions: list(parsed?.decisions)
      .map((d: any) => ({ what: text(d?.what ?? d), who: text(d?.who) }))
      .filter((d) => d.what),
    commitments: list(parsed?.commitments)
      .map((c: any) => ({
        who: text(c?.who),
        what: text(c?.what ?? c),
        // A date the model made up is worse than no date, so anything that is not a
        // plain calendar day is dropped rather than guessed at.
        due: /^\d{4}-\d{2}-\d{2}$/.test(text(c?.due)) ? text(c?.due) : ''
      }))
      .filter((c) => c.what),
    insights: list(parsed?.insights)
      .map((i: any) => text(typeof i === 'string' ? i : i?.text))
      .filter(Boolean)
  }

  return {
    // A title is a field on a form, not prose: anything long enough to be a sentence
    // is the model having answered the wrong question, and is better dropped.
    title: text(parsed?.title).replace(/[.\s]+$/, '').slice(0, 90),
    summary: text(parsed?.summary),
    recap
  }
}

/**
 * A commitment as one line of a to-do list.
 *
 * Here rather than at the two places that need it, so the item the pipeline creates
 * and the item the recap displays are the same string — which is also what lets the
 * one be recognised as already being the other.
 */
export const commitmentLine = (c: RecapCommitment): string =>
  [c.who ? `${c.who}:` : '', c.what, c.due ? `(by ${c.due})` : ''].filter(Boolean).join(' ')

/**
 * A name for a meeting, from whatever the meeting has to go on.
 *
 * Its own call rather than a field on the recap, because it has to work for a
 * meeting that was never recorded — most of them — where the only content is what
 * somebody typed. It is asked for by pressing a button, so it answers with a name
 * and nothing else; what is done with that is the page's business.
 */
export async function suggestTitle(
  config: EngineConfig,
  context: { occurredOn: string; projectName: string; attendees: string[] },
  content: string
): Promise<string> {
  const system = [
    'You name meetings, from the notes taken in them.',
    '',
    `The meeting was on ${context.occurredOn}, for the project "${context.projectName}".`,
    context.attendees.length ? `In the room: ${context.attendees.join(', ')}.` : '',
    '',
    'Rules for the name:',
    '- Three to six words. It goes in a list beside thirty others, and it has to be the thing you scan for.',
    '- Say what the meeting was *about*, not what kind of meeting it was. "Pricing for the Nordic launch", never "Weekly sync" or "Project meeting".',
    '- No date — the list already shows one. No full stop. No quotation marks. Do not end it with the word "meeting".',
    '- Use the words the notes use. If the notes name a customer, a release or a number, that is usually the name.',
    '',
    `Answer with { "title": "the name" }. ${MODEL_JSON_HINT}`
  ]
    .filter(Boolean)
    .join('\n')

  const parsed = parseJsonObject(await ask(config, system, content))
  return String(parsed?.title ?? '')
    .trim()
    .replace(/^["'\u201c\u2018]|["'\u201d\u2019]$/g, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 90)
}

/**
 * The recap as Markdown, for the copy that goes into the meeting write-up and the
 * one in the folder of Markdown files. Deliberately the same function for both, so
 * what you read in Neo and what you read in a text editor cannot drift apart.
 */
export function recapMarkdown(summary: string, recap: Recap): string {
  const out: string[] = []
  if (summary) out.push(summary, '')
  if (recap.decisions.length) {
    out.push('### Decisions')
    for (const d of recap.decisions) out.push(`- ${d.what}${d.who ? ` — ${d.who}` : ''}`)
    out.push('')
  }
  if (recap.commitments.length) {
    out.push('### Commitments')
    for (const c of recap.commitments) {
      const who = c.who ? `**${c.who}**: ` : ''
      out.push(`- ${who}${c.what}${c.due ? ` (by ${c.due})` : ''}`)
    }
    out.push('')
  }
  if (recap.insights.length) {
    out.push('### Worth knowing')
    for (const i of recap.insights) out.push(`- ${i}`)
    out.push('')
  }
  return out.join('\n').trim()
}
