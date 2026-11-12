# Wiki Framework

## Design principle

The Wiki is navigated through multiple views; it is not a single fixed folder tree. Store each atomic page once and expose it through indexes.

## Six knowledge domains

| Code | Domain | Contains | Excludes |
|---|---|---|---|
| 01 | Document type and format | document-type selection, direction, title, addressee, body, signature, date, pagination, layout | business correctness |
| 02 | Language expression | formal wording, tone, ambiguity, redundancy, prohibited expressions, common sentence defects | typography-only checks |
| 03 | Content structure | required sections, logical sequence, issue-evidence-conclusion completeness | domain policy decisions |
| 04 | Policy and regulation | regulatory rules, superior policies, internal policies, applicability, exceptions, conflicts | unsupported interpretations |
| 05 | Business-domain knowledge | terminology, process, metric definitions, authorization boundaries, risks, professional review criteria | generic writing advice |
| 06 | Historical documents and cases | approved examples, defects, review comments, before/after revisions, disposition results | rules not grounded in authoritative sources |

## Required navigation indexes

Create index pages for:

- document type: notice, request, report, reply, minutes, letter, decision and locally approved types;
- review dimension: type, format, structure, language, content, compliance and business correctness;
- business domain: use the enterprise's actual domain taxonomy;
- issuing relationship: upward, downward, parallel and internal;
- institution and version: applicable organization, effective date, expiry date and supersession;
- source: source document to derived pages;
- review issue: frequent defect to rule, evidence and case.

Do not invent a document type or business domain merely to make the directory symmetrical.

## Recommended repository layout

```text
wiki-root/
├── index.md
├── sources/
│   └── canonical-documents/
├── rules/
├── 01-document-type-and-format/
├── 02-language-expression/
├── 03-content-structure/
├── 04-policy-and-regulation/
├── 05-business-domain/
├── 06-history-and-cases/
├── indexes/
│   ├── by-document-type.md
│   ├── by-review-dimension.md
│   ├── by-business-domain.md
│   ├── by-source.md
│   └── by-version.md
└── governance/
    ├── organization-registry.yaml
    ├── document-type-registry.yaml
    ├── business-domain-registry.yaml
    ├── source-register.yaml
    ├── pending-review.md
    ├── conflicts.md
    └── release-manifest.yaml
```

Folder location is a primary placement, not the complete meaning of a page. Cross-domain relationships belong in metadata and indexes.

The source, registry and rule layers are authoritative structured assets. Markdown Wiki pages are the LLM-facing organization and explanation layer.

## Granularity rule

One page should have one principal review decision. Split when two requirements:

- have different sources or owners;
- apply to different document types or organizations;
- have different requirement levels;
- can be revised or retired independently;
- require different judgment methods.

Keep tightly coupled definition, applicability, judgment method, evidence and examples together.
