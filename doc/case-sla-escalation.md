# Case SLA Escalation

## Story

As a support manager, I want open cases that have waited too long for a first response escalated automatically, so no customer is left waiting. Escalations for the accounts that matter most should go to the account owner.

## Scope

- Uses only the standard Salesforce data model: Case, CaseComment, Account, User and BusinessHours. It needs no metadata.
- Runs across all open cases in the org.
- A case's age is measured in its business hours, or the org's default business hours when it has none, from when it was created to the run time. The run time is now unless one is given.
- Reads the account Rating that [Account Health Rollup](account-health-rollup.md) sets.

## First response targets

| Priority | First response within |
|---|---|
| High | 4 business hours |
| Medium | 8 business hours |
| Low | 24 business hours |

A case has had a first response when it has at least one public comment.

## Escalation

A case is escalated when it is open, not already escalated, has had no first response, and its age is more than its target.

For each such case:

- **Status:** Escalated, and the case is flagged as escalated
- **Priority:** raised one level. Low becomes Medium, Medium becomes High, and High stays High.
- **Owner:** the account owner when the case's account is rated Hot and its owner is active, otherwise unchanged
- **Comment:** a private comment `Escalated: no first response within <n> business hours`, where `<n>` is the target for the priority the case had before it was raised

The run returns the number of cases escalated.

## Examples

All examples run 10 business hours after the cases were created.

1. A High case with no comments is escalated, keeps its owner, stays High, and gets the comment `Escalated: no first response within 4 business hours`.
2. A Medium case with no comments is escalated, raised to High, and its comment names 8 business hours.
3. A Low case with no comments is within its target and is not escalated.
4. A High case with a public reply is not escalated.
5. A High case with only a private comment is escalated.
6. A High case on an account rated Hot is escalated and assigned to the account owner.
7. A case that is already escalated keeps its owner and gets no second comment.
8. A closed case is not escalated.
9. Running again escalates nothing and adds no second comment.
10. A High case with no account is escalated and keeps its owner.
11. A High case on an account that Account Health Rollup rates Hot is escalated and assigned to the account owner.
12. A High case on an account rated Hot whose owner is inactive is escalated and keeps its owner.

## Expected volumes

- Open cases per run: up to every open case in the org
- Cases escalated per run: up to every open case
- Comments per case: up to 50
