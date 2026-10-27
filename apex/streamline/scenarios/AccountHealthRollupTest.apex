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
        Map<String, Integer> after = limitUsage();
        Map<String, Integer> limitOf = new Map<String, Integer>{
                'Number of SOQL queries' => Limits.getLimitQueries(),
                'Number of query rows' => Limits.getLimitQueryRows(),
                'Number of DML statements' => Limits.getLimitDmlStatements(),
                'Number of DML rows' => Limits.getLimitDmlRows(),
                'Maximum CPU time' => Limits.getLimitCpuTime()
        };
        Map<String, Map<String, Integer>> usage = new Map<String, Map<String, Integer>>();
        for (String name : after.keySet()) {
            usage.put(name, new Map<String, Integer>{'used' => after.get(name) - before.get(name), 'limit' => limitOf.get(name)});
        }
        System.debug('LIMITS|AccountHealthRollupTest.' + scenario + '|' + JSON.serialize(usage));
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
        System.debug('TEST|AccountHealthRollupTest.' + name + '|' + results.get(name));
    }

    // Each test starts with no org data. The scratch org's sample account has an entitlement that blocks its delete.
    void emptyOrg() {
        delete [SELECT Id FROM Entitlement];
        delete [SELECT Id FROM Account];
    }

    public void runCorrectness() {
        emptyOrg();
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
        System.debug('TEST|AccountHealthRollupTest.rateAllFromFlow|SKIP static @InvocableMethod is not allowed in anonymous Apex');
    }

    public void runHeadroom() {
        emptyOrg();
        scenario('headroomAt200Accounts');
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
