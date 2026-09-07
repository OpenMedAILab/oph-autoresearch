# AntiVEGF Qwen engineering runner

This is the hardened successor to the bounded SSH engineering runner executed on
2026-09-07. It is specific to that project's frozen first-ten-task development
protocol and existing preparation inventory. It is not the application's formal
OCI executor, a general experiment launcher, or a clinical validation result.

The executed source (SHA-256
`1e6cc22234ff518b149b32d799f90985886c76e2dd15274afd6b14b4180e8214`)
and its completed receipt remain unchanged in
`/data1/20251113/AntiVEGF/oph-qwenonly-devtest-20260907-repair-v2`.
The first hardened successor was tested with synthetic inputs and mocked HTTP
responses. On the user's next instruction, the current successor also launched a
real Bailian acceptance run in
`/data1/20251113/AntiVEGF/oph-qwen-live-acceptance-20260907`.
Its frozen source hash is
`478195369dcea00e8cf80ee78b954f45398e1c153f08a253a8e60d6800bc72b1`.
Read that directory's terminal receipt and audit for its actual outcome; historical
mock test results are not evidence of real model calls.

## Regression checks

On the SSH server, Python 3.12.3 and jsonschema 4.10.3 were used:

```sh
cd /data1/20251113/AntiVEGF/oph-qwen-hardening-20260907
env -u BAILIAN_API_KEY python3 -m unittest -v test_runner
```

All 19 tests pass, including a full synthetic candidate path with 52 mocked
requests (57 total attempts including the fixture's five prior probes), threshold
stopping, gate rejection, inconsistent gate decisions, append-only anti-gaming
checks, partial resumption, immutable completed runs, cache integrity, valid JSON
fences, count mismatch rejection, budget limits, and timeout retry prevention.
`fixtures/schemas.json` contains only the three source JSON schemas; all task
content and model responses in tests are synthetic. Temporary test run directories
are cleaned up and must not be used as real research evidence.

Before the subsequent real acceptance run, a twentieth test was added and all
20 passed. It verifies carrying forward the prior 27 attempts and known usage,
and stopping before a candidate round whose 32 required calls cannot fit within
the remaining cumulative budget. That version and its tests are archived in the
acceptance directory; the earlier hardening directory retains its original source.

## Future execution prerequisites

Real execution requires an explicit `--run-dir`, `--prior-receipt` referring to the
completed prior run, `--authorization-text` containing the current instruction,
the original frozen preparation
inventory and source hashes, a current verified `dns_snapshot.json` in that new
run directory, and the server-only `BAILIAN_API_KEY`. The script keeps the existing
10-task, single-candidate, 60-attempt limit and source authorization record; it
must not be reused to imply authorization for a different scope. All prior attempts
and known tokens are carried forward from the supplied receipt, whose byte hash
is frozen in the new configuration. Prepare and
review a new run's configuration before submitting it. Do not copy expired DNS
addresses blindly, load credentials locally, or modify the completed run.

Completed run directories return `already_completed` before creating a lock,
rewriting receipts, preparing data, or making network calls. For incomplete runs,
successful cache entries must match request, response and parsed hashes; unknown
or failed attempts still require a separately recorded recovery decision.

The production formal execution API currently fixes the evaluator to
`binary-classification-v1` and sets `network: disabled`. Supporting a formal
Bailian report-generation study requires a separate compatible execution adapter
and evaluation contract; removing isolation or fabricating formal approval is not
part of this runner.

The live acceptance run finished `completed_natural_stop`: 20/20 new calls succeeded, 47 cumulative attempts, one report failed A4, zero report-format failures, and 32/32 read-only audit checks passed. No candidate was forced below the threshold. This was a repeated engineering acceptance on the same ten tasks, not ten additional independent clinical cases.

## Software-originated single-task smoke

`app_smoke.py` binds a two-call generator/judge pair to a confirmed oph study hash.
It imports the frozen acceptance runner on the SSH host, verifies its source and
input hashes, carries forward the existing 47 attempts, and writes a separate
`oph-app-*` run directory. Credentials are loaded only on the server. The command
must be launched through the oph master conversation's SSH tool when validating
that software execution path. Its stdout is a single aggregate JSON object for
versioned `experiment` registration, including the source hashes and call counts.

The wrapper makes no automatic retries. A terminal aggregate is returned unchanged
on repeated invocation; an attempt without a closing aggregate requires explicit
reconciliation. Offline wrapper tests use synthetic inputs and a fake transport:

```sh
python3 -m unittest discover -s scripts/experiments/antivegf_qwen -p test_app_smoke.py -v
```

On 2026-09-07 oph itself launched the smoke and recorded two completed Bailian calls
in `/data1/20251113/AntiVEGF/oph-app-paper-smoke-20260907`. The cumulative ledger
reached 49 attempts. This repeated first task is a software execution check, not
another independent clinical case. Consult its immutable aggregate and receipt for
actual usage, hashes and limitations; the earlier ten-task results remain separate.
