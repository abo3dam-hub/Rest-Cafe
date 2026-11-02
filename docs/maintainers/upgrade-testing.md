# Upgrade testing

Rest&Cafe updates are manual: the owner downloads a new installer built from this repository
and installs it over the existing app. There is no in-app updater and no staged rollout, so
upgrade safety is a data question, not a delivery question — the new build must open the
existing database, migrate it forward, and lose nothing.

## What proves an upgrade is safe

- **Pre-migration backups.** Before any schema migration runs, the app writes a timestamped
  backup of the database into the user-data folder. A failed migration leaves the shop on its
  backup, not on a half-migrated database.
- **Migration suites.** The migration registry, the fresh-database path, and the upgrade path
  from historical schemas are covered by automated suites:

  ```sh
  npm run test:migration-registry
  npm run test:upgrade-path
  npm run test:schema-health
  ```

- **Data invariants.** Existing customer data must survive upgrades; migrations never reset,
  truncate, or drop user data as a shortcut (see the repository `AGENTS.md`).

## Release check

Before handing a new installer to a restaurant, run the migration suites above plus the
focused suites for whatever changed, then install the new build over a copy of a real
database and open the app once to confirm it starts on the migrated data.

## Restore onto a replacement host

When the host machine is lost or replaced, the store is recovered from a backup onto a
fresh install. Install the same build on the replacement machine first: a restore only
accepts a backup whose schema version the build supports, and the usual case (the same
build on both machines) restores directly. A backup from an older build restores
data-only instead.

### Before you start

- Find the newest backup. Daily local backups are files named
  `rest-cafe-backup-<timestamp>.db` in `Documents\RestCafe\Backups` on the old host
  (outside the app data, so they survive a reinstall and an uninstall). A manual backup
  downloaded from Settings → Database → Backup History works the same way. Copy the file
  to the new machine (USB stick or network share).
- Do not delete the backup from the old host until the new host is verified.

### Steps

1. Install the same Rest&Cafe build on the replacement machine and open it once.
2. Complete first-run setup. The owner account created here is the account you log in
   with after the restore — write its password down.
3. Copy the backup file onto the new machine.
4. Log in with the setup account, open Settings → Database, choose Restore from file,
   pick the backup, and type the confirmation phrase.
5. Log in again with the setup credentials. The restore replaces the database with the
   backup's data; the setup owner stays the active owner, so those are the credentials
   that work.

### What survives, and what does not

- Orders, bills, products, categories, customers, and settings come back from the
  backup. The backup's owner and staff accounts are present in the restored database
  but disabled: a restore never lets an older snapshot resurrect accounts on a store
  that already has an owner. To use the original owner account again, the setup owner
  re-enables it from the Staff page; re-check its kitchen station assignments
  afterwards, because the merge keeps only the live store's assignments.
- KDS pairing tokens and customer-display tokens are cleared by every restore, so
  tablets and the customer display must be paired again. Pairing itself is unchanged.
- Printer records travel with the backup, but the physical printer must be attached to
  the new machine; check Settings → Printers and re-select the default if the new host
  sees the printer under a different name.
- The restore keeps a safety copy of the database it replaced
  (`rest-cafe-backup-<timestamp>-pre-restore-v<version>.db` in the backups folder), so
  a restore of the wrong file can be undone by restoring that copy.

### If the restore runs before any setup

Restoring onto a database that has no users at all (for example through the restore API
before first-run setup) keeps the backup's accounts exactly as the backup had them: the
backup owner stays active and its password and PIN keep working, because there is no
live owner whose credentials the merge must protect. The suite
`tests/restore-fresh-install.test.ts` proves both cases: the backup owner survives a
userless restore, and a backup-only account stays disabled when the live store already
has users.

### Verify before reopening

- Log in, open the POS, and open a recent order and bill.
- The Staff page shows the expected accounts (the setup owner active; the backup
  accounts present but disabled until re-enabled).
- Settings → Database → Local backup shows the daily backup running from the new
  machine's `Documents\RestCafe\Backups`.
- Pair one tablet and confirm the KDS board loads orders.
