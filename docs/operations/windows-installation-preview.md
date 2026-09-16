# HoneyBee installation layout preview

This preview contains Desktop, CLI and a private Node.js runtime in one directory.
Launch `HoneyBeeLauncher.exe` for Desktop, or run `bin\honeybee.exe` from a terminal.
Keep the entire directory together. Windows 11 x64 and Git for Windows are required.

This is not HoneyBeeSetup.exe. It does not install or update the Windows Storage
Service, change PATH, or relocate existing projects. Workspace operations require
an already compatible service. Use `bin\honeybee.exe doctor --json` to inspect it.

New projects registered with this installation's default tools are connected to
the installation. Existing projects keep their original tools until explicitly
adopted. First select the project ID from `bin\honeybee.exe project list --json`.

```powershell
.\bin\honeybee.exe project adopt-tools <project-id> --json
.\bin\honeybee.exe project adopt-tools <project-id> --apply --json
```

The first command only previews. Apply requires the old tools to match the approved
storage binaries and the installed service to pass compatibility checks. Missing,
custom or incompatible tools remain unchanged. Do not remove old archives before
adoption. Apply preserves the original tool path and makes a registry backup whose
path appears in the result. It does not rebuild caches, remove Workspaces or run
service replacement.

Keep this installation at the same path after adopting projects. Updates and
rollback are not available yet; do not edit `current.json` manually on a working
installation. Use the stable entry points for adopted projects. Older HoneyBee
builds do not preserve the new binding metadata when they rewrite the registry.

Registry backups are recovery evidence. Do not overwrite newer user state with an
old backup without closing HoneyBee clients and comparing the records first.
