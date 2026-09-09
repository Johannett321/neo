import { useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Note } from '@shared/types'
import { call } from './api'
import { wikiTargets } from './markdown'

/**
 * Links between the notes of one project, and pictures put into them: the two
 * things the editor asks its page for, shared by the note page and the meeting page
 * so both answer the same way.
 *
 * A `[[link]]` names a note by its title, the way Obsidian's does, so the Markdown
 * on disk is the same Markdown. It resolves inside the project and nowhere else —
 * a note is filed under a project and a link that could reach across projects
 * would be the one screen in the app that mixes them.
 */
export function useNoteLinks(
  projectId: string,
  notes: Note[],
  /** The note being written, left out of its own targets and backlinks. */
  selfId: string | null,
  selfTitle: string
): {
  linkTargets: string[]
  openLink: (target: string) => void
  backlinks: Note[]
} {
  const navigate = useNavigate()
  const others = useMemo(() => notes.filter((n) => n.id !== selfId), [notes, selfId])

  const linkTargets = useMemo(
    () => others.map((n) => n.title.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b)),
    [others]
  )

  const openLink = useCallback(
    (target: string): void => {
      const want = target.trim().toLowerCase()
      const note = others.find((n) => n.title.trim().toLowerCase() === want)
      if (note) {
        navigate(`/projects/${projectId}/notes/${note.id}${note.folderId ? `?in=${note.folderId}` : ''}`)
      } else {
        // No note by that name yet: the link is a promise, and this is where it is kept.
        navigate(`/projects/${projectId}/notes/new?title=${encodeURIComponent(target.trim())}`)
      }
    },
    [navigate, others, projectId]
  )

  const backlinks = useMemo(() => {
    const want = selfTitle.trim().toLowerCase()
    if (!want) return []
    return others.filter((n) => wikiTargets(n.body).some((t) => t.toLowerCase() === want))
  }, [others, selfTitle])

  return { linkTargets, openLink, backlinks }
}

/** What the editor does with a picture: hands the bytes to main, gets a URL back. */
export function useImageDrop(projectId: string): (file: File) => Promise<{ url: string; alt: string } | null> {
  return useCallback(
    async (file: File) => {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      const image = await call('noteImage:save', { projectId, file: { name: file.name, mime: file.type, data } })
      return { url: image.url, alt: file.name.replace(/\.[a-z0-9]+$/i, '') }
    },
    [projectId]
  )
}
