# Source authority and overlays

## Source levels

| source_level | Typical sources | Role |
|---|---|---|
| national | laws, administrative regulations, official-document regulations, national standards | mandatory baseline or national guidance |
| industry | regulator rules and industry standards | industry-specific baseline |
| enterprise | internal policies, responsibilities and approved templates | lawful clarification, supplement or stricter enterprise control |
| case | historical documents and review cases | illustration only |

Record both `source_level` and `authority_level`. Source level describes provenance; authority level expresses the effective hierarchy within the current enterprise and jurisdiction.

## Resolution algorithm

Apply this order deterministically:

1. Exclude sources that are inactive, expired, not yet effective or outside the target scope.
2. Filter by organization, inheritance, exclusions, document type, direction, business domain and conditions.
3. Preserve mandatory national and regulator requirements as the floor.
4. Allow an enterprise rule to `clarify`, `supplement` or `tighten` that floor within lawful scope.
5. Never use `replace` when it would weaken or contradict a mandatory higher-authority rule.
6. For rules at the same authority, prefer the more specific scope; then prefer the later effective source if the earlier source is explicitly superseded.
7. If these steps do not yield one safe result, create a `conflicts_with` relationship and set `conflict_strategy: pending_review`.

## Overlay behaviors

Use one controlled value:

- `baseline`: establishes the applicable floor.
- `clarify`: explains how the baseline applies without changing its effect.
- `supplement`: adds a requirement not addressed by the baseline.
- `tighten`: imposes a stricter enterprise control that remains lawful.
- `replace`: replaces only a lower/equal-authority rule where replacement is explicitly supported.
- `illustrate`: case evidence only; never normative.

## Required conflict record

Each unresolved conflict records the competing rule IDs, source IDs, overlapping scope, conflicting wording, attempted resolution, accountable owner and current status. Do not hide a conflict inside prose.

