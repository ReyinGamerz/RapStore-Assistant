# Comprehensive Codebase Audit — 2026-10-10

## Status

**PARTIALLY AUDITED — GLOBAL-ONLY STARTUP FOLLOW-UP PATCH PENDING CI; LIVE DISCORD/MONGODB TESTS AND DEPENDENCY/SECRET-HISTORY REVIEW STILL REMAIN.**

- Repository: `ReyinGamerz/RapStore-Assistant`
- Base branch/commit: `main` / `55b45b1c7487aa64112425cdc690e3b6f52151c7`
- Audit branch: `security/comprehensive-audit-2026-10-10`

This audit is based on source/configuration retrieved from GitHub. A local clone could not be created because this environment could not resolve `github.com`; however, GitHub Actions run [#38048167806](https://github.com/ReyinGamerz/RapStore-Assistant/actions/runs/38048167806) completed successfully with `npm install --ignore-scripts`, `npm test`, and `npm run check` passing. No live Discord, MongoDB Atlas, or VPS test was performed.

## A. Executive summary

Confirmed findings on the audited base:

- **P1 — Ticket recovery crash:** `src/index.js` referenced `missingAt` before its `const` declaration. When ticket creation encountered a stale ticket record whose Discord channel was missing, the cleanup path would throw a `ReferenceError` and abort that ticket creation.
- **P2 — Panel edit/delete crash:** `src/index.js` used `ObjectId` in Founder/Admin category/product handlers without importing it at module scope. A dynamic import inside catalog selection does not make the name available to those handlers.
- **P2 — Slash-command architecture mismatch:** `src/global-commands.js` registered guild-scoped commands and cleared global commands, contradicting the requested global-only setup without `DISCORD_GUILD_ID`.
- **P2 — Maintenance shutdown leak:** the 30-second maintenance interval was not cleared and an active run was not awaited before MongoDB closed.
- **P2 — Shared catalog selection:** category/product changes edited one public message for everyone, allowing concurrent users to interfere with the visible selection.
- **P2 — Vouch deadline bypass:** the deadline was checked when opening the vouch modal but not checked again when submitting it, allowing a modal opened just before the deadline to submit late.
- **P2 — Audit-log write failures were silent:** multiple order/payment/ticket audit-log writes swallowed errors, hiding loss of audit trail.
- **P3 — Public testimonial formatting:** user-supplied testimonial Markdown was inserted into a public Components V2 message without Markdown escaping (mentions were already disabled).
- **P3 — Dead configuration/code:** `LOG_LEVEL`, `v2SendPayload`, and an unused `ticketNumber` initializer argument were present but unused.
- **P2 — No automatic startup validation:** `npm start` launched the bot without running tests or syntax checks first.
- **P2 — Dependency reproducibility:** the audited repository has no `package-lock.json`, so transitive dependency versions are not pinned.
- **P2 — Secret-history review limitation:** current tracked files were inspected for configuration/secret handling, but the full commit history and GitHub secret-scanning results were not available for exhaustive verification.

The audit branch fixes the confirmed runtime defects, shared catalog selection behavior, shutdown scheduling, and command/startup architecture described above. Unit tests and syntax checks **PASS in GitHub Actions**; dependency reproducibility, full history secret scanning, and live integration remain open or blocked.

## B. Inventory and coverage

| Path | Role | Status | Notes |
|---|---|---|---|
| `src/index.js` | Startup, interaction routing, panels, catalog, ticket creation/close, Discord events | UPDATED — CI PASS | Public base catalog now creates/updates one owner-bound non-ephemeral panel per user/channel; saved panels sync after catalog refresh/restart; live interactions remain untested |
| `src/order-system.js` | Order/payment/vouch/transcript lifecycle and maintenance | UPDATED — CI PASS | Removed the extra `INFO PESANAN` message from order-ticket initialization; order/payment lifecycle still needs live verification |
| `src/security.js` | Staff/owner checks, attachment validation, transcript limits, payment reconciliation, vouch deadline helper | REVIEWED — UPDATED | Deadline helper has boundary tests; production behavior not live-tested |
| `src/ticket-recovery.js` | Missing-ticket state reconciliation | ADDED — CI PASS | Shared timestamp; injected database dependency for regression testing |
| `src/catalog-state.js`, `test/catalog-state.test.js` | Category navigation wraparound | ADDED — CI PASS | Tests last-to-first NEXT, first-to-last PREV, one category, empty count, and invalid/stale indexes |
| `src/config.js` | Environment configuration | REVIEWED — UPDATED | Removed obsolete guild ID setting |
| `src/database.js` | MongoDB connection and indexes | UPDATED — CI PASS | Added a unique `{guildId, channelId, userId}` index for public per-user catalog panel references; actual Atlas index state has not been inspected |
| `src/commands.js` | Slash command definitions | REVIEWED | Defines `/catalog` and `/panel` |
| `src/global-commands.js` | Command deployment | UPDATED — CI PENDING | Startup registers global commands only; legacy guild command cleanup is opt-in for manual refresh |
| `src/deploy-commands.js` | Manual command refresh | UPDATED — CI PENDING | Explicit `npm run commands:refresh` refreshes global commands and clears legacy guild-scoped copies; temporary client destroyed in `finally` |
| `src/ui.js` | Components V2 UI builders/text splitting | REVIEWED | No live Discord visual test |
| `test/security.test.js` | Security helper unit tests | REVIEWED — PASS CI | Includes vouch deadline boundary tests; latest CI run [#38048815221](https://github.com/ReyinGamerz/RapStore-Assistant/actions/runs/38048815221) passed |
| `test/ticket-recovery.test.js` | Missing-channel recovery regression tests | ADDED — PASS CI | Tests shared timestamp and invalid identifiers |
| `package.json` | Runtime/dependencies/npm scripts | UPDATED — CI PASS | `npm start` directly runs `node src/index.js`; tests/checks remain manual commands, and syntax checks include `src/catalog-state.js` |
| `.github/workflows/ci.yml` | GitHub Actions | REVIEWED — PASS | Explicit `contents: read` workflow token permission and production dependency advisory check; latest run [#38048815221](https://github.com/ReyinGamerz/RapStore-Assistant/actions/runs/38048815221) passed |
| `README.md` | Setup/operation guide | UPDATED — CI PASS | Documents direct `npm start`, manual test/check commands, and public non-ephemeral owner-bound catalog panels |
| `AUDIT.md` | Audit log/report | REVIEWED — UPDATED | Records scope, findings, remediation, CI evidence, and residual risks |
| `.env.example` | Environment template | REVIEWED — UPDATED | Removed `DISCORD_GUILD_ID` |
| `.gitignore` | Local secret/runtime exclusions | REVIEWED | Ignores `.env` and `.env.*`, with `.env.example` explicitly allowed |
| `LICENSE` | License | REVIEWED | GNU General Public License version 2 text is present; confirm this matches the project's intended licensing |
| `package-lock.json` | Deterministic dependency resolution | NOT PRESENT | Missing on audited base |

A recursive GitHub tree listing of `main` was retrieved: 16 tracked files were present at the base commit, with `src/ticket-recovery.js`, `test/ticket-recovery.test.js`, and `AUDIT.md` added on this branch. `package-lock.json` is absent. Third-party dependency source, exhaustive commit-history secret scanning, and private production environment were not fully inspected.

## C. Architecture and feature connections

```text
npm start
  -> src/index.js (direct startup; tests/syntax checks run by CI or manually)
       -> environment validation
       -> MongoDB connection + indexes
       -> category data normalization
       -> Discord login and event registration
       -> order maintenance
       -> global slash-command refresh (global endpoint only)

npm run commands:refresh
  -> overwrite global command set
  -> one-time/explicit cleanup of old guild-scoped commands in enumerable guilds

/catalog -> Founder/Admin handler check -> public persistent base catalog
/panel   -> Founder/Admin handler check -> ephemeral management panel
shared catalog select -> create/update owner-bound public non-ephemeral per-user panel
per-user panel -> owner check -> category/product selection -> ephemeral product confirmation -> reserve ticket -> create channel + DB record
order ticket -> order record -> payment selection -> proof submission -> staff review
             -> DONE -> vouch -> transcript archive -> ticket channel deletion
ticket close -> owner/staff check -> lifecycle guard -> transcript archive -> channel deletion
```

Command definitions live in `src/commands.js`. The event router is in `src/index.js`. Order/payment/vouch component IDs route to `handleOrderInteraction` in `src/order-system.js`. Ticket/panel/catalog IDs route to dedicated handlers in `src/index.js`. Authorization is checked in handlers rather than inferred from command visibility or `customId` values.

## D. Findings

| ID | Severity | Confidence | Location | Finding | Status |
|---|---|---|---|---|---|
| AUD-001 | P1 | High | `src/index.js` stale-ticket cleanup | `missingAt` was read before initialization; recovery could crash ticket creation when an old channel was missing | FIXED — REGRESSION TEST PASS; LIVE FLOW NOT RUN |
| AUD-002 | P2 | High | `src/index.js` panel category/product handlers | `ObjectId` was referenced without a module-scope import; edit/delete confirmation paths could throw at runtime | FIXED — CI PASS; LIVE FLOW NOT RUN |
| AUD-003 | P2 | High | `src/global-commands.js`, `src/deploy-commands.js`, `src/config.js`, `.env.example`, README | Runtime and docs were guild-scoped and required `DISCORD_GUILD_ID`, contrary to global-only requirement | FIXED — CI PASS; LIVE DISCORD BLOCKED |
| AUD-004 | P2 | High | `package.json` | Startup does not automatically run unit tests and syntax checks | INTENTIONAL CHANGE AFTER AUDIT: operator requested direct `npm start`; CI still runs tests/checks and deploy docs recommend manual validation |
| AUD-005 | P2 | High | `package-lock.json` | No lockfile, so dependency resolution is not reproducible and transitive versions are not pinned | OPEN — registry/network needed |
| AUD-006 | P2 | High | Test coverage | Existing tests are primarily pure helper tests; full Discord/MongoDB end-to-end tests are not present in the inspected inventory | OPEN — integration environment needed |
| AUD-007 | P2 | Medium | MongoDB index initialization | Unique-index creation may fail on production data containing duplicates or incompatible legacy records | BLOCKED — inspect metadata/backup before migration |
| AUD-008 | P2 | High | Public persistent catalog | Category/product selection edited the shared public message; users could interfere with each other's selection state | UPDATED IN CODE — public non-ephemeral panel per user/channel, owner-bound components and persisted message ID; live E2E pending |
| AUD-009 | P2 | High | `src/order-system.js`, `src/index.js` shutdown | Maintenance interval was never cleared and an active run was not awaited before MongoDB closed | FIXED — CI PASS; LIVE SHUTDOWN TEST NOT RUN |
| AUD-010 | P2 | Medium | Dependencies / CI | No committed lockfile means dependency resolution is not reproducible; CI does run the production dependency audit | PARTIALLY MITIGATED — `npm audit --omit=dev --audit-level=high` PASS in CI; reproducibility remains OPEN |
| AUD-011 | P2 | Medium | `src/order-system.js` vouch modal submit | Vouch deadline was checked on modal open but not rechecked on submit; a late submission could be accepted | FIXED — REGRESSION TEST PASS CI; LIVE FLOW NOT RUN |
| AUD-012 | P2 | Medium | `src/index.js`, `src/order-system.js` audit logs | Audit log insert errors were swallowed, making audit-trail loss invisible in process logs | FIXED — ERROR LOGGING ADDED; CI PASS; LIVE DB FAILURE NOT SIMULATED |
| AUD-013 | P3 | Medium | `src/order-system.js` public vouch panel | Buyer-controlled Markdown could alter public testimonial formatting; mention parsing was already disabled | FIXED — ESCAPED TESTIMONIAL TEXT; CI PASS; LIVE DISPLAY NOT TESTED |
| AUD-014 | P3 | High | `src/config.js`, `.env.example`, `src/index.js`, `src/order-system.js` | Unused `LOG_LEVEL`, `v2SendPayload`, and `ticketNumber` argument increased maintenance noise | FIXED — CI PASS |

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
4. Changed catalog navigation to create/update one public non-ephemeral panel per user and channel. Component IDs carry the owner ID, and handlers reject another user's clicks without changing the panel.
5. Rechecked the vouch deadline at modal submission, added boundary tests, and escaped user-controlled testimonial Markdown.
6. Changed previously silent audit-log insert failures to write a sanitized error message to the process log.
7. Removed unused `LOG_LEVEL`, the unused `v2SendPayload` helper, and the unused `ticketNumber` initializer argument; limited the CI token to `contents: read`.
8. Added a stop function for order maintenance; shutdown clears the interval and waits for the active maintenance run before closing MongoDB.
9. Kept bot startup strictly global-only: startup calls the global application-command endpoint and does not touch guild command endpoints. Legacy guild-scoped copies are cleared only when explicitly running `npm run commands:refresh`; cleanup errors are surfaced instead of reporting success.
10. Removed `DISCORD_GUILD_ID` from runtime config and the example environment.
11. Kept `npm test`, `npm run check`, and `npm run validate` available as manual validation commands; current `npm start` directly executes the bot entry point.
12. Updated README instructions to match the actual deployment flow.

No production Discord server, MongoDB database, or VPS was modified.

## G. Tests

| Test | Type | Result | Evidence/notes |
|---|---|---|---|
| Existing `test/security.test.js` | Unit | PASS | Latest follow-up CI [#38128458526](https://github.com/ReyinGamerz/RapStore-Assistant/actions/runs/38128458526) passed |
| New `test/ticket-recovery.test.js` | Regression unit | PASS | Latest follow-up CI [#38128458526](https://github.com/ReyinGamerz/RapStore-Assistant/actions/runs/38128458526) passed |
| New `test/catalog-state.test.js` | Regression unit | PASS | Latest follow-up CI [#38128458526](https://github.com/ReyinGamerz/RapStore-Assistant/actions/runs/38128458526) passed wrap-around and invalid/stale-index tests |
| `npm run check` | Syntax | PASS | All configured `node --check` commands passed in follow-up CI [#38128458526](https://github.com/ReyinGamerz/RapStore-Assistant/actions/runs/38128458526) |
| Maintenance shutdown | Static review | PASS (code review) | Timer clear and active-run wait are wired; no live shutdown test |
| Vouch deadline | Unit regression | PASS | Boundary tests for before/at/after deadline and invalid dates passed in [CI run #38048815221](https://github.com/ReyinGamerz/RapStore-Assistant/actions/runs/38048815221) |
| Global command refresh | Discord integration | BLOCKED | Requires real bot token and Discord API |
| Ticket permission/visibility | Live E2E | BLOCKED | Requires configured Discord test server |
| Payment proof, vouch, transcript lifecycle | Live E2E | BLOCKED | Requires Discord + MongoDB test environment |
| Production index compatibility | Database | BLOCKED | Requires read-only inspection and backup plan |

## H. Residual risks

- Latest verified follow-up CI run [#38128458526](https://github.com/ReyinGamerz/RapStore-Assistant/actions/runs/38128458526) passed `npm install --ignore-scripts`, production dependency advisory check (`npm audit --omit=dev --audit-level=high`), unit tests, and configured syntax checks. This threshold check passing means no production dependency advisory at High or Critical severity blocked CI; it is not a full security guarantee. Live behavior and exhaustive security-history checks remain unverified.
- No package lockfile exists. Dependency versions are not fully reproducible until a lockfile is generated and committed in an environment with registry access.
- Production dependency advisories were checked at High/Critical threshold in CI; development dependency advisories and exhaustive secret scanning of commit history remain unverified.
- Global command propagation can take time. Explicit legacy guild-command cleanup only covers guilds the bot can currently enumerate. Normal `npm start` does not perform guild-scoped API calls.
- Discord role/channel permissions, Components V2 payloads, transcript uploads, and MongoDB concurrency need controlled live tests.
- The new catalog flow needs a live Discord smoke test to verify the shared base message stays unchanged, each owner-bound public panel keeps independent category state, and other users cannot edit another member's panel. These panels are visible to everyone in the channel by design; only interaction control is owner-bound.
- Production database documents and indexes were not inspected. Do not run destructive migrations or drop indexes without backup and approval.

## I. VPS update instructions

After reviewing and merging the PR:

```bash
cd ~/RapStore-Assistant
git pull
npm install
npm test
npm run check
npm start
```

`npm start` directly runs `node src/index.js`; run tests and syntax checks manually before deployment. To refresh global slash commands manually without starting the full bot:

```bash
npm run commands:refresh
```

Never share `.env`, tokens, MongoDB URI, payment credentials, or private logs. After startup, verify the MongoDB-ready and global-command-refresh log messages, and ensure no cleanup error is reported.

## J. Conclusion

Current status: **PARTIALLY AUDITED — GLOBAL-ONLY STARTUP FOLLOW-UP PATCH PENDING CI; LIVE INTEGRATION AND DEPENDENCY REPRODUCIBILITY/SECRET-HISTORY REVIEW REMAIN.**

This report does not claim 100% safety, full E2E coverage, or production verification. Upgrade the status only after CI results are checked and remaining inventory/integration limitations are addressed.
