# Self-healing repository template

AI discusses issues, proposes tests, and attempts fixes only when an authorized human requests a run. Human-approved tests and isolated verification control publication. Everything in the normal workflow happens on GitHub.

## Start with a discussion

1. Open an issue and describe the desired behavior. This makes **no model call**.
2. A configured maintainer posts `/heal discuss` as a new standalone issue comment.
3. AI reads the issue, comments, linked PRs, reviews, and relevant code and posts one response.
4. Discuss normally. Mentioning another person, editing a comment, submitting a review, or replying normally does not start AI. Post `/heal discuss` whenever another AI response is wanted.
5. After successful discussion, the controller posts the complete `/heal accept <scope-hash> <policy-hash>` command. Copy it into a new comment to accept the current issue body. If discussion changes the requirement, update the issue body and request another discussion first.

No cloning or terminal is needed to obtain approval hashes. Ordinary contributors can discuss, but only configured human maintainers/administrators can request AI or accept scope. The current interface is slash commands, not a special @bot account.

## Commands

Post each command as an entire new comment on the issue or its linked PR. Quoted commands and edited requests cannot start inference.

| Command | What happens |
| --- | --- |
| `/heal discuss` | One discussion response and an exact scope approval command |
| `/heal accept <scope-hash> <policy-hash>` | Records scope approval; no AI |
| `/heal tests` | One tests-only PR for the accepted scope |
| `/heal revise-tests 2` | New superseding test PR addressing PR #2's review feedback |
| `/heal fix 2` | One fix attempt using PR #2's exact human-approved tests |
| `/heal revise-fix 3` | One new fix attempt using PR #3's test reference and discussion feedback |
| `/heal pause` | Blocks further work/publication and requests cancellation where possible |
| `/heal revoke` | Withdraws scope acceptance and requests cancellation where possible |
| `/heal resume <policy-hash>` | Clears a pause at the same or higher authority; no AI |

Approving scope does not generate tests. Approving tests does not generate a fix. Each AI stage needs its own explicit command. Do not manually dispatch or re-run an AI workflow: preflight rejects runs without their original recorded command, duplicate runs, edited/deleted command comments, or stale scope/policy/base.

## Reviewing tests

AI opens a draft PR containing only tests and explains the required behavior. Red regression tests are expected: they demonstrate the existing bug.

If correct, use **Files changed → Review changes → Approve → Submit review**. Do not merge the tests-only PR. Then request `/heal fix <test-pr-number>`.

If incorrect, submit **Request changes** explaining the desired behavior. A maintainer requests `/heal revise-tests <test-pr-number>`. The new proposal links its predecessor; prior objecting test owners must approve the new exact head to resolve their objections. Changing a test invalidates its approval. A stale proposal can be revised against the current base.

The fixing agent can see the approved tests. It must fix application code, not weaken tests. A disputed test requires separate revision and fresh human approval.

## Fix verification and publication

The controller first checks current authorization and proves the baseline passes and the proposed regression fails on assertions. AI then returns one candidate file patch.

The trusted verifier reconstructs immutable snapshots and runs baseline → regression → candidate in separate Docker containers. Candidate code receives no credentials or network access. Changes outside implementation paths, changed tests, skipped/empty tests, syntax-only regressions, and altered verification evidence are rejected.

A passing candidate waits for a human approval in the `heal-publish` environment before creating a draft fix PR containing the approved tests, application changes, and a ledger. Required CI, live `Heal authorization`, and human merge review still apply. There is no automatic merge.

A failed candidate publishes no fix branch. The failure has an Actions run record and diagnostic artifact. Another `/heal fix` request can use matching retained failure feedback to improve the code. There is **one candidate attempt per command**, not an unbounded retry loop. Bounded multi-attempt sessions remain future work.

## Cost, history, and concurrency

- Claude model `claude-sonnet-5` and Claude Code `2.1.247` are pinned.
- Each AI workflow has a 15-minute timeout, 40-turn limit, and 150 GAW AI-credit limit. AI credits are GAW's accounting unit, not a guaranteed dollar spending cap. Provider billing still applies.
- Policy defaults to ten AI command attempts per issue, counting discussion and revisions too. Increasing this requires a reviewed policy change and fresh scope approval.
- Command IDs are deduplicated; dispatch intent is persisted before the dispatch. One stage stays occupied while its work is running; fix work stays occupied while verification/publication awaits completion.
- An uncertain dispatch fails closed instead of automatically retrying. An administrator must inspect Actions and state before repairing a stranded reservation.
- `heal-state` stores original control comments, command intents, proposal mappings, and run outcomes as Git commits and individual event files. Deleting a recorded pause/revoke comment cannot remove its decision.
- State is signed with Ed25519 and bound to its Git parent. The public key is anchored in default-branch policy; only trusted main-branch controller steps receive the private key from the `heal-control` environment. The model and candidate tests receive no signing key. Modified or replayed state fails closed.
- Configure a ruleset preventing deletion and force pushes to `heal-state`. Invalid ordinary pushes cannot forge approvals, but can cause a denial of service. Administrators who can change environments, public keys, rulesets, or enforcement code remain outside this threat model.
- Full successful evidence artifacts last 30 days; failure artifacts last 90 days. Persistent state retains run links/conclusions, not unlimited copies of logs.
- Context is bounded to 150,000 characters. Oversized discussion fails before inference with an explanation; it is not silently truncated. Feedback logs are bounded diagnostics and explicitly treated as untrusted data.

GitHub event processing is asynchronous. Use a blocking review and pause during a disputed merge; revocation and merging are not one atomic operation. Cancellation can be delayed even though authorization checks block publication.

## Adopt and configure a copy

New copies have no `HEAL_ENABLED` variable and therefore cannot run AI. The policy also binds this installation to its repository name, so copied owner IDs cannot accidentally authorize another installation.

1. Update `policy.repository`, all numeric role IDs in `.self-heal/policy.json`, and `.github/CODEOWNERS` for your own repository. Keep activation off during setup.
2. Add `ANTHROPIC_API_KEY` to repository Actions secrets. Never commit the key.
3. Allow Actions to create and approve PRs. Our controller still rejects bot test approvals.
4. Protect the default branch: require a PR, human approval, CODEOWNERS review, stale review dismissal, emitted CI `test` and `Heal authorization`, and no bypass. Your GitHub plan must support enforcement.
5. Create `heal-publish` with a required human reviewer and protected-branch deployment policy.
6. Protect `heal-state` against force pushes and deletion. The bot must be able to append normal commits there.
   Create `heal-control` with a custom deployment rule allowing only the default branch. For a fresh copy run `node .self-heal/bin/init-state-key.mjs --new-installation` once, store its private key as environment secret `HEAL_STATE_PRIVATE_KEY`, and delete the ignored local private file. Include the generated public key in the reviewed policy setup. Do not rotate an initialized installation's key this way: existing history must remain verifiable. This one-time key provisioning is setup work; normal issue and approval operations require no terminal.
7. Enable `policy.enabled` through review, then set repository Actions variable `HEAL_ENABLED=true`.
8. Run **Heal setup check** in Actions. The default Actions token may not have permission to read administration settings; in that case provide optional `HEAL_SETUP_TOKEN` with read access to the reported settings, or run the same read-only audit using an authenticated maintainer CLI. The audit never reads secret values or starts AI.

All non-AI gate, command-recording, setup, and completion workflows use deterministic code. AI approvals never depend on an LLM interpreting a casual sentence.

## Local validation

Node 22+, no external package installation:

```sh
npm test
npm run test:app
npm run heal:doctor
```

For the production Docker verifier, pull `node:22-bookworm-slim`, set `HEAL_DOCKER_TEST=1`, and run `npm test`. CI runs that test automatically. ZIP feedback extraction uses `unzip`, included on GitHub's Linux runner; local integration tests require it on PATH.

With `GITHUB_REPOSITORY` and `GH_TOKEN` set, `node .self-heal/bin/heal.mjs setup` audits remote configuration. `heal:doctor` only validates local policy.

GAW sources are the three workflow Markdown files; committed lock files compile with gh-aw v0.88.7. Review generated changes before updating. See [GAW documentation](https://github.github.com/gh-aw/).

## Current scope and upgrade notes

- Standard-library Node `.test.mjs` projects only; no dependency installation, build/lint adapter, migrations, or deployment.
- Small repository snapshot limits: 2,000 entries, 1 MB per file, 10 MB encoded snapshot. History lookup is bounded and fails closed when its limit is reached.
- Revised tests open a new PR; they do not rewrite an old proposal. Close superseded test PRs after review; close the final tests-only PR after merging the fix.
- Old test proposals created before command tracking must be regenerated with `/heal revise-tests N` and reviewed again. Upgrading policy invalidates old scope approvals.
- Scope proposals currently cover the exact issue body, not an automatically accepted AI summary. Discussion comments cannot silently change scope.
- A denied or cancelled model run can lack detailed test feedback; its workflow logs and durable outcome still explain where it stopped.
- FoFo is not vendored. The controller implements its own test-integrity boundary.
- No own-hosted-model adapter or automatic retry sessions were added in this change.
