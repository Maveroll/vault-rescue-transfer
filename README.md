# Vault Rescue Transfer

**[Download 0.3.0](https://github.com/Maveroll/vault-rescue-transfer/releases/tag/0.3.0) · [Установка на ноутбук: BRAT или ZIP](docs/install.md)**

An Obsidian plugin project for exporting separate, read-only snapshots of diverged vaults from desktop and mobile devices to a receiving computer. The snapshots can then be compared and reconciled locally.

Version 0.3.0 creates local snapshots on desktop or sends a vault through a transient HTTPS relay to a receiving computer. Files are checked with SHA-256. The relay does not write vault contents to disk. Mobile sending is not implemented yet.

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

Local export and desktop network transfer are available. Resume after interruption is still planned; version 0.3.0 starts a new snapshot on each attempt.

## Build and install the preview

Use Node.js 22 or newer and npm:

```sh
npm ci
npm run build
```

Copy the generated `dist/vault-rescue-transfer` folder into your vault's plugin directory (normally `.obsidian/plugins/`). The resulting plugin folder must contain `main.js` and `manifest.json`. Reload Obsidian and enable Vault Rescue Transfer in Community plugins.

## Create a local snapshot

1. In the plugin settings, set **Папка снимков** to an absolute path outside the source vault and select **Сохранить**. The path stays in local plugin settings.
2. Pause synchronization and editing. Select **Создать снимок** in settings or the command palette.
3. Check the source and destination in the dialog, then start. Keep the dialog open; closing it cancels the export.
4. Wait for **Проверено**. Each run creates a new uniquely named folder containing `vault/` (the copied vault) and `snapshot.json` (inventory, SHA-256 hashes, exclusions, status, and errors).

Hidden files, attachments, and empty directories are included. Only `workspace.json` and `workspace-mobile.json` in Obsidian's configuration directory are excluded because the running app changes them. Symbolic links and special files cause an explicit failure. The destination must not resolve inside the source vault.

Files are streamed to temporary files, checked, and then renamed into the snapshot. A final pass rechecks the source inventory, source hashes, and copied hashes. The source must remain unchanged; this is not an atomic filesystem snapshot. Cancellation or an error leaves an incomplete/failed/cancelled report and any partial files for inspection. Restart creates a new snapshot; resume is not yet implemented. No source files are deleted or modified by export.

## Send from a laptop

1. Deploy `dist/relay.cjs` behind HTTPS following [deployment instructions](deploy/README.md).
2. On the receiving computer (Node.js 22+), run:

```sh
node dist/receiver.cjs --relay https://relay.example.com/vault-rescue --destination /absolute/snapshot/folder --key-file /private/path/admin.key
```

3. Copy the one-session connection code shown by the receiver. Keep its window open.
4. On the sending computer, save the relay URL in plugin settings and select **Отправить снимок**. Paste the full connection code, pause editing and synchronization, and start.
5. Wait for the receiver's verification confirmation. The received snapshot has `vault/` and `snapshot.json`, like a local snapshot.

Closing the sending dialog cancels the transfer. After a failure, restart the receiver for a new code and a new snapshot directory. No source files are modified by sending. The connection code is not saved in plugin settings. The receiver's administrative key must stay outside the repository and must not be copied to sending devices.

TLS protects connections to the relay; this version does not provide end-to-end encryption against the relay operator. Use a trusted server. Only one chunk is in flight per session, with a 192 KiB binary chunk size. The relay waits for the receiving computer's acknowledgement before accepting another chunk. Receiver checks reject unsupported Windows names, case collisions, path traversal, and bad hashes.

**Проверить готовность** still checks only address syntax. The relay address is not needed for local export.

`npm run check` checks TypeScript. `npm test` exercises copying, cancellation, source changes, corruption, and path/link guards in ignored `test-results/` fixtures. `npm run dev` watches source files and rebuilds the root `main.js`; run `npm run build` again to refresh the installable folder in `dist`.

Minimum Obsidian version is conservatively set to 1.14.4, matching the API dependency. This version is marked desktop-only because local export uses Node filesystem APIs. A future mobile sender will require a separate compatible implementation. The plugin is distributed through GitHub Releases; it is not listed in the Obsidian Community directory yet.
