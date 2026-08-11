# ADR 0028: Versioned configuration migrations

- Status: Accepted
- Date: 2026-08-10

The version-two target recorded here is historical. ADR 0030 advances the
canonical schema to version 3 through the ordered migration required by this
decision.

## Context

The local JSON configuration remained labeled version 1 while new settings were
added with parser-level defaults. That kept old installations running, but it
made the version field inaccurate: a newly written file and an early version-one
file could have materially different shapes. It also allowed a current file to
silently omit fields that should be explicit and user-editable.

## Decision

- Configuration version 2 is the canonical in-memory and on-disk shape written
  by the application.
- Continue accepting version-one files through an in-memory migration. Existing
  safe defaults remain the migration policy, including disabled scanner and
  camera behavior, shipment confirmation, inventory-queue defaults, starter
  profiles, seller-band fields, and the legacy `dryRun` safety conversion.
- Do not modify a configuration file merely because the application starts or a
  validation command reads it. The next successful Settings save atomically
  writes the fully normalized version-two document.
- Require migration-owned fields in a version-two input. A version-two file may
  not rely on legacy defaults or contain the removed `dryRun` switch.
- Reject unknown and future versions with an explicit update-required error.
  Future schema changes must add an ordered migration before current-schema
  validation instead of extending version 2 in place.
- Migrations are pure: parsing must not mutate the caller's object, access
  secrets, contact providers, or perform side effects.

## Consequences

Old local installations continue to load safely, while every parsed
configuration now has one complete version-two shape. Saved files become
self-describing and missing current settings fail with actionable paths. The
application must retain version-one migration tests until support for that input
is deliberately removed.
