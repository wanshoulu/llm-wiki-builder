# Knowledge Page Schema V1.0

Every page is Markdown with YAML frontmatter. Published identifiers must resolve through governance registries.

```yaml
knowledge_id: DOC-REQUEST-001
title: 请示应当一文一事
knowledge_domain: document-type-and-format
knowledge_type: mandatory-rule
document_type_ids: [DOC-TYPE-REQUEST]
review_dimensions: [文种, 内容结构]
applicable_scope:
  organization_ids: [ORG-ALL]
  excluded_organization_ids: []
  inheritance_mode: inherit_to_descendants
  direction: upward
  business_domain_ids: [DOMAIN-GENERAL]
  conditions: []
requirement_level: mandatory
execution_mode: hybrid
status: pending_review
effective_date: 2026-01-01
expiry_date:
owner_role: 办公室制度Owner
source:
  source_id: SRC-001
  clause_id: CLAUSE-010
  source_text: 请示应当一文一事。
  evidence:
    content_unit_id: UNIT-001
    page: 6
    paragraph: 3
    extraction_method: native
    confidence: 0.99
relationships:
  - type: illustrated_by
    target_id: CASE-REQUEST-021
    condition:
supersedes: []
superseded_by: []
approval:
  approval_record_id:
  reviewer_id:
  reviewer_role:
  reviewed_at:
---
```

## Controlled values

- `knowledge_domain`: `document-type-and-format`, `language-expression`, `content-structure`, `policy-and-regulation`, `business-domain`, `history-and-cases`.
- `knowledge_type`: `definition`, `mandatory-rule`, `prohibition`, `recommendation`, `judgment-method`, `template`, `case`, `term`.
- `requirement_level`: `mandatory`, `prohibited`, `recommended`, `informative`.
- `execution_mode`: `deterministic`, `semantic`, `hybrid`, `human_only`.
- `status`: `draft`, `pending_review`, `published`, `deprecated`, `superseded`.
- `direction`: `upward`, `downward`, `parallel`, `internal`, `multiple`.
- `inheritance_mode`: `exact`, `inherit_to_descendants`, `inherit_with_override`.

## Required body sections

Rule and judgment pages require `规则摘要`, `适用与不适用`, `判断方法`, and `依据`. Add examples, revision suggestions, exceptions and conflicts only when supported. Cases require context, observed issue, applied rule, review decision, revision and result.

## Publication invariants

A published page must:

- resolve all organization, document-type, business-domain, source and evidence-unit IDs;
- have a non-placeholder owner, effective date and approval record;
- appear in the external release manifest with the same approval record;
- preserve source text for mandatory and prohibited claims;
- contain typed relationships whose targets exist;
- have no unresolved material conflict or applicability uncertainty.

The model generates draft metadata only. Approval and published status are external workflow outputs.

## Identity and granularity

`knowledge_id` is stable. Preserve it when the principal decision remains the same. Create new IDs for page splits or independent new decisions and record supersession. Keep one principal review decision per page.
