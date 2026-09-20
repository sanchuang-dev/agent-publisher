# Chromium seccomp profile provenance

`seccomp-chromium.json` is the Docker Engine v28 default seccomp profile with
a narrow local delta for Chromium's Linux namespace sandbox.

## Upstream base

- Repository: `moby/moby`
- File: `profiles/seccomp/default.json`
- Docker Engine tag: `v28.1.1`
- Tag commit: `01f442b84d6a669c1e335b800d4670997cd5aa93`
- Retrieved/verified for this repository on: 2026-09-19

The vendored baseline, after removing the local Chromium rules below, was
normalized and compared against that tagged upstream file.

Do not silently refresh this profile. Updating the upstream base is a
security-boundary change and must be reviewed together with the local delta.

## Local delta

Docker's default profile denies namespace-creating `clone` calls and
`unshare` without `CAP_SYS_ADMIN`. Chromium's namespace sandbox needs a much
smaller exception:

- startup namespace creation may use `CLONE_NEWUSER`, optionally together
  with `CLONE_NEWPID` and/or `CLONE_NEWNET`;
- after the zygote has entered its user namespace, Chromium may fork a child
  with exactly `CLONE_NEWPID` in the namespace mask. Chromium's
  `NamespaceSandbox::ForkInNewPidNamespace()` uses
  `clone(CLONE_NEWPID | SIGCHLD)` for this path;
- `clone` remains denied when the namespace mask includes `CLONE_NEWNS`,
  `CLONE_NEWIPC`, `CLONE_NEWUTS`, or `CLONE_NEWCGROUP`;
- `unshare` is allowed only for exactly `CLONE_NEWUSER`.

The allowed combinations follow Chromium's Linux namespace sandbox contract:
`NamespaceSandbox` startup supports `CLONE_NEWUSER` (required),
`CLONE_NEWPID`, and `CLONE_NEWNET`; `Credentials::MoveToNewUserNS` uses
`unshare(CLONE_NEWUSER)`. Once the zygote is inside that sandbox,
`ForkInNewPidNamespace()` creates renderer/utility children with
`CLONE_NEWPID | SIGCHLD`, so the seccomp delta also permits the
`CLONE_NEWPID`-only namespace mask.

This service must not compensate for a broken sandbox by adding `SYS_ADMIN`,
using privileged mode, setting `seccomp=unconfined`, or starting Chromium with
`--no-sandbox`.

## Verification

Repository CI starts the real `browser-runtime` under this profile, waits for
Chromium health/CDP, opens a renderer target over CDP, checks the noVNC endpoint,
rejects `--no-sandbox`, and probes that unrelated mount-namespace creation is
still denied.
