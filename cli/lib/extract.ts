import {
  ApexErrorListener,
  ApexParserFactory,
  type ApexToken,
  type ApexTokenStream,
  type ClassBodyDeclarationContext,
  type ModifierContext,
  type TypeDeclarationContext
} from "@apexdevtools/apex-parser";

/** A parsed Apex type file. */
export type ApexSource = { file: string; text: string; tokens: ApexTokenStream; type: TypeDeclarationContext };

/** Replaces text[start, end) with text. */
export type Edit = { start: number; end: number; text: string };

/** One step that adapts a class for anonymous Apex. Returns no edits when it does not apply, and throws ExtractError when it cannot adapt the class. */
export type Transform = { name: string; edits(source: ApexSource): Edit[] };

export class ExtractError extends Error {}

class CollectingErrorListener extends ApexErrorListener {
  errors: string[] = [];

  apexSyntaxError(line: number, column: number, msg: string) {
    this.errors.push(`${line}:${column} ${msg}`);
  }
}

export function parseType(file: string, text: string): ApexSource {
  const listener = new CollectingErrorListener();
  const { parser } = ApexParserFactory.createLexerAndParser(text, listener);
  const unit = parser.compilationUnit();
  if (listener.errors.length > 0) throw new ExtractError(`${file}: ${listener.errors.join("; ")}`);
  return { file, text, tokens: parser.getTokenStream() as ApexTokenStream, type: unit.typeDeclaration() };
}

export function applyEdits(text: string, edits: Edit[]): string {
  return [...edits].sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);
}

const members = (source: ApexSource): ClassBodyDeclarationContext[] =>
  source.type.classDeclaration()?.classBody().classBodyDeclaration_list() ?? [];

const isStatic = (member: ClassBodyDeclarationContext) => member.modifier_list().some((m) => m.STATIC());

const className = (source: ApexSource) => source.type.classDeclaration()?.id().getText() ?? "";

const describe = (source: ApexSource, member: ClassBodyDeclarationContext) =>
  `${source.file}:${member.start.line} ${member.getText().slice(0, 60)}`;

function defaultTokens(source: ApexSource): ApexToken[] {
  source.tokens.fill();
  return source.tokens.tokens.filter((t) => t.channel === 0 && t.type !== -1);
}

/** Removes a modifier and the whitespace after it, or its whole line when nothing else is on it. */
function removeModifier(source: ApexSource, modifier: ModifierContext): Edit {
  const text = source.text;
  const after = modifier.stop!.stop + 1;
  const next = source.tokens.tokens.slice(modifier.stop!.tokenIndex + 1).find((t) => t.channel === 0);
  const end = next ? next.start : text.length;
  const lineStart = text.lastIndexOf("\n", modifier.start.start - 1) + 1;
  const gap = text.slice(after, end);
  if (text.slice(lineStart, modifier.start.start).trim() === "" && gap.includes("\n")) {
    return { start: lineStart, end: after + gap.lastIndexOf("\n") + 1, text: "" };
  }
  return { start: modifier.start.start, end, text: "" };
}

/** Removes a member with its leading comments, its whole lines, and one blank line after it. */
function removeMember(source: ApexSource, member: ClassBodyDeclarationContext): Edit {
  let first = member.start;
  for (let i = member.start.tokenIndex - 1; i >= 0 && source.tokens.tokens[i].channel !== 0; i--) {
    if (source.tokens.tokens[i].text.trim() !== "") first = source.tokens.tokens[i];
  }
  const text = source.text;
  const start = text.lastIndexOf("\n", first.start - 1) + 1;
  let end = text.indexOf("\n", member.stop!.stop + 1);
  end = end === -1 ? text.length : end + 1;
  const blank = /^[ \t]*\n/.exec(text.slice(end));
  return { start, end: end + (blank?.[0].length ?? 0), text: "" };
}

function memberName(member: ClassBodyDeclarationContext): string | undefined {
  const declaration = member.memberDeclaration();
  return (declaration?.methodDeclaration() ?? declaration?.propertyDeclaration())?.id().getText();
}

/** Whether the class names a member as ClassName.member, which an instance member cannot satisfy. */
function qualifiedReference(source: ApexSource, name: string): boolean {
  const tokens = defaultTokens(source);
  const owner = className(source).toLowerCase();
  return tokens.some(
    (t, i) => t.text.toLowerCase() === owner && tokens[i + 1]?.text === "." && tokens[i + 2]?.text.toLowerCase() === name.toLowerCase()
  );
}

/** Annotations that only static methods may carry. */
const STATIC_ONLY_ANNOTATIONS = new Set([
  "invocablemethod",
  "auraenabled",
  "remoteaction",
  "future",
  "httpget",
  "httppost",
  "httpput",
  "httppatch",
  "httpdelete"
]);

const isStaticOnlyAnnotation = (m: ModifierContext) => STATIC_ONLY_ANNOTATIONS.has(m.annotation()?.id().getText().toLowerCase() ?? "");

/** Rejects what anonymous Apex cannot hold and no transform can safely rewrite. */
export const rejectUnsupported: Transform = {
  name: "reject-unsupported",
  edits(source) {
    for (const member of members(source)) {
      const declaration = member.memberDeclaration();
      if (declaration?.classDeclaration() || declaration?.interfaceDeclaration() || declaration?.enumDeclaration()) {
        throw new ExtractError(`nested type, which anonymous Apex does not allow: ${describe(source, member)}`);
      }
      if (member.STATIC() && member.block()) {
        throw new ExtractError(`static initializer, which anonymous Apex does not allow: ${describe(source, member)}`);
      }
      const finalField = member.modifier_list().some((m) => m.FINAL());
      if (isStatic(member) && (declaration?.fieldDeclaration() || declaration?.propertyDeclaration()) && !finalField) {
        throw new ExtractError(`static field, whose per-transaction state an instance field would not keep: ${describe(source, member)}`);
      }
    }
    return [];
  }
};

/** Drops static methods the class never calls, such as @InvocableMethod entry points. */
export const dropUncalledStaticMethods: Transform = {
  name: "drop-uncalled-static-methods",
  edits(source) {
    const tokens = defaultTokens(source);
    return members(source)
      .filter((m) => isStatic(m) && m.memberDeclaration()?.methodDeclaration())
      .filter((m) => {
        const id = m.memberDeclaration()!.methodDeclaration()!.id().start;
        return !tokens.some((t) => t !== id && t.text.toLowerCase() === id.text.toLowerCase());
      })
      .map((m) => removeMember(source, m));
  }
};

/** Makes the remaining static methods and constants instance members, dropping annotations that require static. */
export const staticToInstance: Transform = {
  name: "static-to-instance",
  edits(source) {
    return members(source)
      .filter(isStatic)
      .flatMap((member) => {
        const name = memberName(member) ?? member.memberDeclaration()?.fieldDeclaration()?.variableDeclarators().getText() ?? "";
        if (qualifiedReference(source, name)) {
          throw new ExtractError(`static member referenced as ${className(source)}.${name}: ${describe(source, member)}`);
        }
        return member
          .modifier_list()
          .filter((m) => m.STATIC() || isStaticOnlyAnnotation(m))
          .map((m) => removeModifier(source, m));
      });
  }
};

/** Drops the virtual class modifier, since classes in anonymous Apex are virtual by default. */
export const dropVirtualClass: Transform = {
  name: "drop-virtual-class",
  edits(source) {
    return source.type
      .modifier_list()
      .filter((m) => m.VIRTUAL())
      .map((m) => removeModifier(source, m));
  }
};

/** Drops with, without and inherited sharing, which anonymous Apex classes do not allow. They run with the running user's sharing. */
export const dropSharing: Transform = {
  name: "drop-sharing",
  edits(source) {
    return source.type
      .modifier_list()
      .filter((m) => m.SHARING())
      .map((m) => removeModifier(source, m));
  }
};

/** Drops comments before the class, which make Streamline misdetect the script as flow mode and wrap the class in a try block. */
export const dropLeadingComments: Transform = {
  name: "drop-leading-comments",
  edits(source) {
    const start = source.type.start.start;
    return start > 0 ? [{ start: 0, end: start, text: "" }] : [];
  }
};

export const TRANSFORMS: Transform[] = [
  rejectUnsupported,
  dropUncalledStaticMethods,
  staticToInstance,
  dropVirtualClass,
  dropSharing,
  dropLeadingComments
];

/** Adapts one Apex type file for the CLASSES section of an anonymous Apex script. */
export function extract(file: string, text: string, transforms: Transform[] = TRANSFORMS): { code: string; applied: string[] } {
  let source = parseType(file, text);
  const applied: string[] = [];
  for (const transform of transforms) {
    const edits = transform.edits(source);
    if (edits.length === 0) continue;
    source = parseType(file, applyEdits(source.text, edits));
    applied.push(transform.name);
  }
  return { code: source.text, applied };
}
