# Spec Delta

## ADDED Requirements

### Requirement: Resume the agent from a follow-up
When an "agent finished" follow-up knows the workspace, agent kind and session of the agent that finished, it SHALL offer "Resume agent", which resumes that session in its workspace through Orca. When Orca reports that the session is already running, the panel SHALL say so and show its terminal. Resuming SHALL NOT write to Redmine and SHALL NOT dismiss the follow-up.

#### Scenario: Resume
- **GIVEN** a follow-up for #4077 recorded when a Claude agent with a known session finished in `4077-checkout`
- **WHEN** the user presses "Resume agent"
- **THEN** Orca resumes that Claude session in a new terminal of `4077-checkout` and the follow-up stays

#### Scenario: Already running
- **GIVEN** that session is already open in a terminal
- **WHEN** the user presses "Resume agent"
- **THEN** the panel says the agent is already running and Orca shows its terminal

#### Scenario: Session unknown
- **GIVEN** a follow-up recorded by version 0.2.x, or for an agent whose kind Orca did not report
- **WHEN** the panel shows it
- **THEN** it has no "Resume agent" action and its other actions work as before
