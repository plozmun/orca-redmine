// `orca plugin check` renders the panel once per scenario, with the real worker on a fresh host.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  // Not configured: the connect form.
  notConfigured: {},
  // Configured against a closed port: shows the connection error.
  unreachable: { settings: { url: 'http://127.0.0.1:9' }, secrets: { apiKey: 'x' } }
})
