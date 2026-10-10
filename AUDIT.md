# Comprehensive Codebase Audit — 2026-10-10

## Status

**PARTIALLY AUDITED — WITH CONFIRMED FINDINGS AND FIXES PENDING CI.**

- Repository: `ReyinGamerz/RapStore-Assistant`
- Base branch/commit: `main` / `55b45b1c7487aa64112425cdc690e3b6f52151c7`
- Audit branch: `security/comprehensive-audit-2026-10-10`

This audit is based on source/configuration retrieved from GitHub. A local clone could not be created because this environment could not resolve `github.com`, so tests cannot be executed locally here. The added tests and syntax checks are pending a GitHub Actions run. No live Discord, MongoDB Atlas, or VPS test was performed.

## A. Executive summary

Confirmed findings on the audited base:

- **P1 — Ticket recovery crash:** `src/index.js` referenced `missingAt` before its `const` declaration. When ticket creation encountered a stale ticket record whose Discord channel was missing, the cleanup path would throw a `ReferenceError` and abort that ticket creation.
- **P2 — Panel edit/delete crash:** `src/index.js` used `ObjectId` in Founder/Admin category/product handlers without importing it at module scope. A dynamic import inside catalog selection does not make the name available to those handlers.
- **P2 — Slash-command architecture mismatch:** `src/global-commands.js` registered guild-scoped commands and cleared global commands, contradicting the requested global-only setup without `DISCORD_GUILD_ID`.
- **P2 — No automatic startup validation:** `npm start` launched the bot without running tests or syntax checks first.
- **P2 — Dependency reproducibility:** the audited repository has no `package-lock.json`, so transitive dependency versions are not pinned.

The audit branch fixes the first four items and adds a regression test for ticket recovery. Those changes remain **pending CI verification**.

## B. Inventory and coverage

| Path | Role | Status | Notes |
|---|---|---|---|
| `src/index.js` | Startup, interaction routing, panels, catalog, ticket creation/close, Discord events | REVIEWED — FIXED, PENDING TEST | Found undeclared `ObjectId` and a temporal-dead-zone bug in stale-ticket recovery |
| `src/order-system.js` | Order/payment/vouch/transcript lifecycle and maintenance | REVIEWED | Inspected authorization, state transitions, archival, retry, and cleanup paths; live integration not run |
| `src/security.js` | Staff/owner checks, attachment validation, transcript limits, payment reconciliation | REVIEWED | Existing unit tests inspected |
| `src/ticket-recovery.js` | Missing-ticket state reconciliation | ADDED — PENDING TEST | Shared timestamp; injected database dependency for regression testing |
| `src/config.js` | Environment configuration | REVIEWED — UPDATED | Removed obsolete guild ID setting |
| `src/database.js` | MongoDB connection and indexes | REVIEWED | Actual Atlas data/index compatibility is unavailable |
| `src/commands.js` | Slash command definitions | REVIEWED | Defines `/catalog` and `/panel` |
| `src/global-commands.js` | Command deployment | REVIEWED — FIXED, PENDING TEST | Global registration plus cleanup of legacy guild registrations |
| `src/deploy-commands.js` | Manual command refresh | REVIEWED — FIXED, PENDING TEST | Enumerates current guilds and destroys the temporary client in `finally` |
| `src/ui.js` | Components V2 UI builders/text splitting | REVIEWED | No live Discord visual test |
| `test/security.test.js` | Security helper unit tests | REVIEWED | Source inspected; execution blocked locally |
| `test/ticket-recovery.test.js` | Missing-channel recovery regression tests | ADDED — PENDING TEST | Tests shared timestamp and invalid identifiers |
| `package.json` | Runtime/dependencies/npm scripts | REVIEWED — UPDATED | Added `prestart` and `validate`; syntax check includes new module |
| `.github/workflows/ci.yml` | GitHub Actions | REVIEWED | Runs tests and syntax checks; no passing run verified in this environment |
| `README.md` | Setup/operation guide | REVIEWED — UPDATED | Aligned with global commands and automatic validation |
| `.env.example` | Environment template | REVIEWED — UPDATED | Removed `DISCORD_GUILD_ID` |
| `.gitignore` | Local secret/runtime exclusions | REVIEWED | Ignores `.env` and `.env.*`, with `.env.example` explicitly allowed |
| `package-lock.json` | Deterministic dependency resolution | NOT PRESENT | Missing on audited base |

This is the known inventory of files reached during the audit. A full repository-tree listing was not available through the connected GitHub tools, so unlisted/generated files are **not independently inventoried** and are not implicitly claimed as audited. Third-party dependency source, commit-history secret scanning, and private production environment were not fully inspected.

## C. Architecture and feature connections

```text
npm start
  -> prestart: npm run validate
       -> node --test
       -> npm run check (Node syntax checks)
  -> src/index.js
       -> environment validation
       -> MongoDB connection + indexes
       -> category data normalization
       -> Discord login and event registration
       -> order maintenance
       -> global slash-command refresh
            -> overwrite global command set
            -> clear old guild-scoped commands in enumerable guilds

/catalog -> Founder/Admin handler check -> public persistent catalog
/panel   -> Founder/Admin handler check -> ephemeral management panel
catalog select -> validate category/product/intent -> reserve user ticket -> create channel + DB record
order ticket -> order record -> payment selection -> proof submission -> staff review
             -> DONE -> vouch -> transcript archive -> ticket channel deletion
ticket close -> owner/staff check -> lifecycle guard -> transcript archive -> channel deletion
```

Command definitions live in `src/commands.js`. The event router is in `src/index.js`. Order/payment/vouch component IDs route to `handleOrderInteraction` in `src/order-system.js`. Ticket/panel/catalog IDs route to dedicated handlers in `src/index.js`. Authorization is checked in handlers rather than inferred from command visibility or `customId` values.

## D. Findings

| ID | Severity | Confidence | Location | Finding | Status |
|---|---|---|---|---|---|
| AUD-001 | P1 | High | `src/index.js` stale-ticket cleanup | `missingAt` was read before initialization; recovery could crash ticket creation when an old channel was missing | FIXED — PENDING TEST |
| AUD-002 | P2 | High | `src/index.js` panel category/product handlers | `ObjectId` was referenced without a module-scope import; edit/delete confirmation paths could throw at runtime | FIXED — PENDING TEST |
| AUD-003 | P2 | High | `src/global-commands.js`, `src/deploy-commands.js`, `src/config.js`, `.env.example`, README | Runtime and docs were guild-scoped and required `DISCORD_GUILD_ID`, contrary to global-only requirement | FIXED — PENDING TEST |
| AUD-004 | P2 | High | `package.json` | `npm start` did not automatically run unit tests and syntax checks | FIXED — PENDING TEST |
| AUD-005 | P2 | High | `package-lock.json` | No lockfile, so dependency resolution is not reproducible and transitive versions are not pinned | OPEN — registry/network needed |
| AUD-006 | P2 | High | Test coverage | Existing tests are primarily pure helper tests; full Discord/MongoDB end-to-end tests are not present in the inspected inventory | OPEN — integration environment needed |
| AUD-007 | P2 | Medium | MongoDB index initialization | Unique-index creation may fail on production data containing duplicates or incompatible legacy records | BLOCKED — inspect metadata/backup before migration |
| AUD-008 | P2 | Medium | Public persistent catalog | Category/product choices update one shared public message and guild-level saved selection; concurrent users can influence the visible selection | OPEN — confirm intended UX before changing behavior |

## E. Security and permission matrix

Configured staff roles are `FOUNDER_ROLE_ID` and `ADMIN_ROLE_ID`. The inspected implementation treats both as staff; a separate founder-only identity policy is not present.

| Action | Founder role | Admin role | Other staff | Member | Handler control |
|---|---|---|---|---|---|
| `/panel` | Allow | Allow | Deny | Deny | Runtime role check; ephemeral response |
| `/catalog` create/sync | Allow | Allow | Deny | Deny | Runtime role check; public catalog remains separate |
| Category/product changes | Allow | Allow | Deny | Deny | Button/select/modal handlers re-check role |
| Payment proof approve/reject | Allow | Allow | Deny | Deny | Guild + staff role check |
| `!close` / `!done` | Allow | Allow | Deny | Deny | Message handler checks staff role |
| Order selection/cancellation | Owner; staff actions where defined | Same | Deny unless configured staff | Other users denied | Order loaded by guild/channel; owner-or-staff check |
| Vouch submission | Buyer only | Buyer only if buyer | Deny if not buyer | Buyer only | Order ID, guild, channel, DONE state, buyer ID |
| Ticket close button | Owner or staff | Owner or staff | Deny unless staff | Ticket owner only | Ticket record + owner/staff + lifecycle guard |
| Ticket visibility | Configured overwrite | Configured overwrite | Deny by default | Ticket owner only | @everyone denied ViewChannel; owner/staff/bot explicitly allowed |

Role IDs, channel overwrites, and bot permissions still require live-server verification. Global command registration does not restrict usage to staff; handler checks remain authoritative.

## F. Changes made on the audit branch

1. Extracted missing-ticket reconciliation into `src/ticket-recovery.js`. The timestamp is created before writes and shared across ticket/order/proof updates.
2. Imported `ObjectId` in `src/index.js` so panel category/product handlers can use it.
3. Added `test/ticket-recovery.test.js` for missing-channel recovery and invalid identifiers.
4. Migrated slash-command deployment to global registration; attempts to remove legacy guild-scoped copies only in guilds the bot currently enumerates. Cleanup errors are surfaced instead of reporting success.
5. Removed `DISCORD_GUILD_ID` from runtime config and the example environment.
6. Added `npm run validate` and `prestart` so each `npm start` runs unit and syntax checks first.
7. Updated README instructions to match the actual deployment flow.

No production Discord server, MongoDB database, or VPS was modified.

## G. Tests

| Test | Type | Result | Evidence/notes |
|---|---|---|---|
| Existing `test/security.test.js` | Unit | NOT RUN | Source inspected; local clone failed because GitHub DNS was unavailable |
| New `test/ticket-recovery.test.js` | Regression unit | NOT RUN — PENDING CI | Added on audit branch |
| `npm run check` | Syntax | NOT RUN — PENDING CI | New module added to syntax-check script |
| Global command refresh | Discord integration | BLOCKED | Requires real bot token and Discord API |
| Ticket permission/visibility | Live E2E | BLOCKED | Requires configured Discord test server |
| Payment proof, vouch, transcript lifecycle | Live E2E | BLOCKED | Requires Discord + MongoDB test environment |
| Production index compatibility | Database | BLOCKED | Requires read-only inspection and backup plan |

## H. Residual risks

- CI results have not yet been checked; do not treat the fixes as verified until the workflow passes.
- No package lockfile exists. Dependency versions are not fully reproducible until a lockfile is generated and committed in an environment with registry access.
- Global command propagation can take time. Legacy guild command cleanup only covers guilds the bot can currently enumerate.
- Discord role/channel permissions, Components V2 payloads, transcript uploads, and MongoDB concurrency need controlled live tests.
- Public catalog selection is shared across users. Confirm the intended UX before redesigning it as per-user ephemeral state.
- Production database documents and indexes were not inspected. Do not run destructive migrations or drop indexes without backup and approval.

## I. VPS update instructions

After reviewing and merging the PR:

```bash
cd `/RapStore-Assistant
git pull
npm install
npm start
```

`npm start` runs `npm run validate` automatically. If validation fails, the bot should not start. To refresh global slash commands manually without starting the full bot:

```bash
npm run commands:refresh
```

Never share `.env`, tokens, MongoDB URI, payment credentials, or private logs. After startup, verify the MongoDB-ready and global-command-refresh log messages, and ensure no cleanup error is reported.

## J. Conclusion

Current status: **PARTIALLY AUDITED — WITH CONFIRMED FINDINGS AND FIXES PENDING TEST.**

This report does not claim 100% safety, full E2E coverage, or production verification. Upgrade the status only after CI results are checked and remaining inventory/integration limitations are addressed.
