# Chromium seccomp profile provenance

`seccomp-chromium.json` is derived from the Moby default seccomp profile and then
narrowly extended for Chromium's Linux namespace sandbox.

## Upstream base

- Repository: `moby/profiles`
- File: `seccomp/default.json`
- Pinned upstream commit: `245180c51918481c0525424b3ee025d2b435d46c`
- Retrieved for this repository on: 2026-09-19

Do not silently refresh this vendored profile. Updating the upstream base is a
security-boundary change and must be reviewed together with the local delta.

## Local delta

Docker's default profile denies namespace-creating `clone` calls and
`unshare` without `CAP_SYS_ADMIN`. Chromium's namespace sandbox needs a much
smaller exception:

- `clone` may create `CLONE_NEWUSER`, optionally together with
  `CLONE_NEWPID` and/or `CLONE_NEWNET`;
- `clone` remains denied when the namespace mask includes `CLONE_NEWNS`,
  `CLONE_NEWIPC`, `CLONE_NEWUTS`, or `CLONE_NEWCGROUP`;
- `unshare` is allowed only for exactly `CLONE_NEWUSER`.

The allowed combinations follow Chromium's Linux namespace sandbox contract:
`NamespaceSandbox` supports `CLONE_NEWUSER` (required), `CLONE_NEWPID`, and
`CLONE_NEWNET`; `Credentials::MoveToNewUserNS` uses
`unshare(CLONE_NEWUSER)`.

This service must not compensate for a broken sandbox by adding `SYS_ADMIN`,
using privileged mode, setting `seccomp=unconfined`, or starting Chromium with
`--no-sandbox`.

## Verification

The repository CI starts the real `browser-runtime` under this profile, waits
for Chromium health/CDP, checks the noVNC endpoint, rejects `--no-sandbox`, and
probes that unrelated mount-namespace creation is still denied.
