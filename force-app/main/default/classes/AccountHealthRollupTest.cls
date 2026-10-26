@isTest
private class AccountHealthRollupTest {

    static Fixtures provisionAndRun() {
        Fixtures fixtures = new Fixtures();
        fixtures.provision(50, 5, 10);
        Test.startTest();
        new AccountHealthRollup().run();
        Test.stopTest();
        return fixtures;
    }

    @isTest
    static void fixturesProvisioned() {
        Fixtures fixtures = new Fixtures();
        fixtures.provision(50, 5, 10);
        Set<Id> scenarioAccountIds = new Map<Id, Account>(fixtures.accountsByScenario.values()).keySet();
        System.assertEquals(6, scenarioAccountIds.size(), 'one account per doc example');
        System.assertEquals(6, [SELECT COUNT() FROM Opportunity WHERE AccountId IN :scenarioAccountIds], 'scenario opportunities');
        System.assertEquals(250, [SELECT COUNT() FROM Opportunity WHERE AccountId IN :fixtures.bulkAccountIds()], 'bulk opportunities');
        System.assertEquals(500, [SELECT COUNT() FROM Task WHERE WhatId IN :fixtures.bulkAccountIds()], 'bulk tasks');
    }

    @isTest
    static void ratesEveryAccount() {
        Fixtures fixtures = new Fixtures();
        fixtures.provision(50, 5, 10);
        Test.startTest();
        Integer accountsRated = new AccountHealthRollup().run();
        Test.stopTest();
        System.assertEquals(56, accountsRated, 'every fixture account is rated');
    }

    @isTest
    static void hotAccount() {
        Fixtures fixtures = provisionAndRun();
        System.assertEquals('Hot', fixtures.reload('hot').Rating, 'example 1');
        System.assertEquals(0, fixtures.followUps('hot').size(), 'example 1 needs no follow-up');
    }

    @isTest
    static void warmAccount() {
        Fixtures fixtures = provisionAndRun();
        System.assertEquals('Warm', fixtures.reload('warm').Rating, 'example 2');
        System.assertEquals(0, fixtures.followUps('warm').size(), 'example 2 needs no follow-up');
    }

    @isTest
    static void staleAccountGetsFollowUp() {
        Fixtures fixtures = provisionAndRun();
        Account stale = fixtures.reload('stale');
        List<Task> created = fixtures.followUps('stale');
        System.assertEquals('Cold', stale.Rating, 'example 3');
        System.assertEquals(1, created.size(), 'example 3 gets one follow-up');
        System.assertEquals(stale.OwnerId, created[0].OwnerId, 'follow-up assigned to account owner');
        System.assertEquals(Date.today().addDays(7), created[0].ActivityDate, 'follow-up due in 7 days');
        System.assertEquals('High', created[0].Priority, 'follow-up priority');
        System.assertEquals('Not Started', created[0].Status, 'follow-up status');
    }

    @isTest
    static void existingFollowUpNotDuplicated() {
        Fixtures fixtures = provisionAndRun();
        System.assertEquals('Cold', fixtures.reload('alreadyFollowedUp').Rating, 'example 4');
        System.assertEquals(1, fixtures.followUps('alreadyFollowedUp').size(), 'example 4 keeps only the existing follow-up');
    }

    @isTest
    static void rerunCreatesNoSecondFollowUp() {
        Fixtures fixtures = new Fixtures();
        fixtures.provision(50, 5, 10);
        new AccountHealthRollup().run();
        Test.startTest();
        new AccountHealthRollup().run();
        Test.stopTest();
        System.assertEquals(1, fixtures.followUps('stale').size(), 'example 4 rerun');
    }

    @isTest
    static void lapsedAccount() {
        Fixtures fixtures = provisionAndRun();
        System.assertEquals('Cold', fixtures.reload('lapsed').Rating, 'example 5');
        System.assertEquals(0, fixtures.followUps('lapsed').size(), 'example 5 needs no follow-up');
    }

    @isTest
    static void opportunityActivityCounts() {
        Fixtures fixtures = provisionAndRun();
        System.assertEquals('Warm', fixtures.reload('opportunityActivity').Rating, 'example 6');
        System.assertEquals(0, fixtures.followUps('opportunityActivity').size(), 'example 6 needs no follow-up');
    }

    @isTest
    static void bulkAccountsRated() {
        Fixtures fixtures = provisionAndRun();
        System.assertEquals(fixtures.bulkAccounts.size(),
                [SELECT COUNT() FROM Account WHERE Id IN :fixtures.bulkAccountIds() AND Rating = 'Warm'], 'bulk accounts are Warm');
    }

    @isTest
    static void filtersNarrowTheRun() {
        Fixtures fixtures = new Fixtures();
        fixtures.provision(50, 5, 10);
        Test.startTest();
        Integer rated = new AccountHealthRollup(new Map<String, String>{'Name' => 'Hot Account'}).run();
        Test.stopTest();
        System.assertEquals(1, rated, 'name filter rates one account');
    }
}
