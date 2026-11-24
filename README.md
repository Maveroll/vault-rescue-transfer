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
