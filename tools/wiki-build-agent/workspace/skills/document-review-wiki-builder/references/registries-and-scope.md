# Registries and Applicability Scope

Published pages use stable IDs from governed registries. Free-text names are display labels only.

## Organization registry

Model hierarchy, aliases and status. Distinguish source issuer, applicable organizations, executing organizations, interpreting organization, knowledge owner, reviewer role and explicit exclusions.

Applicability supports `exact`, `inherit_to_descendants`, and `inherit_with_override`. A lower-level institution may refine a superior rule only within recorded authority. Never infer that a branch rule overrides a head-office or regulatory rule.

## Document-type registry

Register canonical name, aliases, category, direction, allowed issuers and recipients, required sections, local extensions, confusing types, status and supersession. Support statutory documents, internal management documents, approval forms, business-specialized documents, meeting documents and retired historical types.

## Business-domain registry

Use the enterprise's actual domain taxonomy with parent/child domains and aliases. Every published ID must resolve.

## Source register

Register source identity, issuer, authority class, file format, version, effective period, status, checksum, confidentiality, owner and canonical `content_unit_ids`.

## Scope representation

```yaml
applicable_scope:
  organization_ids: [ORG-ALL]
  excluded_organization_ids: [ORG-OVERSEAS]
  inheritance_mode: inherit_with_override
  document_type_ids: [DOC-TYPE-REQUEST]
  direction: upward
  business_domain_ids: [DOMAIN-FINANCE]
  conditions: [涉及预算审批]
```

Do not collapse issuer, applicability, execution and interpretation into one `institution` field.

## Resolution order

Filter by effective period and status, resolve organization inheritance, apply exclusions, match document type and direction, then match business domain and conditions. Unresolved overlap becomes a conflict record.
