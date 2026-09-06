import type { ProjectFolderView } from '@shared/types'

/**
 * Reading the flat list `folder:list` returns.
 *
 * Main sends every folder in the workspace, depth-first, each already carrying its
 * path and its depth — there are tens of these, not thousands, and one statement that
 * knows the whole shape beats a page that asks for a level at a time. The projects
 * page only ever draws *one* level of it, the way a file browser does, so what it
 * needs from the list is small: what is inside this folder, and how to get back out.
 */

/** The folders sitting directly inside `parentId` — null for the top level. */
export function childrenOf(
  folders: ProjectFolderView[],
  parentId: string | null
): ProjectFolderView[] {
  return folders.filter((f) => (f.parentId ?? null) === parentId)
}

/**
 * The trail from the top level down to this folder, this folder last. Empty at the
 * top level, which is exactly when no breadcrumbs are drawn.
 */
export function crumbsOf(folders: ProjectFolderView[], id: string | null): ProjectFolderView[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const trail: ProjectFolderView[] = []
  let current = id ? byId.get(id) : undefined
  // Bounded by the list itself: every step goes to a parent, and a folder cannot be
  // its own ancestor — but a database that has been through a repair is allowed to be
  // wrong, and a page that hangs is worse than a trail that stops short.
  while (current && trail.length <= folders.length) {
    trail.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return trail
}

/**
 * A folder and everything filed under it. What a move has to exclude: dropping a
 * folder into its own child would cut the branch off the tree.
 */
export function branchIds(folders: ProjectFolderView[], id: string): Set<string> {
  const branch = new Set([id])
  // The list is depth-first, so a folder always arrives after its parent and one
  // pass is enough.
  for (const folder of folders) {
    if (folder.parentId && branch.has(folder.parentId)) branch.add(folder.id)
  }
  return branch
}

/**
 * The folder you were last standing in, per workspace.
 *
 * Opening a project and coming back should land you where you left, the way closing a
 * window and reopening it does — walking back up from the root every time is the kind
 * of small tax that stops people filing anything at all. It is written only when you
 * actually navigate, so leaving the page at the top level is remembered as the top
 * level rather than as nothing.
 *
 * Deliberately in memory and not in settings: it is where you were a minute ago, not a
 * preference, and a fresh launch has no business insisting on a folder you were in last
 * Thursday. Keyed by workspace, because the boundary holds here too.
 */
const lastOpened = new Map<string, string | null>()

export const rememberFolder = (workspaceId: string, folderId: string | null): void => {
  lastOpened.set(workspaceId, folderId)
}

export const recallFolder = (workspaceId: string): string | null =>
  lastOpened.get(workspaceId) ?? null
