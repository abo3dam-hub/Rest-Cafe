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
