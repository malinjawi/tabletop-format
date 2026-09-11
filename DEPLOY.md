# Deploy Forge

Use the maintained [production deployment runbook](deploy/DEPLOY.md) and
[backup/restore procedure](deploy/RESTORE-DRILL.md). For local development,
use [Development setup](docs/DEVELOPMENT.md).

The earlier static/communal beta instructions at this path are retired. They
included nightly data resets and do not describe the current durable product.
Do not use them for a team workspace or persistent game data. Git history retains
them as historical context.

Publishing a qualified image does not deploy a host. Complete the runbook’s
engineering and operator gates before exposing a shared service.
