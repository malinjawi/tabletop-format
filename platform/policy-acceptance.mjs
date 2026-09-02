import { createHash } from "node:crypto";

// Keep this sentence identical to the visible registration control. It is
// preserved beside each policy snapshot so the action being recorded is exact.
export const POLICY_ACCEPTANCE_NOTICE =
  "I agree to the Forge Terms and Community Rules, and acknowledge the Privacy Notice.";

const sha256 = value => createHash("sha256").update(value).digest("hex");

export function makePolicySet({ terms, privacy, community }) {
  const set = {
    terms_text: String(terms),
    privacy_text: String(privacy),
    community_text: String(community),
    notice_text: POLICY_ACCEPTANCE_NOTICE,
  };
  set.terms_sha256 = sha256(set.terms_text);
  set.privacy_sha256 = sha256(set.privacy_text);
  set.community_sha256 = sha256(set.community_text);
  set.notice_sha256 = sha256(set.notice_text);
  set.id = sha256(JSON.stringify({ version: 1, terms: set.terms_sha256,
    privacy: set.privacy_sha256, community: set.community_sha256, notice: set.notice_sha256 }));
  return set;
}

export function validPolicySet(set) {
  if (!set || typeof set !== "object") return false;
  const expected = makePolicySet({ terms: set.terms_text, privacy: set.privacy_text,
    community: set.community_text });
  return ["id", "terms_sha256", "privacy_sha256", "community_sha256", "notice_sha256", "notice_text"]
    .every(key => set[key] === expected[key]);
}
