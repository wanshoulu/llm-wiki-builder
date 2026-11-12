# Structured Review Rule Model

## Object chain

Keep distinct objects and lineage:

```text
Source document → Source clause/content unit → Review rule
→ Judgment criterion → Wiki page → Runtime review finding
```

The Wiki page explains and links knowledge; it is not the only storage representation of a rule.

## Rule object

```yaml
rule_id: RULE-DOC-001
source:
  source_id: SRC-001
  clause_id: CLAUSE-010
  content_unit_id: UNIT-001
rule_type: prohibition
normative_text: 请示应当一文一事。
effect:
  authority_class: head-office-policy
  requirement_level: mandatory
  effective_from: 2026-01-01
scope:
  organization_ids: [ORG-ALL]
  document_type_ids: [DOC-TYPE-REQUEST]
conditions:
  - fact: independent_request_count
    operator: greater_than
    value: 1
decision:
  result: fail
  issue_type: multiple-independent-matters
exceptions: []
status: pending_review
```

## Rule effect and conflict

Do not hard-code a universal precedence order. Use the enterprise-approved authority model, considering source authority, issuing organization, applicability, effective period, explicit supersession, specialized versus general scope and authorized local refinement.

The model may detect a potential conflict but may not decide legal or institutional precedence unless an approved policy explicitly determines it.

## Composite rules

Represent prerequisites, conjunctions, alternatives and exceptions explicitly. Do not merge independent decisions into prose. A criterion may return `pass`, `warning`, `fail`, `not_applicable` or `manual_review`.

## Deterministic versus semantic checks

- Deterministic: required fields, dates, numbering, exact phrases, measurements and registered names.
- Semantic: document-type appropriateness, reasoning completeness, ambiguity and business consistency.
- Hybrid: semantic identification followed by deterministic policy evaluation.

Mark the execution mode so the review agent does not ask an LLM to perform exact validations better handled by code.
