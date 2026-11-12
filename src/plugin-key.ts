// Which qualified plugin key (`publisher.id`) this plugin has on the Orca host. The worker is not
// told its own key, and `orca plugin open` needs it: a catalog install is `plozmun.redmine-tasks`,
// while a development folder loads as `local.redmine-tasks`.

export const PLUGIN_ID = 'redmine-tasks'

/** A row of `orca plugin list --json` (`result.plugins`), as much as this plugin reads. */
export interface ListedPlugin {
  pluginKey: string
  /** `running`, `idle`, `disabled`, `pending` (waiting for approval)… */
  status?: string
  /** The status bar items the loaded version declares. */
  statusBarItems?: readonly { id: string }[]
}

/** Statuses of a plugin the person cannot use yet. */
const UNAVAILABLE = new Set(['disabled', 'pending'])

/** The id part of a qualified plugin key (`acme.dusk` → `dusk`). */
export function pluginIdOf(pluginKey: string): string {
  return pluginKey.slice(pluginKey.lastIndexOf('.') + 1)
}

/**
 * This plugin's key among the listed rows: those whose id is `redmine-tasks`, the ones the person
 * can use first, and among them the one whose version declares the status bar item `itemId` (so a
 * development folder next to an older install opens the panel being worked on). Null when the
 * listing has none.
 */
export function pickPluginKey(rows: readonly ListedPlugin[], itemId: string): string | null {
  const mine = rows.filter((row) => pluginIdOf(row.pluginKey) === PLUGIN_ID)
  const usable = mine.filter((row) => !UNAVAILABLE.has(row.status ?? ''))
  const pool = usable.length > 0 ? usable : mine
  const declaring = pool.filter((row) => (row.statusBarItems ?? []).some((item) => item.id === itemId))
  return (declaring[0] ?? pool[0])?.pluginKey ?? null
}
