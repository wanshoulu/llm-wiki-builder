# Update and Versioning

## Update modes

Classify every detected change as:

- `unchanged`: no semantic effect;
- `editorial`: wording changes without review-logic change;
- `scope_change`: applicability changes;
- `rule_change`: requirement or prohibition changes;
- `new`: new knowledge;
- `deprecated`: no longer recommended but retained for history;
- `superseded`: replaced by a specified page or source.

## Update procedure

1. Compare source identity, version, clauses and effective periods.
2. Identify affected pages through source and relationship indexes.
3. Reassess downstream judgment methods, examples and indexes.
4. Preserve the stable ID when the principal review decision remains the same.
5. Create new IDs for independent new decisions or page splits.
6. Record `supersedes` and `superseded_by` when replacement occurs.
7. Do not delete historical pages required for audit; change status and retrieval eligibility.
8. Require renewed approval for semantic, scope or rule changes.

## Retrieval behavior

Production retrieval should prefer `published` pages effective for the current date and institution. Deprecated or superseded pages remain addressable for audit but must not be treated as current guidance.

## Change report

Include source changes, impacted page IDs, relationship changes, unresolved conflicts, required approvals and intended effective date.
