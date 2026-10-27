import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./ascent.ts";
import { ExtractError, extract } from "./extract.ts";

const classFile = (name: string) => {
  const file = join(REPO_ROOT, "force-app/main/default/classes", `${name}.cls`);
  return [file, readFileSync(file, "utf8")] as const;
};

describe("extract", () => {
  test("drops the uncalled @InvocableMethod from the sample class and keeps everything else", () => {
    const [file, text] = classFile("AccountHealthRollup");
    const start = text.indexOf("    /**\n     * @description Rates every account in the org. Invoked");
    const end = text.indexOf("    /**", start + 1);
    const { code, applied } = extract(file, text);
    expect(applied).toEqual(["drop-uncalled-static-methods"]);
    expect(code).toBe(text.slice(0, start) + text.slice(end));
  });

  test("copies a class that anonymous Apex accepts unchanged", () => {
    const [file, text] = classFile("Fixtures");
    expect(extract(file, text)).toEqual({ code: text, applied: [] });
  });

  test("makes a called static method an instance method without its static-only annotation", () => {
    const text = `public class A {
    public Integer run() { return twice(2); }
    @AuraEnabled
    public static Integer twice(Integer n) { return n * 2; }
}
`;
    const { code, applied } = extract("A.cls", text);
    expect(applied).toEqual(["static-to-instance"]);
    expect(code).toContain("    public Integer twice(Integer n)");
    expect(code).not.toContain("AuraEnabled");
  });

  test("makes a static constant an instance constant", () => {
    const { code } = extract("A.cls", "public class A {\n    static final Integer LIMIT_SIZE = 200;\n    Integer size() { return LIMIT_SIZE; }\n}\n");
    expect(code).toContain("    final Integer LIMIT_SIZE = 200;");
  });

  test("drops the virtual class modifier", () => {
    expect(extract("A.cls", "public virtual class A {}\n").code).toBe("public class A {}\n");
  });

  test.each([
    ["a static field", "public class A {\n    static Integer count = 0;\n}\n", "static field"],
    ["a nested class", "public class A {\n    class B {}\n}\n", "nested type"],
    ["a static initializer", "public class A {\n    static { System.debug('x'); }\n}\n", "static initializer"],
    ["a qualified static call", "public class A {\n    void run() { A.go(); }\n    static void go() {}\n}\n", "referenced as A.go"],
    ["a syntax error", "public class A {\n", "A.cls"]
  ])("rejects %s", (_, text, message) => {
    expect(() => extract("A.cls", text)).toThrow(ExtractError);
    expect(() => extract("A.cls", text)).toThrow(message);
  });
});
