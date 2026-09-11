# Run Forge locally

This is the supported onboarding path for developers. Read the [team handoff](DEVELOPER-HANDOFF.md) for architecture, ownership suggestions, qualification evidence, and the backlog. Read the [creator guide](CREATOR-GUIDE.md) to understand the product before changing it.

## Prerequisites

- macOS or Linux. Windows contributors should use a Linux environment such as WSL2; the complete shell/rendering suite is not qualified on native Windows.
- **Node 24.20.0**, pinned in [.nvmrc](../.nvmrc) and used by CI. Node 20 lacks the required SQLite backend; other Node major versions are outside this qualified toolchain.
- **Python 3.11** with `venv` and `pip`, and Git. Python packages are pinned in [requirements.txt](../requirements.txt).
- Chrome or Chromium. `playwright-core` does not download a browser. For a nonstandard installation, set `CHROME_PATH` to the browser executable before setup, startup, and tests.
- Docker with Compose is needed for production-image, PostgreSQL, and real Forgejo/recovery checks. It is optional for the basic local workspace and focused browser tests.

## First run

```sh
git clone https://github.com/malinjawi/tabletop-format.git
cd tabletop-format
# If you use nvm:
nvm install
nvm use
# If Python 3.11 is not your default python3:
export FORGE_BOOTSTRAP_PYTHON=python3.11
npm run setup:dev
npm run dev
```

If you use a different Node manager, select `.nvmrc`'s version instead of the two `nvm` commands. `FORGE_BOOTSTRAP_PYTHON` can be an absolute path to Python 3.11. Setup creates `.venv`, installs Python pins and npm lockfile dependencies, and checks the toolchain. No global npm packages, database accounts, cloud credentials, or global Git author identity are required to start the local workspace.

Open **http://localhost:8420/**. The terminal shows the application commit and state directory; `-dirty` means uncommitted application changes. Create your own account through the UI; no developer accounts or passwords are bundled. Start with **Ember** or **New game**. Use `npm run dev -- --port 8421` if port 8420 is occupied.

`Ctrl+C` stops the server. Run the same command again to keep working. Restart after application-source changes; this command does not provide a file watcher. Stopping or updating application code does not reseed or reset your games.

## Where your work lives

The launcher creates an ignored **data/dev/** directory once:

| Path | Purpose |
| --- | --- |
| `data/dev/store/` | Separate Git repository with editable game source; initially only CC0 Ember. Browser commits go here, not into the application branch. |
| `data/dev/platform.db` | SQLite accounts, access, collaboration, and publication records. |
| `data/dev/release-vault/` | Durable frozen release bytes and evidence. Keep this with your game data. |
| `data/dev/cache/`, `farm/`, `hub.html` | Generated working files, not substitutes for the release vault. |
| `data/dev/workspace.json` | Initialization marker and seed application version. |

Do not commit or share `data/`, browser profiles, credentials, or runtime archives. To preserve local work, stop Forge and copy the **entire data/dev directory** somewhere safe. This is a local development backup; production has its own coordinated [backup and restore procedure](../deploy/RESTORE-DRILL.md).

One launcher may use a checkout's workspace at a time, even on different ports. A second application clone has its own workspace. After an abnormal launcher termination, startup refuses a stale lock: verify no server still uses that checkout's `data/dev`, then remove only `data/.dev.lock`. A normal stop removes the lock automatically. Do not delete the workspace to solve a lock or port error.

The launcher forces local SQLite/Git, loopback access, and fixture exclusion even if your shell has production variables. Use the maintained [deployment runbook](../deploy/DEPLOY.md) for a shared host; `npm run dev` is not a deployment command. A localhost link from another developer points to their own computer, not yours.

## First product walkthrough

1. Browse Ember's cards and rules; open Help and Design.
2. Register, create your own game or fork Ember, edit a card, and inspect the proof/review before saving.
3. Download a PDF or source workbook and check the actual output. The [connector guide](CONNECTORS.md) identifies supported returns and external setup.
4. Check the saved change in the game's Commits view. Confirm application `git status` is unchanged by that browser work.
5. For collaboration changes, use a second browser profile/account on the same local server to exercise a contributor without write access. Separate developer clones do not share accounts or games automatically.

This walkthrough does not count as the five-independent-creator pilot, native-app certification, or physical-printer acceptance.

## Checks before a pull request

```sh
npm run doctor
npm run typecheck
npm run test:quick
npm run test:dev
# For browser workflow changes:
npm run test:ui
# For schemas, platform behavior, rendering, or tools:
./e2e.sh
```

Run focused tests for the touched contract as well; see [CONTRIBUTING.md](../CONTRIBUTING.md). Browser tests create disposable servers and game stores. A failure report should include the command, application commit, platform, relevant log, and reproduction steps. Avoid attaching account tokens or private game assets.

Full qualification is defined in [.github/workflows/quality.yml](../.github/workflows/quality.yml). Both protected gates must pass before merge. Main then qualifies and publishes its own exact image; it does not deploy a service. Local `launch:gate` without the documented infrastructure flags can skip live-host and real-backend checks, so a local green summary is not complete deployment evidence.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Node-version or `node:sqlite` failure | Select Node 24.20.0, then repeat setup. Do not disable the version check. |
| Python packages unavailable | Point `FORGE_BOOTSTRAP_PYTHON` at Python 3.11 before initial setup. Existing `.venv` is reused; inspect its Python version before replacing it. |
| Chromium missing or cannot execute | Install Chrome/Chromium or set `CHROME_PATH` to an executable, then run `npm run doctor`. Use the same environment for server and tests. |
| `EADDRINUSE` | Stop your own previous server or select another port. Do not stop unrelated processes. |
| Missing Netrunner/other fixture game | Expected in ordinary startup. Only Ember is seeded. Internal fixtures are not launch content or licensed by the application's Apache license. |
| Private Sheets add-on cannot reach Forge | Google cannot call your localhost. Follow the operator deployment path; ordinary XLSX/CSV handoffs work locally. |
| Unexpected old interface | Check the printed build, restart this checkout's server, and reload the correct port. Edit `tools/hub_template.html`, never generated `hub.html`. |

The repository already contains third-party fixtures with proprietary or unconfirmed metadata. Their presence in a developer clone does not grant publication or redistribution rights. Use Ember or your own rights-cleared content for demonstrations; see the [handoff limitations](DEVELOPER-HANDOFF.md).
