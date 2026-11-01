public class CaseSlaEscalation {
    Datetime asOf;
    Integer casesEscalated = 0;
    List<String> escalationLog = new List<String>();

    public CaseSlaEscalation() {
        this(Datetime.now());
    }

    public CaseSlaEscalation(Datetime asOf) {
        this.asOf = asOf;
    }

    public Integer run() {
        String query = 'SELECT Id, CaseNumber, Subject, Status, Priority, Origin, Reason, Type, OwnerId, AccountId, Account.Name, '
                + 'Account.Rating, ContactId, ContactEmail, SuppliedEmail, BusinessHoursId, IsEscalated, IsClosed, CreatedDate, '
                + 'LastModifiedDate, Description FROM Case WHERE IsClosed = false';
        System.debug('Case query: ' + query);
        List<Case> openCases = Database.query(query);
        List<CaseComment> allComments = [
                SELECT Id, ParentId, IsPublished, CommentBody, CreatedDate, CreatedById
                FROM CaseComment
        ];
        BusinessHours defaultHours = [SELECT Id, Name, IsDefault, TimeZoneSidKey FROM BusinessHours WHERE IsDefault = true];
        System.debug('Open cases: ' + openCases.size() + ', comments: ' + allComments.size());

        for (Case c : openCases) {
            System.debug('Checking case ' + c.CaseNumber);
            if (Schema.getGlobalDescribe().get('Case').getDescribe().isUpdateable()) {
                if (Schema.sObjectType.CaseComment.isCreateable()) {
                    if (c.IsEscalated == false) {
                        Id hoursId = c.BusinessHoursId;
                        if (hoursId == null) {
                            hoursId = defaultHours.Id;
                        }
                        Long ageMillis = BusinessHours.diff(hoursId, c.CreatedDate, asOf);
                        Decimal ageHours = Decimal.valueOf(ageMillis) / 1000 / 60 / 60;
                        Map<String, Integer> targets = new Map<String, Integer>{'High' => 4, 'Medium' => 8, 'Low' => 24};
                        Integer target = 24;
                        if (targets.containsKey(c.Priority)) {
                            target = targets.get(c.Priority);
                        }
                        System.debug(c.CaseNumber + ' age=' + ageHours + ' target=' + target);
                        if (ageHours >= target) {
                            Boolean responded = false;
                            for (CaseComment comment : allComments) {
                                if (comment.ParentId == c.Id) {
                                    if (comment.IsPublished == true) {
                                        responded = true;
                                    }
                                }
                            }
                            if (responded == false) {
                                Case latest = [SELECT Id, Priority, Status, OwnerId, IsEscalated FROM Case WHERE Id = :c.Id];
                                String newPriority = latest.Priority;
                                if (latest.Priority == 'Low') {
                                    newPriority = 'Medium';
                                } else if (latest.Priority == 'Medium') {
                                    newPriority = 'High';
                                }
                                Case priorityUpdate = new Case(Id = c.Id, Priority = newPriority);
                                update priorityUpdate;

                                Account acc = null;
                                if (c.AccountId != null) {
                                    acc = Database.query('SELECT Id, Name, Rating, OwnerId, Type, Industry FROM Account WHERE Id = \'' + c.AccountId + '\'');
                                }
                                Id newOwnerId = latest.OwnerId;
                                if (acc != null) {
                                    User accountOwner = Database.query('SELECT Id, Name, Email, IsActive, ProfileId FROM User WHERE Id = \'' + acc.OwnerId + '\'');
                                    if (acc.Rating == 'Hot') {
                                        if (accountOwner.IsActive == true) {
                                            newOwnerId = accountOwner.Id;
                                        }
                                    }
                                }
                                Case ownerUpdate = new Case(Id = c.Id, OwnerId = newOwnerId);
                                update ownerUpdate;
                                Case statusUpdate = new Case(Id = c.Id, Status = 'Escalated', IsEscalated = true);
                                update statusUpdate;
                                c.Priority = newPriority;
                                c.OwnerId = newOwnerId;
                                c.Status = 'Escalated';
                                c.IsEscalated = true;

                                Integer commentTarget = targets.get(newPriority);
                                try {
                                    insert new CaseComment(
                                            ParentId = c.Id,
                                            IsPublished = false,
                                            CommentBody = 'Escalated: no first response within ' + commentTarget + ' business hours'
                                    );
                                } catch (Exception e) {
                                }
                                casesEscalated = casesEscalated + 1;
                                escalationLog.add(c.CaseNumber + ' escalated to ' + newOwnerId);
                                System.debug('Escalated ' + c.CaseNumber);
                            }
                        }
                    }
                }
            }
        }
        List<Case> casesToUpdate = new List<Case>();
        for (Case c : openCases) {
            casesToUpdate.add(new Case(Id = c.Id, Priority = c.Priority, OwnerId = c.OwnerId, Status = c.Status, IsEscalated = c.IsEscalated));
        }
        update casesToUpdate;
        System.debug(String.join(escalationLog, '\n'));
        System.debug('Cases escalated: ' + casesEscalated);
        return casesEscalated;
    }

    /**
     * @description Escalates every open case as of now. Invoked from a schedule-triggered Flow, which also gives
     * Salesforce Graph Engine an entry point to analyse.
     */
    @InvocableMethod(label='Escalate Case SLAs' description='Escalates open cases past their first response target')
    public static void escalateAll() {
        new CaseSlaEscalation().run();
    }
}
