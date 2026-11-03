// Redmine's default text format is Textile; Orca's Markdown component draws `# step` (a Textile
// numbered list) as a big heading and shows `!image.png!` literally. This converts the common
// Textile constructs to Markdown, only when the text looks like Textile.

const TEXTILE_HINT = /^h[1-6]\.\s|^bq\.\s|^#{1,3}\s|!\S+\.(?:png|jpe?g|gif|webp|svg)!|^\|.*\|\s*$|<pre>|@[^@\s][^@]*@|"[^"]+":https?:\/\//im
const MARKDOWN_HINT = /^```|^#{1,6}\s.*\n(?!#)|\]\(https?:\/\/|^\s*[-*]\s\[[ x]\]/m

/** Whether the text is probably Textile (Redmine's default) rather than Markdown. */
export function looksLikeTextile(text: string): boolean {
  if (/^h[1-6]\.\s/m.test(text) || /!\S+\.(?:png|jpe?g|gif|webp|svg)!/i.test(text) || /<pre>/i.test(text)) return true
  if (/^```/m.test(text) || /\]\(https?:\/\//.test(text)) return false
  // `# a` lines followed by more `# b` lines are a numbered list, not a run of headings.
  if (/^#\s.+\n#\s/m.test(text)) return true
  return TEXTILE_HINT.test(text) && !MARKDOWN_HINT.test(text)
}

function inline(line: string): string {
  return (
    line
      // Images: !file.png! or !url! → a label (the panel cannot show Redmine attachments).
      .replace(/!([^\s!]+\.(?:png|jpe?g|gif|webp|svg))(?:\([^)]*\))?!/gi, (_, src: string) => `🖼 _${src.split('/').pop()}_`)
      // Links: "text":url → [text](url)
      .replace(/"([^"]+)":(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)])/g, '[$1]($2)')
      // @code@ → `code`
      .replace(/(^|[\s(])@([^@\n]+)@(?=$|[\s.,;:!?)])/g, '$1`$2`')
      // *bold* → **bold**, _italic_ stays (same in Markdown), -strike- → ~~strike~~
      .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=$|[\s.,;:!?)])/g, '$1**$2**')
      .replace(/(^|[\s(])-([^-\s][^-\n]*?)-(?=$|[\s.,;:!?)])/g, '$1~~$2~~')
  )
}

/** Converts common Textile to Markdown. Text that does not look like Textile is returned as is. */
export function textileToMarkdown(text: string): string {
  if (!looksLikeTextile(text)) return text
  const out: string[] = []
  let inPre = false
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = raw
    if (/<pre[^>]*>/i.test(line)) {
      inPre = true
      out.push('```')
      line = line.replace(/<pre[^>]*>(<code[^>]*>)?/i, '')
      if (!line.trim()) continue
    }
    if (inPre) {
      const end = /<\/pre>/i.test(line)
      const body = line.replace(/(<\/code>)?<\/pre>/i, '')
      if (body || !end) out.push(body)
      if (end) {
        inPre = false
        out.push('```')
      }
      continue
    }
    const heading = /^h([1-6])\.\s+(.*)$/.exec(line)
    if (heading) {
      // Sidebar-sized: h1/h2 become level 3, the rest level 4.
      out.push(`${Number(heading[1]) <= 2 ? '###' : '####'} ${inline(heading[2] ?? '')}`)
      continue
    }
    const numbered = /^(#{1,3})\s+(.*)$/.exec(line)
    if (numbered) {
      out.push(`${'   '.repeat((numbered[1] ?? '#').length - 1)}1. ${inline(numbered[2] ?? '')}`)
      continue
    }
    const bullet = /^(\*{1,3})\s+(.*)$/.exec(line)
    if (bullet) {
      out.push(`${'  '.repeat((bullet[1] ?? '*').length - 1)}- ${inline(bullet[2] ?? '')}`)
      continue
    }
    const quote = /^bq\.\s+(.*)$/.exec(line)
    if (quote) {
      out.push(`> ${inline(quote[1] ?? '')}`)
      continue
    }
    out.push(inline(line))
  }
  if (inPre) out.push('```')
  return out.join('\n')
}
