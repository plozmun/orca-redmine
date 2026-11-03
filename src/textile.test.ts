import { assert, test } from 'orca/testing'
import { looksLikeTextile, textileToMarkdown } from './textile'

test('Textile numbered lists, images and headings become sidebar-friendly Markdown', () => {
  const textile = [
    'h2. Steps',
    '# Open Mobile Pass and press "+".',
    '# Scan an adult ticket.',
    '## Check the list',
    '!clipboard-202610290941-6ynaa.png!',
    '* *Expected*: it is added',
    'See "the spec":https://example.com/spec and run @make test@.'
  ].join('\n')
  assert.equal(
    textileToMarkdown(textile),
    [
      '### Steps',
      '1. Open Mobile Pass and press "+".',
      '1. Scan an adult ticket.',
      '   1. Check the list',
      '🖼 _clipboard-202610290941-6ynaa.png_',
      '- **Expected**: it is added',
      'See [the spec](https://example.com/spec) and run `make test`.'
    ].join('\n')
  )
})

test('pre blocks become fenced code', () => {
  assert.equal(textileToMarkdown('h3. Log\n<pre>\na = 1\n</pre>'), '#### Log\n```\na = 1\n```')
})

test('Markdown and plain text are left alone', () => {
  const markdown = '# Title\n\nSome **bold** text and [a link](https://example.com).\n\n```\ncode\n```'
  assert.equal(looksLikeTextile(markdown), false)
  assert.equal(textileToMarkdown(markdown), markdown)
  assert.equal(textileToMarkdown('Just a sentence - with a dash.'), 'Just a sentence - with a dash.')
})
