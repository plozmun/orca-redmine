// What the worker gives an agent besides the prompt: a file with the task context (a terminal line
// cannot carry it) and whether the `redmine` CLI (redmine-cli) is installed, so the agent can update
// the task itself. Reading the task never needs the CLI.

const REDMINE_CLI_CANDIDATES = [process.env.REDMINE_CLI, 'redmine', '/opt/homebrew/bin/redmine', '/usr/local/bin/redmine'].filter(
  (c): c is string => Boolean(c)
)

let detected: { at: number; version: Promise<string | null> } | null = null

/** `redmine --version` output (e.g. "redmine version 2.14.0"), or null when it is not installed. Cached for 60 s. */
export function detectRedmineCli(): Promise<string | null> {
  if (detected && Date.now() - detected.at < 60_000) return detected.version
  const version = (async () => {
    const { execFile } = await import('node:child_process')
    for (const cli of REDMINE_CLI_CANDIDATES) {
      const found = await new Promise<string | null>((resolve) => {
        execFile(cli, ['--version'], { timeout: 5_000 }, (err, out) => resolve(err ? null : String(out).trim() || cli))
      })
      if (found) return found
    }
    return null
  })()
  detected = { at: Date.now(), version }
  return version
}

/**
 * Writes the task context to `<tmp>/orca-redmine/<id>.md`, readable only by the user, and returns
 * its path. Outside the repository, so it never shows up in the worktree.
 */
export async function writeContextFile(id: number, content: string, dir?: string): Promise<string> {
  const { mkdir, writeFile, chmod } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const folder = dir ?? join(tmpdir(), 'orca-redmine')
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const file = join(folder, `${id}.md`)
  await writeFile(file, `${content}\n`, { mode: 0o600 })
  await chmod(file, 0o600) // `mode` only applies when the file is created.
  return file
}
