// Not @isTest so the provisioning can be reused outside test classes.
public class CaseFixtures {
    public Map<String, Case> casesByScenario = new Map<String, Case>();
    public List<Case> bulkCases = new List<Case>();
    public Datetime asOf;
    public User accountOwner;
    public User formerOwner;

    /**
     * @description Inserts the two account owners. Users are setup objects, so tests call this inside System.runAs.
     */
    public void insertAccountOwners() {
        Id profileId = [SELECT Id FROM Profile WHERE Name = 'Standard User'].Id;
        accountOwner = newUser(profileId, 'Owner');
        formerOwner = newUser(profileId, 'Former');
        insert new List<User>{accountOwner, formerOwner};
    }

    /**
     * @description Deactivates the former owner after provision gives it an account, since inactive users cannot own new records.
     */
    public void deactivateFormerOwner() {
        update new User(Id = formerOwner.Id, IsActive = false);
    }

    public User newUser(Id profileId, String lastName) {
        String unique = lastName.toLowerCase() + Crypto.getRandomInteger();
        return new User(
                LastName = lastName,
                Alias = lastName.left(8),
                Email = unique + '@example.com',
                Username = unique + '@sla.example.com',
                ProfileId = profileId,
                TimeZoneSidKey = 'America/Los_Angeles',
                LocaleSidKey = 'en_US',
                EmailEncodingKey = 'UTF-8',
                LanguageLocaleKey = 'en_US'
        );
    }

    /**
     * @description Inserts one case per requirements example, keyed by scenario name, plus bulk cases for volume.
     * Every account but the former owner's belongs to accountOwner, so a case that keeps its owner differs from one
     * reassigned to the account owner. Sets asOf to 10 business hours from now, so High and Medium cases without a public reply have breached.
     * @param bulkCaseCount number of bulk cases, one High and one Medium in every 10, with a public reply on every other block of 10
     */
    public void provision(Integer bulkCaseCount) {
        Account hotAccount = new Account(Name = 'Hot Support Account', Rating = 'Hot', OwnerId = accountOwner.Id);
        Account warmAccount = new Account(Name = 'Warm Support Account', Rating = 'Warm', OwnerId = accountOwner.Id);
        Account rolledUpAccount = new Account(Name = 'Rolled Up Hot Account', OwnerId = accountOwner.Id);
        Account formerOwnerAccount = new Account(Name = 'Former Owner Hot Account', Rating = 'Hot', OwnerId = formerOwner.Id);
        insert new List<Account>{hotAccount, warmAccount, rolledUpAccount, formerOwnerAccount};
        insert new Opportunity(
                AccountId = rolledUpAccount.Id,
                Name = 'Rolled Up Win',
                Amount = 150000,
                StageName = 'Closed Won',
                CloseDate = Date.today().addDays(-30)
        );
        insert new Task(WhatId = rolledUpAccount.Id, Subject = 'Call', Status = 'Completed', ActivityDate = Date.today().addDays(-7));

        casesByScenario.put('highBreached', openCase(warmAccount, 'High'));
        casesByScenario.put('mediumBreached', openCase(warmAccount, 'Medium'));
        casesByScenario.put('lowWithinTarget', openCase(warmAccount, 'Low'));
        casesByScenario.put('publicReply', openCase(warmAccount, 'High'));
        casesByScenario.put('privateNoteOnly', openCase(warmAccount, 'High'));
        casesByScenario.put('hotAccount', openCase(hotAccount, 'High'));
        casesByScenario.put('alreadyEscalated', openCase(warmAccount, 'High'));
        casesByScenario.get('alreadyEscalated').Status = 'Escalated';
        casesByScenario.get('alreadyEscalated').IsEscalated = true;
        casesByScenario.put('closed', openCase(warmAccount, 'High'));
        casesByScenario.get('closed').Status = 'Closed';
        casesByScenario.put('noAccount', openCase(null, 'High'));
        casesByScenario.put('rolledUpHot', openCase(rolledUpAccount, 'High'));
        casesByScenario.put('inactiveAccountOwner', openCase(formerOwnerAccount, 'High'));
        for (Integer i = 0; i < bulkCaseCount; i++) {
            Integer slot = Math.mod(i, 10);
            bulkCases.add(openCase(warmAccount, slot == 0 ? 'High' : slot == 1 ? 'Medium' : 'Low'));
        }
        List<Case> allCases = new List<Case>(casesByScenario.values());
        allCases.addAll(bulkCases);
        insert allCases;

        List<CaseComment> comments = new List<CaseComment>{
                comment(casesByScenario.get('publicReply').Id, true),
                comment(casesByScenario.get('privateNoteOnly').Id, false)
        };
        for (Integer i = 0; i < bulkCases.size(); i++) {
            comments.add(comment(bulkCases[i].Id, false));
            if (Math.mod(i / 10, 2) == 1) {
                comments.add(comment(bulkCases[i].Id, true));
            }
        }
        insert comments;

        Id defaultHoursId = [SELECT Id FROM BusinessHours WHERE IsDefault = true].Id;
        asOf = BusinessHours.add(defaultHoursId, Datetime.now(), 10 * 3600000L);
    }

    public Case openCase(Account account, String priority) {
        return new Case(
                AccountId = account?.Id,
                Subject = priority + ' priority case',
                Priority = priority,
                Status = 'New',
                Origin = 'Web'
        );
    }

    public CaseComment comment(Id caseId, Boolean isPublic) {
        return new CaseComment(ParentId = caseId, IsPublished = isPublic, CommentBody = isPublic ? 'Reply to customer' : 'Internal note');
    }

    public Case reload(String scenario) {
        return [SELECT Id, Status, Priority, IsEscalated, OwnerId FROM Case WHERE Id = :casesByScenario.get(scenario).Id];
    }

    public List<CaseComment> escalationComments(String scenario) {
        return [
                SELECT Id, CommentBody, IsPublished
                FROM CaseComment
                WHERE ParentId = :casesByScenario.get(scenario).Id AND CommentBody LIKE 'Escalated:%'
        ];
    }

    public Set<Id> bulkCaseIds() {
        return new Map<Id, Case>(bulkCases).keySet();
    }
}
