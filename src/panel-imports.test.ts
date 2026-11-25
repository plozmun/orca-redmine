// The panel runs without Node globals. Any module it imports must not touch `process` (or other
// Node-only globals) while loading, or the whole panel fails with "process is not defined".
import { assert, test } from 'orca/testing'

test('modules the panel imports do not use Node globals at load time', async () => {
  const { readFile } = await import('node:fs/promises')
  const { dirname, join, normalize } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const dir = dirname(fileURLToPath(import.meta.url))

  const seen = new Set<string>()
  const queue = ['panel.tsx']
  const offenders: string[] = []
  while (queue.length) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    let source: string
    try {
      source = await readFile(join(dir, file), 'utf8')
    } catch {
      // `./i18n` is a folder: its module is i18n/index.ts.
      queue.unshift(join(file.replace(/\.ts$/, ''), 'index.ts'))
      continue
    }
    // Value imports only: `import type` is erased and never runs.
    for (const m of source.matchAll(/^import\s+(?!type\s)[^;]*?from\s+'\.\/([^']+)'/gms)) {
      const name = m[1]
      const path = normalize(join(dirname(file), name))
      queue.push(/\.tsx?$/.test(path) ? path : `${path}.ts`)
    }
    if (file === 'panel.tsx') continue
    // Top-level statements start at column 0; code inside functions is indented.
    source.split('\n').forEach((line, i) => {
      if (/^\S.*\b(process|Buffer|__dirname|require)\b[.(]/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line))
        offenders.push(`${file}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [])
})
