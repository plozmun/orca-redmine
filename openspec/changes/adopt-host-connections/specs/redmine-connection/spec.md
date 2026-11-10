# Spec Delta

## Purpose

Defines how the plugin authenticates to a Redmine instance and guarantees the credential is validated, stored securely and never exposed to agents or logs.

## ADDED Requirements

### Requirement: Validated sign-in
A Redmine connection SHALL be saved only after the URL and credential are accepted by Redmine (`/users/current.json`).

#### Scenario: Wrong key
- **WHEN** the user enters a key Redmine rejects
- **THEN** nothing is saved and the user sees that the key was refused

### Requirement: Credential never leaves secure storage
The credential SHALL be stored only in OS-backed encrypted storage (today the plugin's secrets; after migration, Orca's connection), and SHALL NOT be written to settings, plugin storage, files, logs, prompts or agent environments.

#### Scenario: Log inspection
- **WHEN** the plugin logs a Redmine error
- **THEN** the log line does not contain the key

### Requirement: Host-managed connection when available
When Orca supports plugin connections, sign-in, change and removal SHALL happen in Orca's connection UI, and the plugin SHALL NOT keep its own copy of the credential.

#### Scenario: Migration
- **GIVEN** a user connected with version 0.2
- **WHEN** they update to the connections version and accept the move
- **THEN** the key is in Orca's connection and no longer in the plugin's secrets

#### Scenario: Disconnect
- **WHEN** the user removes the Redmine connection in Orca
- **THEN** the panel shows the disconnected state and the status bar item hides
