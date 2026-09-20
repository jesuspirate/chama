# Separate brief: immutable escrow history migration

The September retention probe proves addressable replacement on three default
public relays. The community relay retains collisions, but redundancy cannot
rely on other relays implementing that exception.

Before writing a new wire format, allocate ordinary non-replaceable kinds and
specify a stable trade-index tag. Alternatively use a per-event discriminator
in `d` plus a separate trade tag; all readers would still need migration.
Choose after auditing every writer, reader, notification watcher and export.

Rollout must be reader-first: dual-read old/new formats, verify signatures,
normalize to one internal kind, and deduplicate equivalent transitions without
relaxing LOCK/CLAIM. Preserve original signed legacy events; changing a tag
invalidates a signature. Do not re-sign someone else's history. Recover legacy
chains from community relay and participant caches; missing data stays missing.

Only enable new writers once fleet compatibility is measured. Bound dual-publish
if used, specify cross-format dedup and rollback, and test mixed-version devices,
addressable-replacing relays, chat/hold renewal, cold replay, and subscriptions.
Migration acceptance requires a complete cold replay from independent relays
with the community relay unavailable. Rotation remains gated until the measured
retention risk is explicitly resolved in the release readiness decision.
