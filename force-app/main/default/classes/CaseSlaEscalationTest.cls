@isTest
private class CaseSlaEscalationTest {

    // Users are setup objects, so inserting them alongside the cases needs System.runAs to avoid mixed DML.
    static CaseFixtures provision(Integer bulkCaseCount) {
        CaseFixtures fixtures = new CaseFixtures();
        User admin = new User(Id = UserInfo.getUserId());
        System.runAs(admin) {
            fixtures.insertAccountOwners();
        }
        fixtures.provision(bulkCaseCount);
        System.runAs(admin) {
            fixtures.deactivateFormerOwner();
        }
        return fixtures;
    }

    static CaseFixtures provisionAndRun() {
        CaseFixtures fixtures = provision(50);
        Test.startTest();
        new CaseSlaEscalation(fixtures.asOf).run();
        Test.stopTest();
        return fixtures;
    }

    static void assertEscalatedTo(CaseFixtures fixtures, String scenario, String priority, Id owner) {
        Case escalated = fixtures.reload(scenario);
        System.assertEquals(true, escalated.IsEscalated, scenario + ' is escalated');
        System.assertEquals('Escalated', escalated.Status, scenario + ' status');
        System.assertEquals(priority, escalated.Priority, scenario + ' priority');
        System.assertEquals(owner, escalated.OwnerId, scenario + ' owner');
        System.assertEquals(1, fixtures.escalationComments(scenario).size(), scenario + ' gets one escalation comment');
    }

    static void assertNotEscalated(CaseFixtures fixtures, String scenario) {
        System.assertEquals(false, fixtures.reload(scenario).IsEscalated, scenario + ' is not escalated');
        System.assertEquals(0, fixtures.escalationComments(scenario).size(), scenario + ' gets no escalation comment');
    }

    @isTest
    static void escalatesEveryBreachedCase() {
        CaseFixtures fixtures = provision(50);
        Test.startTest();
        Integer escalated = new CaseSlaEscalation(fixtures.asOf).run();
        Test.stopTest();
        System.assertEquals(13, escalated, 'seven scenario and six bulk cases breach');
    }

    @isTest
    static void escalateAllFromFlow() {
        CaseFixtures fixtures = provision(0);
        Test.startTest();
        CaseSlaEscalation.escalateAll();
        Test.stopTest();
        assertNotEscalated(fixtures, 'highBreached');
    }

    @isTest
    static void highPriorityBreached() {
        CaseFixtures fixtures = provisionAndRun();
        assertEscalatedTo(fixtures, 'highBreached', 'High', UserInfo.getUserId());
        CaseComment comment = fixtures.escalationComments('highBreached')[0];
        System.assertEquals('Escalated: no first response within 4 business hours', comment.CommentBody, 'example 1 comment');
        System.assertEquals(false, comment.IsPublished, 'example 1 comment is private');
    }

    @isTest
    static void mediumPriorityRaised() {
        CaseFixtures fixtures = provisionAndRun();
        assertEscalatedTo(fixtures, 'mediumBreached', 'High', UserInfo.getUserId());
    }

    @isTest
    static void lowPriorityWithinTarget() {
        CaseFixtures fixtures = provisionAndRun();
        assertNotEscalated(fixtures, 'lowWithinTarget');
    }

    @isTest
    static void publicReplyCountsAsResponse() {
        CaseFixtures fixtures = provisionAndRun();
        assertNotEscalated(fixtures, 'publicReply');
    }

    @isTest
    static void privateNoteIsNoResponse() {
        CaseFixtures fixtures = provisionAndRun();
        assertEscalatedTo(fixtures, 'privateNoteOnly', 'High', UserInfo.getUserId());
    }

    @isTest
    static void hotAccountGoesToAccountOwner() {
        CaseFixtures fixtures = provisionAndRun();
        assertEscalatedTo(fixtures, 'hotAccount', 'High', fixtures.accountOwner.Id);
    }

    @isTest
    static void inactiveAccountOwnerKeepsCaseOwner() {
        CaseFixtures fixtures = provisionAndRun();
        assertEscalatedTo(fixtures, 'inactiveAccountOwner', 'High', UserInfo.getUserId());
    }

    @isTest
    static void alreadyEscalatedUntouched() {
        CaseFixtures fixtures = provisionAndRun();
        System.assertEquals(UserInfo.getUserId(), fixtures.reload('alreadyEscalated').OwnerId, 'example 7 keeps its owner');
        System.assertEquals(0, fixtures.escalationComments('alreadyEscalated').size(), 'example 7 comment');
    }

    @isTest
    static void closedCaseUntouched() {
        CaseFixtures fixtures = provisionAndRun();
        assertNotEscalated(fixtures, 'closed');
    }

    @isTest
    static void noAccountKeepsCaseOwner() {
        CaseFixtures fixtures = provisionAndRun();
        assertEscalatedTo(fixtures, 'noAccount', 'High', UserInfo.getUserId());
    }

    @isTest
    static void rolledUpHotAccountGoesToAccountOwner() {
        CaseFixtures fixtures = provision(50);
        new AccountHealthRollup(new Map<String, String>{'Name' => 'Rolled Up Hot Account'}).run();
        Test.startTest();
        new CaseSlaEscalation(fixtures.asOf).run();
        Test.stopTest();
        assertEscalatedTo(fixtures, 'rolledUpHot', 'High', fixtures.accountOwner.Id);
    }

    @isTest
    static void rerunAddsNoSecondComment() {
        CaseFixtures fixtures = provision(50);
        new CaseSlaEscalation(fixtures.asOf).run();
        Test.startTest();
        Integer escalated = new CaseSlaEscalation(fixtures.asOf).run();
        Test.stopTest();
        System.assertEquals(0, escalated, 'rerun escalates nothing');
        System.assertEquals(1, fixtures.escalationComments('highBreached').size(), 'example 9 rerun');
    }

    @isTest
    static void headroomAt200Cases() {
        CaseFixtures fixtures = provision(189);
        Test.startTest();
        Integer escalated = new CaseSlaEscalation(fixtures.asOf).run();
        Test.stopTest();
        System.assertEquals(27, escalated, '7 scenario and 20 bulk cases breach');
    }
}
