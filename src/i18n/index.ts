// Minimal i18n shared by the panel and the worker. The panel passes Orca's UI language
// (`env.locale`); the worker, which gets no locale from Orca, receives it in each request or
// falls back to the system locale. To add a language: copy es.ts, translate it, register it below.
import { en, type MessageKey, type Messages } from './en'
import { es } from './es'

export type { MessageKey }

const catalogs: Record<string, Messages> = { en, es }

export const supportedLocales = Object.keys(catalogs)

/** `es-ES` → `es`; unknown languages → `en`. */
export function resolveLocale(locale: string | null | undefined): string {
  const language = (locale ?? '').toLowerCase().split(/[-_]/)[0]
  return language in catalogs ? language : 'en'
}

export function translate(
  locale: string | null | undefined,
  key: MessageKey,
  vars: Record<string, string | number> = {}
): string {
  const template = catalogs[resolveLocale(locale)][key] ?? en[key] ?? key
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
}

/** Translation of an error code, or null when there is none. */
export function translateErrorCode(locale: string | null | undefined, code: string, detail: string): string | null {
  const key = `errors.${code}` as MessageKey
  return key in en ? translate(locale, key, { detail }) : null
}

/** The machine's locale, for worker output that no panel asked for (command palette). */
export function systemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return 'en'
  }
}
