public class ScenarioFailedException extends Exception {}

/**
 * The test methods as scenarios. The scenarios that only read the result of provisioning and one run share them,
 * as each test would see them. The rolled up account is rated before that run, which only changes its own case.
 */
public class CaseSlaEscalationTest {
    CaseFixtures fixtures;
    Integer escalated;
    public Map<String, String> results = new Map<String, String>();

    // System.assertEquals failures cannot be caught, so each scenario could not report on its own.
    void assertEquals(Object expected, Object actual, String message) {
        if (expected != actual) {
            throw new ScenarioFailedException(message + ': expected ' + expected + ', got ' + actual);
        }
    }

    // Logs the run's governor limit use, as Test.startTest and Test.stopTest would scope it.
    Integer measuredRun(String scenario, CaseSlaEscalation escalation) {
        Map<String, Integer> before = limitUsage();
        Integer count = escalation.run();
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
        System.debug('LIMITS|CaseSlaEscalationTest.' + scenario + '|' + JSON.serialize(usage));
        return count;
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

    // Outside a test the org's one spare Salesforce license allows one new user, and deactivating a user alongside
    // case data is mixed DML, so the running user stands in for the former owner and stays active.
    void provision(Integer bulkCaseCount) {
        fixtures = new CaseFixtures();
        fixtures.accountOwner = fixtures.newUser([SELECT Id FROM Profile WHERE Name = 'Standard User'].Id, 'Owner');
        insert fixtures.accountOwner;
        fixtures.formerOwner = new User(Id = UserInfo.getUserId());
        fixtures.provision(bulkCaseCount);
    }

    void assertEscalatedTo(String scenario, String priority, Id owner) {
        Case escalatedCase = fixtures.reload(scenario);
        assertEquals(true, escalatedCase.IsEscalated, scenario + ' is escalated');
        assertEquals('Escalated', escalatedCase.Status, scenario + ' status');
        assertEquals(priority, escalatedCase.Priority, scenario + ' priority');
        assertEquals(owner, escalatedCase.OwnerId, scenario + ' owner');
        assertEquals(1, fixtures.escalationComments(scenario).size(), scenario + ' gets one escalation comment');
    }

    void assertNotEscalated(String scenario) {
        assertEquals(false, fixtures.reload(scenario).IsEscalated, scenario + ' is not escalated');
        assertEquals(0, fixtures.escalationComments(scenario).size(), scenario + ' gets no escalation comment');
    }

    void escalatesEveryBreachedCase() {
        assertEquals(13, escalated, 'seven scenario and six bulk cases breach');
    }

    void highPriorityBreached() {
        assertEscalatedTo('highBreached', 'High', UserInfo.getUserId());
        CaseComment comment = fixtures.escalationComments('highBreached')[0];
        assertEquals('Escalated: no first response within 4 business hours', comment.CommentBody, 'example 1 comment');
        assertEquals(false, comment.IsPublished, 'example 1 comment is private');
    }

    void mediumPriorityRaised() {
        assertEscalatedTo('mediumBreached', 'High', UserInfo.getUserId());
    }

    void lowPriorityWithinTarget() {
        assertNotEscalated('lowWithinTarget');
    }

    void publicReplyCountsAsResponse() {
        assertNotEscalated('publicReply');
    }

    void privateNoteIsNoResponse() {
        assertEscalatedTo('privateNoteOnly', 'High', UserInfo.getUserId());
    }

    void hotAccountGoesToAccountOwner() {
        assertEscalatedTo('hotAccount', 'High', fixtures.accountOwner.Id);
    }

    void alreadyEscalatedUntouched() {
        assertEquals(UserInfo.getUserId(), fixtures.reload('alreadyEscalated').OwnerId, 'example 7 keeps its owner');
        assertEquals(0, fixtures.escalationComments('alreadyEscalated').size(), 'example 7 comment');
    }

    void closedCaseUntouched() {
        assertNotEscalated('closed');
    }

    void noAccountKeepsCaseOwner() {
        assertEscalatedTo('noAccount', 'High', UserInfo.getUserId());
    }

    void rolledUpHotAccountGoesToAccountOwner() {
        assertEscalatedTo('rolledUpHot', 'High', fixtures.accountOwner.Id);
    }

    void rerunAddsNoSecondComment() {
        Integer rerunEscalated = measuredRun('rerunAddsNoSecondComment', new CaseSlaEscalation(fixtures.asOf));
        assertEquals(0, rerunEscalated, 'rerun escalates nothing');
        assertEquals(1, fixtures.escalationComments('highBreached').size(), 'example 9 rerun');
    }

    void headroomAt200Cases() {
        provision(189);
        Integer count = measuredRun('headroomAt200Cases', new CaseSlaEscalation(fixtures.asOf));
        assertEquals(27, count, '7 scenario and 20 bulk cases breach');
    }

    void scenario(String name) {
        try {
            if (name == 'escalatesEveryBreachedCase') escalatesEveryBreachedCase();
            else if (name == 'highPriorityBreached') highPriorityBreached();
            else if (name == 'mediumPriorityRaised') mediumPriorityRaised();
            else if (name == 'lowPriorityWithinTarget') lowPriorityWithinTarget();
            else if (name == 'publicReplyCountsAsResponse') publicReplyCountsAsResponse();
            else if (name == 'privateNoteIsNoResponse') privateNoteIsNoResponse();
            else if (name == 'hotAccountGoesToAccountOwner') hotAccountGoesToAccountOwner();
            else if (name == 'alreadyEscalatedUntouched') alreadyEscalatedUntouched();
            else if (name == 'closedCaseUntouched') closedCaseUntouched();
            else if (name == 'noAccountKeepsCaseOwner') noAccountKeepsCaseOwner();
            else if (name == 'rolledUpHotAccountGoesToAccountOwner') rolledUpHotAccountGoesToAccountOwner();
            else if (name == 'rerunAddsNoSecondComment') rerunAddsNoSecondComment();
            else if (name == 'headroomAt200Cases') headroomAt200Cases();
            results.put(name, 'PASS');
        } catch (Exception e) {
            results.put(name, 'FAIL ' + e.getTypeName() + ': ' + e.getMessage());
        }
        System.debug('TEST|CaseSlaEscalationTest.' + name + '|' + results.get(name));
    }

    // Each test starts with no org data. The scratch org's sample account has an entitlement that blocks its delete.
    void emptyOrg() {
        delete [SELECT Id FROM Entitlement];
        delete [SELECT Id FROM Case];
        delete [SELECT Id FROM Account];
    }

    public void runCorrectness() {
        emptyOrg();
        provision(50);
        new AccountHealthRollup(new Map<String, String>{'Name' => 'Rolled Up Hot Account'}).run();
        escalated = measuredRun('escalatesEveryBreachedCase', new CaseSlaEscalation(fixtures.asOf));
        for (String name : new List<String>{
                'escalatesEveryBreachedCase', 'highPriorityBreached', 'mediumPriorityRaised', 'lowPriorityWithinTarget',
                'publicReplyCountsAsResponse', 'privateNoteIsNoResponse', 'hotAccountGoesToAccountOwner', 'alreadyEscalatedUntouched',
                'closedCaseUntouched', 'noAccountKeepsCaseOwner', 'rolledUpHotAccountGoesToAccountOwner', 'rerunAddsNoSecondComment'
        }) {
            scenario(name);
        }
        System.debug('TEST|CaseSlaEscalationTest.escalateAllFromFlow|SKIP static @InvocableMethod is not allowed in anonymous Apex');
        System.debug('TEST|CaseSlaEscalationTest.inactiveAccountOwnerKeepsCaseOwner|SKIP deactivating a user alongside case data is mixed DML in anonymous Apex');
    }

    public void runHeadroom() {
        emptyOrg();
        scenario('headroomAt200Cases');
    }
}
