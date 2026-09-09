# Self-healing repository template

AI proposes tests and fixes. Humans approve the scope and exact test revision. Deterministic checks control what can be published.

**Status: initial implementation, disabled by default.** Node.js projects using the built-in `node:test` runner and standard library are supported first. The real AI issue-to-PR path requires an enabled GAW engine and repository protections; local tests alone do not prove that integration.

## Workflow

1. Anyone opens a bug report. GAW triages it and asks for missing information.
2. A configured maintainer approves the exact issue body and policy digest.
3. Run **Heal test proposal** with the issue number. AI opens a tests-only draft PR.
4. A configured human test owner approves that exact PR head using GitHub's **Approve** review.
5. Run **Heal implementation** with the test PR number. Before inference, the controller checks live approvals and proves the approved tests fail on assertions against the baseline. AI returns candidate file data, without publishing a fix branch.
6. **Heal verify and publish** validates the source run, reconstructs immutable snapshots, and verifies baseline → expected regression failure → candidate success in separate Docker containers. Only then does its publisher create a draft fix PR, including tests and a ledger.
7. **Heal authorization** checks current approvals and compares the PR contents with the trusted verification artifact. Required CI and human review control merging. Close the test proposal after the fix merges.

Test proposals are allowed to be red. Fix branches created by the publisher must be green before they are published. No automatic merge is implemented.

## Adopt the template

Choose **Use this template**, then configure your copy:

1. Replace the numeric user IDs in `.self-heal/policy.json` and owners in `.github/CODEOWNERS`. Resolve IDs with `gh api users/YOUR_LOGIN --jq .id`. The initial IDs belong to `S-Y-3-D`; do not leave them in an unrelated installation.
2. Place application code under `src/` and tests under `tests/`, or configure different top-level prefixes. Tests must end in `.test.mjs`. This initial adapter does not install external packages, build applications, or run arbitrary project commands.
3. Configure Copilot authentication following [GAW's engine documentation](https://github.github.com/gh-aw/reference/engines/). Generated workflows expect the applicable Copilot credentials, including `COPILOT_GITHUB_TOKEN` for the personal-token setup. Inference and Actions may incur charges.
4. Enable GitHub Actions PR creation in repository settings. This version publishes with `GITHUB_TOKEN`; generated PR CI may require **Approve workflows to run**. No PAT is given to candidate code.
5. Configure a protected default branch: PRs required, at least one approving review, code-owner review, stale review dismissal, and required `Template CI / test` (select the actual emitted check) plus `Heal authorization`. Do not give the bot a bypass. The authorization gate checks automated fixes against their evidence; ordinary PRs receive a not-applicable success and still require CI and human review. **Do not enable unattended healing if your GitHub plan cannot enforce the required protections.**
6. Create the `heal-publish` environment and configure a required human reviewer during the initial rollout.
7. Set policy `enabled` to `true` through a reviewed change. Set repository Actions variable `HEAL_ENABLED=true` only after the setup above. Keep it unset/false while preparing.

Run `npm run heal:doctor` for local policy validation. It does not audit remote branch protection or credentials.

## Approving, pausing and revoking

To obtain the exact scope command locally (with `GH_TOKEN` and `GITHUB_REPOSITORY` set), run:

```sh
node .self-heal/bin/heal.mjs scope 123
```

Post its printed `/heal accept <scope-digest> <policy-digest>` as a **new issue comment**. The controller verifies the comment author's numeric GitHub ID; text claiming someone else's identity has no authority.

- `/heal pause` blocks work and publication.
- `/heal resume <policy-digest>` clears a pause only at the same or higher authority level.
- `/heal revoke` withdraws scope acceptance.
- Administrators take precedence over maintainers. A maintainer cannot undo an administrator's pause or revocation. Test approval remains a separate role.
- Dismiss a test review or submit **Request changes** to withdraw test approval. Any current configured test owner's outstanding objection blocks execution.
- Changes to the issue body or policy require a fresh scope acceptance. Changes to test head require fresh test review. A moved base requires refreshing the test branch and restarting.

The MVP uses **current GitHub comments and reviews**, not an immutable event store. Editing/deleting an old pause/revoke comment removes that current-record control; use new commands to preserve history. Policy changes invalidate scope approval. A later release can add an append-only event ledger.

Approval refresh runs on PR/comment events and every ten minutes. Review changes are observed by the next refresh; run **Heal authorization refresh** manually for immediate rechecking. The privileged gate deliberately does not use the PR-controlled `pull_request_review` workflow event. GitHub event processing is asynchronous: revocation and merging are not one atomic transaction. During a disputed merge, use GitHub's blocking review and pause controls directly as well.

## Verification boundary

- AI output is a bounded JSON list of implementation file changes. Paths outside configured implementation prefixes, duplicates, traversal, symlinks and submodules are rejected.
- The immutable base-to-test snapshot diff must contain tests only. This is checked independently of GitHub's mutable PR file list.
- Scope authorization includes the current policy digest. Exact test-head approvals are re-read before implementation and publication.
- Production tests run in disposable Docker containers with no network, credentials, capabilities or writable source mount. They use Node's built-in runner; empty suites, skipped tests and non-assertion regression failures are rejected.
- Candidate and test-tree digests bind results to files. Digests alone do not authenticate evidence: publishing consumes the `heal-verified` artifact from its own trusted verification workflow run. The merge gate retrieves that artifact through GitHub, rather than trusting the ledger committed in the PR.
- Privileged workflows check out only the default branch. They never execute candidate repository scripts. Third-party Actions and compiled GAW runtimes are pinned.

FoFo inspired the test-integrity comparison, but this repository does not vendor or depend on FoFo. Its small snapshot boundary is implemented here; integrating FoFo's broader test-quality gates remains optional after an audit.

## Ledger and recovery

Every published fix includes `.self-heal/ledger/<run-id>.json`: approval references, scope/policy/base/test revisions, tree digests, verification results and workflow run ID. Full before/after logs are retained in the `heal-verified` artifact for 30 days. If that artifact expires before merge, the merge gate fails closed; rerun verification.

Failed attempts have GitHub Actions logs but do not yet receive permanent versioned ledger entries. This is a stated MVP gap. No retry loop or spending aggregator is enabled: each maintainer dispatch initiates one candidate attempt. Re-running the same publisher after partial success may find its existing branch; inspect that branch/PR before starting a new attempt. Automatic reconciliation is not implemented yet.

The committed ledger is informational and does not hash itself. The evidence digest covers the candidate tree before the controller adds the ledger. Post-publication source changes invalidate the merge gate; generate a new verified attempt instead.

## Develop and validate

```sh
npm test
npm run test:app
npm run heal:doctor
```

CI additionally runs the production Docker path. To run it locally on a machine with Docker:

```sh
docker pull node:22-bookworm-slim
HEAL_DOCKER_TEST=1 npm test
```

The default local verifier tests use only controlled fixtures and subprocesses. Never use local mode for untrusted model output.

GAW sources are the three `.github/workflows/heal-*.md` files. Compiled `.lock.yml` files are committed and generated with GAW **v0.88.7**. Regenerate after source edits and review the resulting diff. GAW is in public preview; upgrades require validation.

## Manual end-to-end acceptance

In a disposable configured repository, add an issue asking for a precisely specified change to `greet`, approve the printed scope command, generate and review tests, and dispatch implementation. Confirm a failing candidate produces no fix branch, a passing candidate produces a draft PR and ledger, and a dismissed review or changed PR file turns `Heal authorization` red. Approve CI execution if GitHub requests it. Never merge a knowingly failing test-only proposal.

## Current limits

- Small text repositories: 2,000 tree entries, 1 MB per file and 10 MB encoded snapshot maximum. REST snapshot collection favors clarity over speed.
- Node standard-library tests only; no external dependencies, package-manager hooks, lint/typecheck/build adapters, migrations or deployment.
- Manual test approval and manual implementation dispatch; no automatic coding from a public comment.
- Human-reviewed merging; no post-merge repair/revert loop.
- GitHub permissions protect against untrusted contributors, not administrators who can change the enforcement workflow itself.

See [GitHub Agentic Workflows](https://github.com/github/gh-aw) for runtime documentation.
