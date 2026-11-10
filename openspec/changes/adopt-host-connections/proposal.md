# Proposal

> **Blocked on Orca.** `contributes.connections` is reserved until Orca defines it ("account providers with a host-run sign-in, so a plugin never handles credentials itself").

## Why

The panel asks for the Redmine URL and API key, validates the key, and stores it with `secrets:own`. That means the plugin handles a credential, which is exactly what the listing review looks at for a `trusted-worker` plugin, and the sign-in UI is the plugin's own. A host-run connection would move the credential out of the plugin.

## What Changes

- Declare a Redmine connection (base URL + API key, or whatever auth kinds Orca supports) so sign-in runs in Orca's UI.
- The worker uses the connection to call Redmine instead of reading `secrets.get('apiKey')`.
- Remove the panel's connect form and drop `secrets:own` once the connection covers every flow.
- Migrate users already connected: offer to move the stored key into the connection, then delete it from the plugin secrets.

## Capabilities

### New Capabilities
- `redmine-connection`: how the plugin signs in to Redmine, where the credential lives, and how a connection is checked, changed and removed.

### Modified Capabilities

## Impact

- Manifest (`contributes.connections`, capability removal), worker `client()`/`status()`, panel connect screen, README Permissions.
