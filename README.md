# Vault Rescue Transfer

An Obsidian plugin project for exporting separate, read-only snapshots of diverged vaults from desktop and mobile devices to a receiving computer. The snapshots can then be compared and reconciled locally.

The planned transfer path is device → transient relay → receiving computer. The relay is not intended to retain vault contents. The plugin and receiver have not yet been implemented.

## Recovery principles

- Keep each device's source vault unchanged during export.
- Store each snapshot in a separate directory on the receiving computer.
- Include attachments and account for Obsidian configuration files.
- Verify file counts and hashes before treating a snapshot as complete.
- Require an explicit export action and show transfer progress and errors.

The repository will hold the plugin source, build configuration, and release assets required for submission to the Obsidian Community directory. Server addresses, access tokens, vault contents, and personal backups must not be committed here.

## Project documents

- [Recovery workflow](docs/usage.md) — setup, transfer, interruptions, and verification (Russian).
- [Transfer requirements](docs/protocol.md) — inventory, file integrity, and resume behavior (Russian).
- [Relay deployment requirements](deploy/README.md) — hosting constraints and preflight checks (Russian).

These documents describe the intended first version, not implemented features. There is no installable release or build command yet. Plugin metadata, dependency versions, and build configuration will be added alongside the first implementation so they can be validated together.
