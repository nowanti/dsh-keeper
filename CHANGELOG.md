# Changelog

## 0.3.0

- Rename the public project and executable to `dshkeeper` to avoid collisions with existing DSH remote-control and service-control projects.
- Add English and Simplified Chinese CLI rendering with `--lang`, `DSHKEEPER_LANG`, and system-locale selection.
- Upgrade assessment receipts to schema version 2 with stable diagnostic reason codes and structured parameters.
- Add secure Windows `.cmd` execution, CIM process discovery, and native process lifecycle tests.
- Add a reproducible real-DSH profile E2E for macOS, Linux, and Windows CI.
- Add three-platform GitHub Actions, npm packaging checks, OIDC/provenance release automation, artifact attestations, and Dependabot.

## 0.2.3

- Keep normal success output concise and move phase timings behind `--verbose` and JSON.
- Document the original macOS/Linux/Windows portability boundary.
