import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./ascent.ts";
import { ExtractError, extract, stripComments } from "./extract.ts";

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

  test("copies a class that anonymous Apex accepts unchanged apart from its leading comment", () => {
    const [file, text] = classFile("Fixtures");
    expect(extract(file, text)).toEqual({ code: text.slice(text.indexOf("public class")), applied: ["drop-leading-comments"] });
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

  test.each(["with", "without", "inherited"])("drops %s sharing", (keyword) => {
    expect(extract("A.cls", `public ${keyword} sharing class A {}\n`).code).toBe("public class A {}\n");
  });

  test("drops comments before the class", () => {
    expect(extract("A.cls", "/**\n * @description doc\n */\n// note\npublic class A {}\n").code).toBe("public class A {}\n");
  });

  test("hoists a nested class to the top level, unqualifying references and dropping private", () => {
    const text = "public class A {\n    private class B {}\n    A.B make() { return new A.B(); }\n}\n";
    const { code, applied } = extract("A.cls", text);
    expect(applied).toEqual(["hoist-nested-classes"]);
    expect(code).toBe("class B {}\n\npublic class A {\n    B make() { return new B(); }\n}\n");
  });

  test.each([
    ["a static field", "public class A {\n    static Integer count = 0;\n}\n", "static field"],
    ["a nested enum", "public class A {\n    enum B { X }\n}\n", "nested type"],
    ["a static initializer", "public class A {\n    static { System.debug('x'); }\n}\n", "static initializer"],
    ["a qualified static call", "public class A {\n    void run() { A.go(); }\n    static void go() {}\n}\n", "referenced as A.go"],
    ["a syntax error", "public class A {\n", "A.cls"]
  ])("rejects %s", (_, text, message) => {
    expect(() => extract("A.cls", text)).toThrow(ExtractError);
    expect(() => extract("A.cls", text)).toThrow(message);
  });
});

test("stripComments drops comments, indentation and blank lines but keeps strings", () => {
  const text = "/** doc */\npublic class A {\n\n    // note\n    String s = '// not a comment'; /* inline */\n}\n";
  expect(stripComments(text)).toBe("public class A {\nString s = '// not a comment';\n}");
});
