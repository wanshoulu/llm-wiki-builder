# Relationship Rules

Relationships make the Wiki usable across pages. Store typed targets by stable `knowledge_id`; never collapse them into an untyped `related_pages` list.

## Relationship types

| Relationship | Meaning | Example |
|---|---|---|
| `belongs_to` | classification membership | request rule belongs to upward documents |
| `applies_to` | applicability | budget rule applies to financial requests |
| `requires` | prerequisite evidence or knowledge | payment request requires authorization rule |
| `exception_to` | explicit exception | emergency procedure is exception to standard timing |
| `conflicts_with` | unresolved or scoped conflict | old internal rule conflicts with new superior rule |
| `supersedes` | replacement | revised policy replaces prior page |
| `related_to` | useful, non-dependent relation | request ending language relates to request structure |
| `illustrated_by` | rule to case | one-matter rule illustrated by case C-014 |
| `implements` | judgment method implements rule | checklist implements format requirement |

## Rules

- Use the narrowest accurate relationship.
- Never use `related_to` to hide an actual prerequisite, conflict or exception.
- Create reciprocal indexes for navigation, but keep one authoritative relation declaration.
- A relationship proposal produced by a model remains pending until both pages exist and applicability is compatible.
- Broken IDs block publication.
- Conflicts must not be silently resolved. Record both sources, scopes, effective periods and the reviewer decision required.

## Page representation

```yaml
relationships:
  - type: requires
    target_id: DOC-AUTH-003
    condition: 涉及预算审批时
  - type: exception_to
    target_id: DOC-FORMAT-012
    condition: 紧急事项经授权处理时
```

Allowed relationship types are `belongs_to`, `applies_to`, `requires`, `exception_to`, `conflicts_with`, `supersedes`, `related_to`, `illustrated_by`, and `implements`.

## Conflict record

```yaml
conflict_id: CONFLICT-001
pages: [DOC-A-001, DOC-B-004]
conflict_dimension: requirement
source_comparison:
  - source: 制度A第十条
    statement: ...
  - source: 制度B第三条
    statement: ...
scope_analysis: ...
status: pending_review
decision_owner: 制度Owner
```
