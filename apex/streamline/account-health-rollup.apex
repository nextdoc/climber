// Runs the deployed AccountHealthRollup against deployed Fixtures. Requirements: doc/account-health-rollup.md

// === CLASSES ===

class RollupScenarios {
    Fixtures fixtures;

    RollupScenarios(Fixtures fixtures) {
        this.fixtures = fixtures;
    }

    void fixturesProvisioned() {
        Set<Id> scenarioAccountIds = new Map<Id, Account>(fixtures.accountsByScenario.values()).keySet();
        System.assertEquals(6, scenarioAccountIds.size(), 'one account per doc example');
        System.assertEquals(6, [SELECT COUNT() FROM Opportunity WHERE AccountId IN :scenarioAccountIds], 'scenario opportunities');
        System.assertEquals(250, [SELECT COUNT() FROM Opportunity WHERE AccountId IN :fixtures.bulkAccountIds()], 'bulk opportunities');
        System.assertEquals(500, [SELECT COUNT() FROM Task WHERE WhatId IN :fixtures.bulkAccountIds()], 'bulk tasks');
    }

    void ratesEveryAccount(Integer accountsRated) {
        Integer fixtureAccounts = fixtures.accountsByScenario.size() + fixtures.bulkAccounts.size();
        System.assert(accountsRated >= fixtureAccounts, 'every fixture account is rated, got ' + accountsRated);
    }

    void hotAccount() {
        System.assertEquals('Hot', fixtures.reload('hot').Rating, 'example 1');
        System.assertEquals(0, fixtures.followUps('hot').size(), 'example 1 needs no follow-up');
    }

    void warmAccount() {
        System.assertEquals('Warm', fixtures.reload('warm').Rating, 'example 2');
        System.assertEquals(0, fixtures.followUps('warm').size(), 'example 2 needs no follow-up');
    }

    void staleAccountGetsFollowUp() {
        Account stale = fixtures.reload('stale');
        List<Task> created = fixtures.followUps('stale');
        System.assertEquals('Cold', stale.Rating, 'example 3');
        System.assertEquals(1, created.size(), 'example 3 gets one follow-up');
        System.assertEquals(stale.OwnerId, created[0].OwnerId, 'follow-up assigned to account owner');
        System.assertEquals(Date.today().addDays(7), created[0].ActivityDate, 'follow-up due in 7 days');
        System.assertEquals('High', created[0].Priority, 'follow-up priority');
        System.assertEquals('Not Started', created[0].Status, 'follow-up status');
    }

    void existingFollowUpNotDuplicated() {
        System.assertEquals('Cold', fixtures.reload('alreadyFollowedUp').Rating, 'example 4');
        System.assertEquals(1, fixtures.followUps('alreadyFollowedUp').size(), 'example 4 keeps only the existing follow-up');
    }

    void rerunCreatesNoSecondFollowUp() {
        new AccountHealthRollup().run();
        System.assertEquals(1, fixtures.followUps('stale').size(), 'example 4 rerun');
    }

    void lapsedAccount() {
        System.assertEquals('Cold', fixtures.reload('lapsed').Rating, 'example 5');
        System.assertEquals(0, fixtures.followUps('lapsed').size(), 'example 5 needs no follow-up');
    }

    void opportunityActivityCounts() {
        System.assertEquals('Warm', fixtures.reload('opportunityActivity').Rating, 'example 6');
        System.assertEquals(0, fixtures.followUps('opportunityActivity').size(), 'example 6 needs no follow-up');
    }

    void bulkAccountsRated() {
        System.assertEquals(fixtures.bulkAccounts.size(),
                [SELECT COUNT() FROM Account WHERE Id IN :fixtures.bulkAccountIds() AND Rating = 'Warm'], 'bulk accounts are Warm');
    }

    void filtersNarrowTheRun() {
        Integer rated = new AccountHealthRollup(new Map<String, String>{'Name' => 'Hot Account'}).run();
        System.assertEquals(1, rated, 'name filter rates one account');
    }

    void runAll() {
        fixturesProvisioned();
        ratesEveryAccount(new AccountHealthRollup().run());
        hotAccount();
        warmAccount();
        staleAccountGetsFollowUp();
        existingFollowUpNotDuplicated();
        lapsedAccount();
        opportunityActivityCounts();
        bulkAccountsRated();
        rerunCreatesNoSecondFollowUp();
        filtersNarrowTheRun();
    }
}

// === CODE ===

Fixtures fixtures = new Fixtures();
fixtures.provision(50, 5, 10);
new RollupScenarios(fixtures).runAll();
