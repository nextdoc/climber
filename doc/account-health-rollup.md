# Account Health Rollup

## Story

As a sales manager, I want every account rated by how healthy the relationship is, so my team spends time on the accounts that need it. When a relationship goes quiet while there is still money on the table, the account owner should get a follow-up task automatically.

## Scope

- Uses only the standard Salesforce data model: Account, Opportunity and Task.
- Runs across all accounts in the org by default. Configurable filters narrow the run, for example to certain account types, industries, owners or billing countries.
- Ratings are calculated as of the run date.
- Single currency. A missing opportunity amount counts as zero.

## Measures

Each account is measured on three things.

| Measure | Definition |
|---|---|
| Won revenue | Total amount of the account's won opportunities that closed in the last 12 months |
| Open pipeline | Total amount of the account's open opportunities |
| Last activity | Date of the most recent completed task on the account or on any of its opportunities |

## Rating

The account's Rating is set to one of three values. The first rule that matches wins.

| Rating | Rule |
|---|---|
| Hot | Won revenue of at least 100,000, or open pipeline of at least 250,000, and last activity within the last 30 days |
| Warm | Some won revenue or some open pipeline, and last activity within the last 90 days |
| Cold | Everything else, including accounts with no activity at all |

## Follow-up tasks

An account needs follow-up when it has open pipeline but no activity in the last 90 days.

For each such account, create a task:

- **Subject:** `Re-engage <account name>`
- **Related to:** the account
- **Assigned to:** the account owner
- **Due:** 7 days after the run date
- **Priority:** High
- **Status:** Not Started

Do not create a follow-up task if the account already has an open task with the same subject.

## Examples

1. An account with 150,000 won last month and a completed call last week is **Hot**.
2. An account with 300,000 open pipeline and no activity in 45 days is **Warm**.
3. An account with 50,000 open pipeline and its last completed task 120 days ago is **Cold** and gets a follow-up task.
4. The same account run again the next day gets no second follow-up task.
5. An account whose only won opportunity closed 14 months ago and has no open pipeline is **Cold** and gets no follow-up task.
6. A completed task logged against one of the account's opportunities counts as activity on the account.

## Expected volumes

- Accounts per run: every account matching the filters, up to every account in the org
- Opportunities per account: up to 50
- Tasks per account, including tasks on its opportunities: up to 200
