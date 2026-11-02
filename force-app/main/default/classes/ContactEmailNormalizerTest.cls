@isTest
private class ContactEmailNormalizerTest {

    @isTest
    static void lowercasesMixedCase() {
        Contact person = new Contact(LastName = 'Mixed', Email = 'Jane.Doe@Example.COM');
        System.assertEquals(1, new ContactEmailNormalizer().normalize(new List<Contact>{person}), 'one contact changed');
        System.assertEquals('jane.doe@example.com', person.Email, 'email lowercased');
    }

    @isTest
    static void trimsSurroundingWhitespace() {
        Contact person = new Contact(LastName = 'Spaced', Email = '  jane@example.com \t');
        new ContactEmailNormalizer().normalize(new List<Contact>{person});
        System.assertEquals('jane@example.com', person.Email, 'email trimmed');
    }

    @isTest
    static void clearsWhitespaceOnlyEmail() {
        Contact person = new Contact(LastName = 'Blank', Email = '   ');
        System.assertEquals(1, new ContactEmailNormalizer().normalize(new List<Contact>{person}), 'blank email counts as changed');
        System.assertEquals(null, person.Email, 'blank email cleared');
    }

    @isTest
    static void leavesNullAndNormalisedEmailsAlone() {
        List<Contact> people = new List<Contact>{
                new Contact(LastName = 'None'),
                new Contact(LastName = 'Clean', Email = 'clean@example.com')
        };
        System.assertEquals(0, new ContactEmailNormalizer().normalize(people), 'nothing to change');
        System.assertEquals(null, people[0].Email, 'null email stays null');
        System.assertEquals('clean@example.com', people[1].Email, 'normalised email unchanged');
    }

    @isTest
    static void headroomAt200Contacts() {
        List<Contact> people = new List<Contact>();
        for (Integer i = 0; i < 200; i++) {
            people.add(new Contact(LastName = 'Bulk ' + i, Email = ' Bulk' + i + '@Example.com '));
        }
        Test.startTest();
        Integer changed = new ContactEmailNormalizer().normalize(people);
        Test.stopTest();
        System.assertEquals(200, changed, 'every contact changed');
        insert people;
        System.assertEquals(200, [SELECT COUNT() FROM Contact WHERE Id IN :people AND Email LIKE 'bulk%@example.com'], 'saved normalised');
    }
}
