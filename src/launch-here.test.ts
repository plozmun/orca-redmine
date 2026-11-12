import { assert, test } from 'orca/testing'
import { contextFilePrompt, fitsLaunchPrompt, LAUNCH_PROMPT_MAX_CHARS } from './launch-here'

const issue = { id: 4077, subject: 'Checkout screen', url: 'https://redmine.test/issues/4077' }
const FILE = '/tmp/orca-redmine/4077.md'
const POINTER = `Read its description and comments in ${FILE} first.`

test('a prompt fits when it is at most 4096 characters, the cap of agent.launch', () => {
  assert.equal(LAUNCH_PROMPT_MAX_CHARS, 4096)
  assert.ok(fitsLaunchPrompt('x'.repeat(LAUNCH_PROMPT_MAX_CHARS)))
  assert.ok(!fitsLaunchPrompt('x'.repeat(LAUNCH_PROMPT_MAX_CHARS + 1)))
})

test('the context-file prompt keeps the instructions and points at the file', () => {
  assert.equal(contextFilePrompt(issue, 'Fix the checkout', 'en', { contextFile: FILE }), `Fix the checkout\n${POINTER}`)
  // Empty instructions fall back to the localized default.
  assert.equal(
    contextFilePrompt(issue, '  ', 'es', { contextFile: FILE }),
    `Trabaja en la tarea de Redmine #4077 "Checkout screen": https://redmine.test/issues/4077\nLee primero su descripción y comentarios en ${FILE}.`
  )
  // The CLI hint stays between the instructions and the pointer.
  assert.equal(
    contextFilePrompt(issue, 'Go', 'en', { contextFile: FILE, redmineCli: true }),
    `Go\nThe \`redmine\` CLI is available to read or update task #4077.\n${POINTER}`
  )
})

test('long instructions are cut, never the pointer, and the prompt stays under the cap', () => {
  const text = contextFilePrompt(issue, 'y'.repeat(6000), 'en', { contextFile: FILE })
  assert.equal(text.length, LAUNCH_PROMPT_MAX_CHARS)
  assert.ok(text.endsWith(POINTER))
  assert.ok(fitsLaunchPrompt(text))
})
