# Provenance

EdgeSSH Workbench has a new package name, architecture, deployment configuration, and source tree. The reference repositories are not runtime dependencies and their Git histories are not embedded here.

## Design references

| Reference | Reviewed commit | License | Influence |
| --- | --- | --- | --- |
| `cmliu/CF-Workers-WebSSH` | `17288a98c92433f07207ae717fe3ec00be967e5c` | Apache-2.0 | Worker-native SSH transport, host-key and session security behavior |
| `619dev/tafeng` | `d53d8cedfdc41df71cad5758e87341dc1568e7e2` | MIT | Workbench layout, React/xterm integration, SFTP and monitoring product shape |

The requirements review classifies reusable behavior and rejected implementation patterns in [`../../WEBSSH_WORKBENCH_REQUIREMENTS.md`](../../WEBSSH_WORKBENCH_REQUIREMENTS.md). New implementation work uses shared contracts, D1, encrypted credential records, per-session Durable Objects, and binary transfer framing rather than importing either reference application.

## Adapted compatibility shim

`apps/worker/shims/cpu-features` follows the two-line no-native-addon behavior used by Tafeng so that the MIT-licensed `ssh2` package can run in Workers. Tafeng's MIT attribution is retained in `THIRD_PARTY_NOTICES.md`.

Future code copied or substantially adapted from a reference must record the upstream file, commit, date, changes, and applicable license here before release.
