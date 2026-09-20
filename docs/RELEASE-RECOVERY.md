# Recovering an interrupted release

The project owner sees **Interrupted releases** on **More → Releases**.
The initial loading state runs a read-only publication inventory outside HTTP
handling. It checks the current database, sealed bytes and Git evidence, then
returns only that project's findings. A non-owner cannot call this endpoint;
authority is checked again after the asynchronous audit finishes. Responses are
private and never cached.

The check can find a native seal written before the journal was prepared, a
prepared release before its protected tag, and a tagged release before database
finalization. The UI displays the original tag, title and exact source version.
Only the original publisher can use its resume action. Older or contradictory
evidence remains available to the operator; the UI never invents a replacement.

**Resume this release** posts the original tag with `resume_only: true` and
`recovery_manifest_sha256`. The existing publication flow verifies that exact
seal and original publisher, reuses original metadata/bytes, creates or verifies
the protected tag, and finalizes the journal. Missing evidence or a changed
manifest identity returns a conflict before any new build. Newer game edits
cannot enter the resumed release. Existing published tags still refuse a second
publication.

A network error does not prove whether the last step completed. **Check saved
state** refreshes the report before retry. Leaving the page prevents a late
response from replacing the current screen. A live audit can observe a release
still in progress; it is not a synchronized backup and does not replace the
stopped-writer procedure in [Publication inventory](PUBLICATION-INVENTORY.md).

The full inventory runs in one of the two bounded vault workers. Unavailable
stores or occupied workers show a retry state rather than a false empty result.
Storage staging remnants require an operator check. This page does not repair
files, reclaim disk space, rotate credentials, or change another project's data.
