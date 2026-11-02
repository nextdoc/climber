/**
 * @description Normalises contact email addresses so the same address is always stored the same way.
 */
public with sharing class ContactEmailNormalizer {

    /**
     * @description Trims and lowercases each contact's Email, and clears an Email that is only whitespace.
     * @param contacts the contacts to normalise in place
     * @return the number of contacts whose Email changed
     */
    public Integer normalize(List<Contact> contacts) {
        Integer changed = 0;
        for (Contact person : contacts) {
            String normalized = String.isBlank(person.Email) ? null : person.Email.trim().toLowerCase();
            // Apex == on strings ignores case, so equals detects a lowercasing change.
            Boolean differs = person.Email == null ? normalized != null : !person.Email.equals(normalized);
            if (differs) {
                person.Email = normalized;
                changed++;
            }
        }
        return changed;
    }
}
