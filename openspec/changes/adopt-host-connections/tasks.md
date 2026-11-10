# Tasks

## 1. Now (no Orca dependency)

- [x] 1.1 Add a worker test that triggers each Redmine error path and asserts no `orca.log` line contains the API key

## 2. Gate

- [ ] 2.1 Watch Orca releases for `contributes.connections` with a `Since` version and API-key support; record version and link here
- [ ] 2.2 Rewrite design.md and tasks against the published format; re-validate with `openspec validate adopt-host-connections`

## 3. Implementation (refine after 2.2)

- [ ] 3.1 Declare the connection and switch `client()`/`status()` to it; verify panel and status bar on a dev load
- [ ] 3.2 Migrate the stored key with user consent, delete the plugin secret, drop `secrets:own`; verify migration test and README Permissions
