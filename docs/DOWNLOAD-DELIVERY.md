# Verified download delivery

Frozen exports and release downloads verify the complete expected byte count
and SHA-256 before sending any artifact bytes. The gateway copies in bounded
asynchronous chunks into an owner-only temporary file, immediately unlinks its
name, then streams from that same open inode. A changed source after verification
cannot change the response. Cancellation, completion, errors and process exit
release the temporary storage; snapshots never become durable release evidence.

Two downloads can verify or stream concurrently, with four waiting requests and
a 30-second queue deadline. Extra requests fail with HTTP 503. Queue errors carry
`Retry-After: 2` when encountered in delivery. Each artifact is limited by the
existing `EXPORT_MAX_OUTPUT_BYTES` budget (512 MiB by default, minimum 1 MiB),
so active snapshots consume at most twice that budget on the cache filesystem.
Allow disk headroom for the original exports, snapshots and ongoing render jobs.
These are per-process limits, not a distributed admission system.

Range requests are deliberately ignored: the response is the full verified
object, HTTP 200, with `Accept-Ranges: none` and an exact `Content-Length`.
No partial object is served before complete verification. Authentication,
project visibility, cache policy, frozen release/tag/manifest binding and
private tabletop restrictions remain enforced before delivery.

Large files therefore have a verification delay before the first byte. Export
job progress still describes the build; it does not claim that the subsequent
download has completed. A disconnected client cancels verification or streaming
and releases its slot. Shared export jobs and a release publication already in
progress continue; reopening Releases and checking the preserved state is the
safe next step.

Whole-release vault sealing and recovery verification use at most two isolated
workers, with a three-minute deadline and explicit busy/error responses.
They preserve the existing create-only manifests, original publication identity
and byte equality rules. Bounded hashing also replaces whole-blob allocation in
vault inventory and whole-release verification. The legacy synchronous
`readArtifact` API remains for operator tools; HTTP delivery does not use it.
Exporter result verification reads files in bounded asynchronous chunks too.

Local evidence from `tools/test-verified-download.mjs`: two simultaneous
256 MiB files, roughly 58 MiB additional RSS, 16 ms worst health response,
4 ms sampled event-loop lag, and about 750 ms to first byte on the developer
machine. These are measured fixture results, not host capacity guarantees.
The test also checks corruption before response bytes, source replacement,
size/concurrency limits, queued cancellation, cancellation during verification
and delivery, and the range policy. The complete product and exact-image
recovery gates must separately qualify the integrated candidate.
