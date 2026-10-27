// Copies of AccountHealthRollup.cls and AccountHealthRollupTest.cls, so a candidate runs without a deploy. Fixtures stays deployed.
// Requirements: doc/account-health-rollup.md

// === CLASSES ===

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

    // rateAll() is left out: anonymous Apex allows static only on top-level types.

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

public class ScenarioFailedException extends Exception {}

/**
 * The test methods as scenarios. One transaction cannot provision fresh data per test within the DML row limit,
 * so the scenarios that only read the result of provisioning and one run share them, as each test would see them.
 */
public class AccountHealthRollupTest {
    Fixtures fixtures;
    Integer accountsRated;
    public Map<String, String> results = new Map<String, String>();

    // System.assertEquals failures cannot be caught, so each scenario could not report on its own.
    void assertEquals(Object expected, Object actual, String message) {
        if (expected != actual) {
            throw new ScenarioFailedException(message + ': expected ' + expected + ', got ' + actual);
        }
    }

    // Logs the run's governor limit use, as Test.startTest and Test.stopTest would scope it.
    Integer measuredRun(String scenario, AccountHealthRollup rollup) {
        Map<String, Integer> before = limitUsage();
        Integer rated = rollup.run();
        Map<String, Integer> used = limitUsage();
        for (String name : used.keySet()) {
            used.put(name, used.get(name) - before.get(name));
        }
        System.debug('LIMITS|' + scenario + '|' + JSON.serialize(used));
        return rated;
    }

    Map<String, Integer> limitUsage() {
        return new Map<String, Integer>{
                'Number of SOQL queries' => Limits.getQueries(),
                'Number of query rows' => Limits.getQueryRows(),
                'Number of DML statements' => Limits.getDmlStatements(),
                'Number of DML rows' => Limits.getDmlRows(),
                'Maximum CPU time' => Limits.getCpuTime()
        };
    }

    void fixturesProvisioned() {
        Set<Id> scenarioAccountIds = new Map<Id, Account>(fixtures.accountsByScenario.values()).keySet();
        assertEquals(6, scenarioAccountIds.size(), 'one account per doc example');
        assertEquals(6, [SELECT COUNT() FROM Opportunity WHERE AccountId IN :scenarioAccountIds], 'scenario opportunities');
        assertEquals(250, [SELECT COUNT() FROM Opportunity WHERE AccountId IN :fixtures.bulkAccountIds()], 'bulk opportunities');
        assertEquals(500, [SELECT COUNT() FROM Task WHERE WhatId IN :fixtures.bulkAccountIds()], 'bulk tasks');
    }

    void filtersNarrowTheRun() {
        Integer rated = measuredRun('filtersNarrowTheRun', new AccountHealthRollup(new Map<String, String>{'Name' => 'Hot Account'}));
        assertEquals(1, rated, 'name filter rates one account');
    }

    void ratesEveryAccount() {
        assertEquals(56, accountsRated, 'every fixture account is rated');
    }

    void hotAccount() {
        assertEquals('Hot', fixtures.reload('hot').Rating, 'example 1');
        assertEquals(0, fixtures.followUps('hot').size(), 'example 1 needs no follow-up');
    }

    void warmAccount() {
        assertEquals('Warm', fixtures.reload('warm').Rating, 'example 2');
        assertEquals(0, fixtures.followUps('warm').size(), 'example 2 needs no follow-up');
    }

    void staleAccountGetsFollowUp() {
        Account stale = fixtures.reload('stale');
        List<Task> created = fixtures.followUps('stale');
        assertEquals('Cold', stale.Rating, 'example 3');
        assertEquals(1, created.size(), 'example 3 gets one follow-up');
        assertEquals(stale.OwnerId, created[0].OwnerId, 'follow-up assigned to account owner');
        assertEquals(Date.today().addDays(7), created[0].ActivityDate, 'follow-up due in 7 days');
        assertEquals('High', created[0].Priority, 'follow-up priority');
        assertEquals('Not Started', created[0].Status, 'follow-up status');
    }

    void existingFollowUpNotDuplicated() {
        assertEquals('Cold', fixtures.reload('alreadyFollowedUp').Rating, 'example 4');
        assertEquals(1, fixtures.followUps('alreadyFollowedUp').size(), 'example 4 keeps only the existing follow-up');
    }

    void lapsedAccount() {
        assertEquals('Cold', fixtures.reload('lapsed').Rating, 'example 5');
        assertEquals(0, fixtures.followUps('lapsed').size(), 'example 5 needs no follow-up');
    }

    void opportunityActivityCounts() {
        assertEquals('Warm', fixtures.reload('opportunityActivity').Rating, 'example 6');
        assertEquals(0, fixtures.followUps('opportunityActivity').size(), 'example 6 needs no follow-up');
    }

    void bulkAccountsRated() {
        assertEquals(fixtures.bulkAccounts.size(),
                [SELECT COUNT() FROM Account WHERE Id IN :fixtures.bulkAccountIds() AND Rating = 'Warm'], 'bulk accounts are Warm');
    }

    void rerunCreatesNoSecondFollowUp() {
        measuredRun('rerunCreatesNoSecondFollowUp', new AccountHealthRollup());
        assertEquals(1, fixtures.followUps('stale').size(), 'example 4 rerun');
    }

    void headroomAt200Accounts() {
        fixtures = new Fixtures();
        fixtures.provision(194, 5, 10);
        Integer rated = measuredRun('headroomAt200Accounts', new AccountHealthRollup());
        assertEquals(200, rated, '194 bulk plus 6 scenario accounts make one batch of 200');
    }

    void scenario(String name) {
        try {
            if (name == 'fixturesProvisioned') fixturesProvisioned();
            else if (name == 'filtersNarrowTheRun') filtersNarrowTheRun();
            else if (name == 'ratesEveryAccount') ratesEveryAccount();
            else if (name == 'hotAccount') hotAccount();
            else if (name == 'warmAccount') warmAccount();
            else if (name == 'staleAccountGetsFollowUp') staleAccountGetsFollowUp();
            else if (name == 'existingFollowUpNotDuplicated') existingFollowUpNotDuplicated();
            else if (name == 'lapsedAccount') lapsedAccount();
            else if (name == 'opportunityActivityCounts') opportunityActivityCounts();
            else if (name == 'bulkAccountsRated') bulkAccountsRated();
            else if (name == 'rerunCreatesNoSecondFollowUp') rerunCreatesNoSecondFollowUp();
            else if (name == 'headroomAt200Accounts') headroomAt200Accounts();
            results.put(name, 'PASS');
        } catch (Exception e) {
            results.put(name, 'FAIL ' + e.getTypeName() + ': ' + e.getMessage());
        }
        System.debug('TEST|' + name + '|' + results.get(name));
    }

    public void runAll() {
        // Each test starts with no org data. The scratch org's sample account has an entitlement that blocks its delete.
        delete [SELECT Id FROM Entitlement];
        delete [SELECT Id FROM Account];
        Savepoint empty = Database.setSavepoint();

        fixtures = new Fixtures();
        fixtures.provision(50, 5, 10);
        scenario('fixturesProvisioned');
        scenario('filtersNarrowTheRun');
        accountsRated = measuredRun('ratesEveryAccount', new AccountHealthRollup());
        for (String name : new List<String>{
                'ratesEveryAccount', 'hotAccount', 'warmAccount', 'staleAccountGetsFollowUp', 'existingFollowUpNotDuplicated',
                'lapsedAccount', 'opportunityActivityCounts', 'bulkAccountsRated', 'rerunCreatesNoSecondFollowUp'
        }) {
            scenario(name);
        }

        Database.rollback(empty);
        scenario('headroomAt200Accounts');
        results.put('rateAllFromFlow', 'SKIP static @InvocableMethod is not allowed in anonymous Apex');
        System.debug('RESULTS|' + JSON.serialize(results));
    }

    public List<String> failures() {
        List<String> failed = new List<String>();
        for (String name : results.keySet()) {
            if (results.get(name).startsWith('FAIL')) {
                failed.add(name + ': ' + results.get(name));
            }
        }
        return failed;
    }
}

// === CODE ===

AccountHealthRollupTest tests = new AccountHealthRollupTest();
tests.runAll();

// === ASSERTIONS ===

System.assert(tests.failures().isEmpty(), String.join(tests.failures(), '; '));
