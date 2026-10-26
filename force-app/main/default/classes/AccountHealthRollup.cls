public class AccountHealthRollup {
    Map<String, String> filters;
    Integer accountsRated = 0;

    /**
     * @description Rates every account in the org.
     */
    public AccountHealthRollup() {
        this(new Map<String, String>());
    }

    /**
     * @description Rates only the accounts matching the filters.
     * @param filters account field values an account must match
     */
    public AccountHealthRollup(Map<String, String> filters) {
        this.filters = filters;
    }

    /**
     * @description Rates each account's health and creates follow-up tasks for accounts gone quiet.
     * @return the number of accounts rated
     */
    public Integer run() {
        String query = 'SELECT Id, Name, OwnerId, Rating, Type, Industry, BillingCountry, Description, '
                + 'AnnualRevenue, NumberOfEmployees, CreatedDate, LastModifiedDate FROM Account';
        if (filters != null && !filters.isEmpty()) {
            List<String> conditions = new List<String>();
            for (String field : filters.keySet()) {
                conditions.add(field + ' = \'' + filters.get(field) + '\'');
            }
            query += ' WHERE ' + String.join(conditions, ' AND ');
        }
        System.debug('Account health query: ' + query);
        for (List<Account> accounts : Database.query(query)) {
            processAccounts(accounts);
        }
        System.debug('Accounts rated: ' + accountsRated);
        return accountsRated;
    }

    /**
     * @description Rates every account in the org. Invoked from a schedule-triggered Flow, which also gives
     * Salesforce Graph Engine an entry point to analyse.
     */
    @InvocableMethod(label='Rate Account Health' description='Rates every account and creates follow-up tasks')
    public static void rateAll() {
        new AccountHealthRollup().run();
    }

    /**
     * @description Measures won revenue, open pipeline and last activity for each account, then rates it.
     * @param accounts the accounts to rate
     */
    void processAccounts(List<Account> accounts) {
        Set<Id> accountIds = new Set<Id>();
        for (Account acc : accounts) {
            accountIds.add(acc.Id);
        }

        List<Opportunity> opportunities = [
                SELECT Id, Name, AccountId, Amount, StageName, CloseDate, IsClosed, IsWon, Probability, CreatedDate
                FROM Opportunity
                WHERE AccountId IN :accountIds
        ];
        Set<Id> opportunityIds = new Set<Id>();
        for (Opportunity opp : opportunities) {
            opportunityIds.add(opp.Id);
        }

        List<Task> tasks = [
                SELECT Id, WhatId, Subject, Status, ActivityDate, Priority, OwnerId, Description
                FROM Task
                WHERE WhatId IN :accountIds OR WhatId IN :opportunityIds
        ];

        List<Account> accountsToUpdate = new List<Account>();
        for (Account acc : accounts) {
            Decimal wonRevenue = 0;
            Decimal openPipeline = 0;
            Date lastActivity = null;
            List<Id> accountOpportunityIds = new List<Id>();

            for (Opportunity opp : opportunities) {
                if (opp.AccountId == acc.Id) {
                    accountOpportunityIds.add(opp.Id);
                    if (opp.IsWon == true) {
                        if (opp.CloseDate >= Date.today().addDays(-365)) {
                            if (opp.Amount != null) {
                                wonRevenue += opp.Amount;
                            }
                        }
                    } else if (opp.StageName != 'Closed Won' && opp.StageName != 'Closed Lost') {
                        if (opp.Amount != null) {
                            openPipeline += opp.Amount;
                        }
                    }
                }
            }

            for (Task t : tasks) {
                if (t.WhatId == acc.Id || accountOpportunityIds.contains(t.WhatId)) {
                    if (t.Status == 'Completed' && t.ActivityDate != null) {
                        if (lastActivity == null || t.ActivityDate > lastActivity) {
                            lastActivity = t.ActivityDate;
                        }
                    }
                }
            }

            System.debug(acc.Name + ' won=' + wonRevenue + ' pipeline=' + openPipeline + ' lastActivity=' + lastActivity);
            acc.Rating = calculateRating(wonRevenue, openPipeline, lastActivity);
            accountsToUpdate.add(acc);
            accountsRated++;

            if (needsFollowUp(openPipeline, lastActivity)) {
                createFollowUpTask(acc);
            }
        }
        update accountsToUpdate;
    }

    /**
     * @description Rates an account Hot, Warm or Cold.
     * @param wonRevenue revenue won in the last 12 months
     * @param openPipeline value of open opportunities
     * @param lastActivity date of the most recent completed task, or null
     * @return the account rating
     */
    String calculateRating(Decimal wonRevenue, Decimal openPipeline, Date lastActivity) {
        Integer daysSinceActivity = lastActivity == null ? null : lastActivity.daysBetween(Date.today());
        if ((wonRevenue >= 100000 || openPipeline >= 250000) && daysSinceActivity != null && daysSinceActivity <= 30) {
            return 'Hot';
        }
        if ((wonRevenue > 0 || openPipeline > 0) && daysSinceActivity != null && daysSinceActivity <= 90) {
            return 'Warm';
        }
        return 'Cold';
    }

    /**
     * @description Decides whether an account has money on the table but no recent activity.
     * @param openPipeline value of open opportunities
     * @param lastActivity date of the most recent completed task, or null
     * @return true when the owner should follow up
     */
    Boolean needsFollowUp(Decimal openPipeline, Date lastActivity) {
        return openPipeline > 0 && (lastActivity == null || lastActivity.daysBetween(Date.today()) > 90);
    }

    /**
     * @description Asks the account owner to re-engage, unless a follow-up is already open.
     * @param acc the account needing follow-up
     */
    void createFollowUpTask(Account acc) {
        String subject = 'Re-engage ' + acc.Name;
        List<Task> existing = [SELECT Id FROM Task WHERE WhatId = :acc.Id AND Subject = :subject AND Status != 'Completed'];
        if (existing.size() == 0) {
            Task followUp = new Task(
                    WhatId = acc.Id,
                    OwnerId = acc.OwnerId,
                    Subject = subject,
                    ActivityDate = Date.today().addDays(7),
                    Priority = 'High',
                    Status = 'Not Started'
            );
            insert followUp;
            System.debug('Created follow-up task for ' + acc.Name);
        }
    }
}
