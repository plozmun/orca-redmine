import { assert, test } from 'orca/testing'
import { en } from './en'
import { es } from './es'
import { resolveLocale, translate, translateErrorCode } from './index'

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

test('every locale has the same keys and placeholders as English', () => {
  for (const [name, catalog] of Object.entries({ es })) {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(en).sort(), `${name}: keys differ`)
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      assert.deepEqual(placeholders(catalog[key]), placeholders(en[key]), `${name}: placeholders differ in ${key}`)
    }
  }
})

test('resolves Orca locales to a catalog, falling back to English', () => {
  assert.equal(resolveLocale('es-ES'), 'es')
  assert.equal(resolveLocale('es_MX'), 'es')
  assert.equal(resolveLocale('en-US'), 'en')
  assert.equal(resolveLocale('fr'), 'en')
  assert.equal(resolveLocale(undefined), 'en')
})

test('fills placeholders and translates error codes', () => {
  assert.equal(translate('es', 'list.count', { shown: 2, total: 5 }), '2 de 5 tareas')
  assert.equal(translate('en', 'list.count', { shown: 2, total: 5 }), '2 of 5 tasks')
  assert.equal(translateErrorCode('es', 'unauthorized', 'HTTP 401'), 'API key no válida')
  assert.equal(translateErrorCode('en', 'network', 'fetch failed'), 'Could not reach Redmine (fetch failed)')
  assert.equal(translateErrorCode('en', 'something_else', 'x'), null)
})
