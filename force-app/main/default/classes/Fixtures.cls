// Not @isTest so Streamline anonymous Apex can provision the same data the unit tests use.
public class Fixtures {
    public Map<String, Account> accountsByScenario = new Map<String, Account>();
    public List<Account> bulkAccounts = new List<Account>();

    /**
     * @description Inserts one account per requirements example, keyed by scenario name, plus bulk accounts for volume.
     * @param bulkAccountCount number of bulk accounts
     * @param bulkOpportunitiesPerAccount opportunities per bulk account, alternating won and open
     * @param bulkTasksPerAccount completed tasks per bulk account
     */
    public void provision(Integer bulkAccountCount, Integer bulkOpportunitiesPerAccount, Integer bulkTasksPerAccount) {
        accountsByScenario.put('hot', new Account(Name = 'Hot Account'));
        accountsByScenario.put('warm', new Account(Name = 'Warm Account'));
        accountsByScenario.put('stale', new Account(Name = 'Stale Account'));
        accountsByScenario.put('alreadyFollowedUp', new Account(Name = 'Followed Up Account'));
        accountsByScenario.put('lapsed', new Account(Name = 'Lapsed Account'));
        accountsByScenario.put('opportunityActivity', new Account(Name = 'Opportunity Activity Account'));
        for (Integer i = 0; i < bulkAccountCount; i++) {
            bulkAccounts.add(new Account(Name = 'Bulk Account ' + i));
        }
        List<Account> allAccounts = new List<Account>(accountsByScenario.values());
        allAccounts.addAll(bulkAccounts);
        insert allAccounts;

        Opportunity opportunityWithActivity = openOpportunity(accountsByScenario.get('opportunityActivity'), 50000);
        List<Opportunity> opportunities = new List<Opportunity>{
                wonOpportunity(accountsByScenario.get('hot'), 150000, 30),
                openOpportunity(accountsByScenario.get('warm'), 300000),
                openOpportunity(accountsByScenario.get('stale'), 50000),
                openOpportunity(accountsByScenario.get('alreadyFollowedUp'), 50000),
                wonOpportunity(accountsByScenario.get('lapsed'), 80000, 425),
                opportunityWithActivity
        };
        for (Account account : bulkAccounts) {
            for (Integer i = 0; i < bulkOpportunitiesPerAccount; i++) {
                Decimal amount = 10000 * (i + 1);
                opportunities.add(Math.mod(i, 2) == 0
                        ? wonOpportunity(account, amount, 30 * i + 10)
                        : openOpportunity(account, amount));
            }
        }
        insert opportunities;

        Task existingFollowUp = new Task(
                WhatId = accountsByScenario.get('alreadyFollowedUp').Id,
                Subject = 'Re-engage Followed Up Account',
                Status = 'Not Started'
        );
        List<Task> tasks = new List<Task>{
                completedTask(accountsByScenario.get('hot').Id, 7),
                completedTask(accountsByScenario.get('warm').Id, 45),
                completedTask(accountsByScenario.get('stale').Id, 120),
                completedTask(accountsByScenario.get('alreadyFollowedUp').Id, 120),
                existingFollowUp,
                completedTask(opportunityWithActivity.Id, 10)
        };
        for (Account account : bulkAccounts) {
            for (Integer i = 0; i < bulkTasksPerAccount; i++) {
                tasks.add(completedTask(account.Id, 15 * i + 1));
            }
        }
        insert tasks;
    }

    public Opportunity openOpportunity(Account account, Decimal amount) {
        return new Opportunity(
                AccountId = account.Id,
                Name = account.Name + ' Opportunity',
                Amount = amount,
                StageName = 'Prospecting',
                CloseDate = Date.today().addDays(30)
        );
    }

    public Opportunity wonOpportunity(Account account, Decimal amount, Integer closedDaysAgo) {
        Opportunity won = openOpportunity(account, amount);
        won.StageName = 'Closed Won';
        won.CloseDate = Date.today().addDays(-closedDaysAgo);
        return won;
    }

    public Task completedTask(Id whatId, Integer completedDaysAgo) {
        return new Task(
                WhatId = whatId,
                Subject = 'Call',
                Status = 'Completed',
                ActivityDate = Date.today().addDays(-completedDaysAgo)
        );
    }

    public Account reload(String scenario) {
        return [SELECT Id, Rating, OwnerId FROM Account WHERE Id = :accountsByScenario.get(scenario).Id];
    }

    public List<Task> followUps(String scenario) {
        Account acc = accountsByScenario.get(scenario);
        return [
                SELECT Id, OwnerId, ActivityDate, Priority, Status
                FROM Task
                WHERE WhatId = :acc.Id AND Subject = :('Re-engage ' + acc.Name)
        ];
    }

    public Set<Id> bulkAccountIds() {
        return new Map<Id, Account>(bulkAccounts).keySet();
    }
}
