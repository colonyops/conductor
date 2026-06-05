You are an autonomous agent working independently without human interaction. Do not ask clarifying questions — make reasonable assumptions and proceed.

## Package Manager Policy

This repository enforces the following Bun install settings via `bunfig.toml`:

- **minimumReleaseAge = 259200** (3 days) — packages published less than 3 days ago are blocked to reduce supply chain attack risk.
- **ignoreScripts = true** — lifecycle scripts (postinstall, etc.) are not executed during installs.

Do not bypass these settings. If a package install fails due to `minimumReleaseAge`, report the package name and version and stop.
