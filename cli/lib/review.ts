import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ascentDir, REPO_ROOT } from "./ascent.ts";
import { AuditReply } from "./audit.ts";

const TEMPLATE = join(REPO_ROOT, "cli/review.html");

const PLACEHOLDER = "/*DATA*/null";

/** Renders an anchor's findings into review.html beside them, replacing the previous one, and returns its path. */
export function writeReview(name: string, findings = join(ascentDir(name), "anchor", "findings.json")): string {
  const text = readFileSync(findings, "utf8");
  const reply = AuditReply.parse(JSON.parse(text));
  const reviewId = `${name}:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
  const data = JSON.stringify({ name, reviewId, source: relative(REPO_ROOT, findings), ...reply }).replaceAll("<", "\\u003c");
  const out = join(ascentDir(name), "anchor", "review.html");
  writeFileSync(
    out,
    readFileSync(TEMPLATE, "utf8").replace(PLACEHOLDER, () => data)
  );
  return out;
}
