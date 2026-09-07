# SSH research authority deployment contract

This runbook deploys the current **standard-boundary** SSH daemon path. It does not approve a clinical deployment, an external host, an SSH daemon, a firewall rule, an ACL, or a key. Those facts need separately retained administrator evidence.

The remote process is a long-lived authority. SSH only forwards a local TCP connection to its loopback HTTP protocol; it does not execute a remote shell command for each research request. The local server verifies a pinned authority ID, the pinned `known_hosts` bytes, each job specification hash, and receipt bytes before accepting a result.

## Preconditions and limits

- This path only admits fixed synthetic research templates. It is not a general remote-shell runner.
- Start the local `oph serve` in the `standard` boundary. The current server deliberately does **not** configure `--research-ssh-daemon` when `--restricted-clinical` is present.
- Keep the remote service bound to `127.0.0.1`. Do not expose its HTTP port to a LAN or the Internet.
- The remote host needs a service account with ownership of its daemon database and output directories. The SSH account needs only the forwarding access that the institution has reviewed.
- Never put a patient identifier, an image, a DICOM header, a private key, a bearer token, or a real hostname in a ticket, log, or this document.

The client does not treat a working directory as operating-system isolation. The external SSH server policy, service-account ACLs, filesystem permissions, firewall policy, and host-key lifecycle remain administrator responsibilities. None have been accepted by the local loopback tests.

## Remote authority

Install the reviewed `oph` build on the remote authority host and create a service-owned directory, for example an administrator-controlled directory containing `jobs.sqlite` and an `outputs` subdirectory. Do not reuse a user home directory or a project workspace.

Create a root/service-account-readable configuration file with this exact shape. The placeholders are deliberately non-working values.

```json
{
  "authorityId": "institution-research-authority-01",
  "token": "REPLACE_WITH_A_32_TO_256_CHARACTER_BASE64URL_TOKEN",
  "port": 18443,
  "dbPath": "/controlled/oph-research/jobs.sqlite",
  "outputRoot": "/controlled/oph-research/outputs"
}
```

`authorityId` must match `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`. The token must be 32–256 base64url characters (`A-Z`, `a-z`, `0-9`, `_`, `-`). The service validates only these startup fields, plus an optional reviewed tracking block. It should receive the configuration via a file with restrictive OS permissions; do not pass the token as a command-line argument.

Run the remote service under the institution’s supervisor using a fixed command equivalent to:

```text
oph research-daemon --config /controlled/oph-research/remote-daemon.json
```

The service binds its protocol to remote `127.0.0.1:<port>`. Its authenticated protocol is:

| Method and path | Meaning |
| --- | --- |
| `GET /health` | Authority ID, tracking policy hash, and slot availability. |
| `POST /submit` | Submit one fixed `JobSpec`; the authority enforces durable dispatch-key identity. |
| `GET /status/{dispatchKey}` | Observe a submitted job. |
| `POST /cancel/{dispatchKey}` | Request cancellation. |
| `GET /receipt/{dispatchKey}` | Fetch bytes only for a completed verified receipt. |

Every request requires `Authorization: Bearer <token>`. JSON job responses use `{ "authorityId", "job" }`; the receipt carries `x-oph-authority-id`. The service redacts output paths and worker error details from projected job responses.

## SSH account and network controls

Provision a dedicated SSH public key for the local service account. The private key is local-only and must be a regular file, not a symbolic link. Configure the SSH server and network policy so that the only reviewed route is loopback forwarding to the authority’s configured remote port. Keep the authority HTTP listener loopback-only even if `sshd` is misconfigured.

The client starts OpenSSH with a fresh configuration and no interactive or agent fallback. Its effective shape is:

```text
ssh -F none -N \
  -L 127.0.0.1:<random-local-port>:127.0.0.1:<remotePort> \
  -p <port> -i <identityFile> \
  -o BatchMode=yes -o ExitOnForwardFailure=yes \
  -o ConnectTimeout=5 -o ConnectionAttempts=1 \
  -o ForwardAgent=no -o RequestTTY=no \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=<knownHostsFile> -o GlobalKnownHostsFile=none \
  -o IdentitiesOnly=yes -o IdentityAgent=none \
  -o ProxyCommand=none -o PermitLocalCommand=no \
  <user>@<host>
```

It supplies a minimal process environment (`PATH`, `SystemRoot`, and `WINDIR` when available), discards SSH stdout/stderr, waits for the local forwarding listener, then checks remote `/health`. It does not use SSH shell execution, `ProxyCommand`, an SSH agent, a tty, or a user/global SSH configuration.

## Local startup files and approval keys

Create a local SSH authority startup file, readable only by the local service account:

```json
{
  "host": "reviewed-authority.example.invalid",
  "user": "oph_research",
  "port": 22,
  "identityFile": "C:\\controlled\\keys\\oph-research",
  "knownHostsFile": "C:\\controlled\\keys\\known_hosts",
  "knownHostsHash": "sha256:REPLACE_WITH_64_LOWERCASE_HEX",
  "remotePort": 18443,
  "token": "REPLACE_WITH_THE_REMOTE_AUTHORITY_TOKEN",
  "authorityId": "institution-research-authority-01"
}
```

The client requires all ports to be 1–65535, validates host/user syntax, requires regular non-symlink identity and `known_hosts` files, and checks the entire `known_hosts` file digest at creation and before tunnel startup. It includes the host, port, user, identity-file path, known-hosts digest, authority ID, remote port, and optional tracking policy hash in `backendPolicyHash`; changing one requires a newly bound approval.

Generate the pinned digest from the reviewed `known_hosts` bytes. Verify the host key fingerprint through the institution’s independent channel before writing this file; `ssh-keyscan` output by itself is not verification.

```powershell
$digest = (Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\controlled\keys\known_hosts').Hash.ToLowerInvariant()
"sha256:$digest"
```

For human approvals, start the local server with a separate public-key configuration and a deployment manifest whose Ed25519 SPKI hashes exactly match that public-key configuration. The deployment manifest also pins the local bind host and permits the daemon only in the standard boundary.

```text
oph serve --host 127.0.0.1 \
  --research-human-auth C:\controlled\research-human-auth.json \
  --research-deployment C:\controlled\research-deployment.json \
  --research-ssh-daemon C:\controlled\ssh-authority.json
```

The public-key approval file contains reviewer public keys and reviewer IDs, never private signing material. The human approval scope must bind the exact dispatch key, task/artifact inputs, budget, expiry, `backendPolicyHash`, and tracking policy hash when one is configured.

## Operation and recovery

1. Confirm that the remote supervisor reports the daemon service healthy without copying its token to logs.
2. Start local `oph serve` using the three pinned configuration files above. A tunnel is opened lazily when research work needs it.
3. Submit through the normal approval-gated research API. The same dispatch key and specification hash return the same remote job; a different specification for that key conflicts.
4. On a local network loss, record the local outcome as `unknown`. Do **not** submit a replacement job. Restore the tunnel and query the same dispatch key; only a verified remote terminal observation can resolve it.
5. `close()` or stopping the local tunnel only stops local transport. It is not a remote cancellation. Use the approved cancellation path, then query the remote authority until it confirms a terminal state.
6. A receipt is accepted only after the client verifies authority identity, job binding, content hash, and the fixed receipt contract. An exit code or a TCP connection alone is not a research result.

## Verification status

The repository tests cover an injected loopback authority transport, authority-ID pinning, exact job binding, receipt hash/header validation, response size limits, disconnect handling, and no client-side resubmission. They do **not** prove that an institution’s `sshd`, ACLs, firewall rules, service supervisor, account restrictions, key lifecycle, host-key fingerprint verification, or remote hardware are correctly configured.

Perform and retain a separate non-patient acceptance record before use: a reviewed host-key fingerprint, SSH forwarding policy, firewall/ACL evidence, supervisor configuration, restart behavior, cancellation confirmation, and a disconnected/reconnected observation of one fixed synthetic dispatch key. Do not call that record a clinical acceptance.
