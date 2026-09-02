import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Keep this sentence identical to the visible registration control. It is
// preserved beside each policy snapshot so the action being recorded is exact.
export const POLICY_ACCEPTANCE_NOTICE =
  "I agree to the Forge Terms and Community Rules, and acknowledge the Privacy Notice.";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const policySetId = ({ terms_sha256, privacy_sha256, community_sha256, notice_sha256 }) =>
  sha256(JSON.stringify({ version: 1, terms: terms_sha256,
    privacy: privacy_sha256, community: community_sha256, notice: notice_sha256 }));

export function renderPolicyText(text, { operator, contact }) {
  return String(text).replaceAll("{{OPERATOR}}", String(operator)).replaceAll("{{CONTACT}}", String(contact));
}

export function makePolicySet({ terms, privacy, community, notice = POLICY_ACCEPTANCE_NOTICE }) {
  const texts = {
    terms_text: String(terms),
    privacy_text: String(privacy),
    community_text: String(community),
    notice_text: String(notice),
  };
  const set = { ...texts,
    terms_sha256: sha256(texts.terms_text), privacy_sha256: sha256(texts.privacy_text),
    community_sha256: sha256(texts.community_text), notice_sha256: sha256(texts.notice_text) };
  return { ...set, id: policySetId(set) };
}

export function loadRegistrationPolicySet(policyDirectory, { operator, contact }) {
  const read = name => renderPolicyText(readFileSync(join(policyDirectory, `${name}.md`), "utf8"),
    { operator, contact });
  return makePolicySet({ terms: read("terms"), privacy: read("privacy"), community: read("community") });
}

export function validPolicySet(set) {
  if (!set || typeof set !== "object") return false;
  for (const key of ["terms_text", "privacy_text", "community_text", "notice_text"])
    if (typeof set[key] !== "string") return false;
  const expected = { terms_sha256: sha256(set.terms_text), privacy_sha256: sha256(set.privacy_text),
    community_sha256: sha256(set.community_text), notice_sha256: sha256(set.notice_text) };
  if (!["terms_sha256", "privacy_sha256", "community_sha256", "notice_sha256"]
    .every(key => set[key] === expected[key])) return false;
  return set.id === policySetId(expected);
}
