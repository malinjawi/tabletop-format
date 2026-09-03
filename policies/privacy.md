# Forge controlled-beta privacy notice

Effective: 2026-09-03

Forge stores the account handle, email address, password hash, active-session metadata, exact policy text and hashes accepted during registration, acceptance time and application build, project permissions, reviews, discussions, notifications, playtest records, release receipts, jam submissions, and moderation/audit events needed to operate the service. Raw session tokens are not stored; browser sessions use HttpOnly cookies. Operational logs include request IDs, routes, timings, status codes, and the client address used for abuse controls.

Git repositories and declared LFS assets are the durable game source. Render/export cache is derived. A Google Sheets connection sends the mapped tab snapshots only when attaching, checking, or committing; Forge does not receive Google credentials, formulas from unrelated tabs, or every keystroke. Promotion receipts keep workbook/tab identifiers, revision and content hashes, not the entire rejected draft history.

Service providers may include the deployment host, Forgejo/Postgres host, object storage, email/support provider, and TLS/CDN provider selected by {{OPERATOR}}. Access is limited to operating, securing, backing up, and restoring Forge. Forge does not sell personal data.

Beta retention: expired sessions are removed automatically; operational logs should be retained no longer than 30 days unless needed for security; account/conversation and audit data remain while the account or legal obligation exists; immutable published release and jam receipts remain part of the public provenance record. Ask {{CONTACT}} for access, correction, export, or deletion. Some public Git/release history cannot be rewritten without breaking other contributors’ provenance; Forge will explain what can be removed or de-indexed.

Signed-in participants can use **Download my data** in the account menu for an allowlisted JSON copy of their account, policy receipts, authored discussion and review activity, social state, connector metadata, and operator access events. Authentication secrets, repository snapshots, and generated artifact bodies are excluded. Download each owned project's portable Forge package separately; ask {{CONTACT}} for relevant retained security logs, correction, deletion, or help when account access is unavailable.

Do not place sensitive personal information in game repositories, cards, commit messages, Sheets cells promoted to Forge, or public discussion.
