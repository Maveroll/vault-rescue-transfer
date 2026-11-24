# Vault Rescue Transfer

An Obsidian plugin project for exporting separate, read-only snapshots of diverged vaults from desktop and mobile devices to a receiving computer. The snapshots can then be compared and reconciled locally.

The planned transfer path is device → transient relay → receiving computer. The relay is not intended to retain vault contents. Version 0.1.0 is an installable plugin scaffold with a relay URL setting and a local address check. File transfer, relay, and receiver are not implemented.

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

The transfer documents describe planned behavior, not implemented transfer features.

## Build and install the preview

Use Node.js 22 or newer and npm:

```sh
npm ci
npm run build
```

Copy the generated `dist/vault-rescue-transfer` folder into your vault's plugin directory (normally `.obsidian/plugins/`). The resulting plugin folder must contain `main.js` and `manifest.json`. Reload Obsidian and enable Vault Rescue Transfer in Community plugins.

Open its settings, enter an HTTPS relay URL, and select **Сохранить**. Run **Проверить готовность** from the settings or command palette. This checks only the saved address format; it does not contact the server or read/export notes. Emptying and saving the address clears it. No session code is requested or stored in this preview.

`npm run check` checks TypeScript. `npm run dev` watches source files and rebuilds the root `main.js`; run `npm run build` again to refresh the installable folder in `dist`.

Minimum Obsidian version is conservatively set to 1.14.4, matching the API dependency. Mobile compatibility is intended; installation and behavior on actual devices still require verification. No public release has been published.
