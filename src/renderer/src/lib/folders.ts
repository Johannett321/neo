/**
 * Reading a flat list of folders, whichever list it files.
 *
 * Main sends every folder in one call, depth-first, each already carrying its path and
 * its depth — there are tens of these, not thousands, and one statement that knows the
 * whole shape beats a page that asks for a level at a time. A page only ever draws
 * *one* level of it, the way a file browser does, so what it needs from the list is
 * small: what is inside this folder, and how to get back out.
 *
 * Everything here is structural rather than typed to one kind of folder. The projects
 * page files project cards into `ProjectFolder`s; the notes and meetings lists inside a
 * project file writing into `ContentFolder`s. The shapes differ in what they count and
 * nothing else, so the walking is written once.
 */

/** The least a folder has to be for any of this to work. */
export interface Nested {
  id: string
  parentId: string | null
}

/**
 * What is currently being dragged, on any page that files things.
 *
 * `item` is whatever that page files — a project card on the projects page, a note or
 * a meeting inside a project — and `folder` is a folder being moved into another one.
 * The distinction earns its place because only one of the two can land on itself: a
 * folder is never a target for its own branch.
 */
export interface Dragged {
  kind: 'item' | 'folder'
  id: string
}

/** The folders sitting directly inside `parentId` — null for the top level. */
export function childrenOf<T extends Nested>(folders: T[], parentId: string | null): T[] {
  return folders.filter((f) => (f.parentId ?? null) === parentId)
}

/**
 * The trail from the top level down to this folder, this folder last. Empty at the
 * top level, which is exactly when no breadcrumbs are drawn.
 */
export function crumbsOf<T extends Nested>(folders: T[], id: string | null): T[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const trail: T[] = []
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
export function branchIds(folders: Nested[], id: string): Set<string> {
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
