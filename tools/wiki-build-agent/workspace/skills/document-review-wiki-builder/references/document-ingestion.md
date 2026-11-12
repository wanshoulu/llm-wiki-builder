# Heterogeneous Document Ingestion

## Principle

File parsing is part of knowledge correctness. Do not extract rules from undifferentiated plain text when hierarchy, layout, tables, comments, revisions, attachments or page location affect meaning.

## Supported source classes

| Format | Preferred extraction | Preserve | Block or review when |
|---|---|---|---|
| DOCX | native OOXML | headings, tables, headers/footers, text boxes, comments, tracked changes, numbering | unresolved revisions, missing embedded objects |
| PDF | native text plus layout | pages, blocks, reading order, tables, coordinates, fonts | corrupt text layer, uncertain reading order |
| scanned PDF/image | OCR plus layout analysis | page image, OCR text, regions, confidence, seals and handwriting flags | low confidence on normative wording |
| OFD | native OFD parser | pages, layout objects, signatures/seals and coordinates | unsupported signature or object |
| XLSX/CSV | native table parser | sheets, headers, cells, merged regions, formulas, comments | ambiguous header hierarchy |
| PPTX | native OOXML | slide order, titles, text boxes, tables, notes and diagram relations | meaning depends on unparsed graphics |
| HTML/Wiki | DOM parser | headings, lists, tables, links, version and attachments | dynamic content not captured |
| EML/MSG/archive | container-aware parser | sender, recipients, body, attachment graph, timestamps | attachment missing or encrypted |

Unknown proprietary formats remain `ingestion_blocked` until a verified adapter exists.

## Canonical document model

Every source becomes a canonical package before extraction:

```yaml
document:
  source_id: SRC-001
  file_format: docx
  checksum: sha256:...
  title: 公文处理管理办法
  issuer_organization_id: ORG-HO-OFFICE
content_units:
  - content_unit_id: UNIT-001
    type: paragraph
    hierarchy_path: [第三章, 第十条]
    text: 请示应当一文一事。
    location: {page: 6, paragraph: 3}
    extraction_method: native
    confidence: 0.99
quality: {status: passed, warnings: []}
```

## Evidence requirements

- Assign a stable `content_unit_id` to every paragraph, table, cell, note or image region.
- Preserve verbatim source text and location; do not cite only a generated chunk.
- Record parser or OCR method and confidence.
- For tables, preserve row/column headers and merged-cell relationships.
- For tracked changes, retain accepted text, rejected text and revision status separately.
- For scans, normative claims below the approved OCR threshold require human verification.
- Keep source checksum and access classification so extraction can be reproduced.

Do not start rule extraction when required pages or attachments are missing, reading order is unresolved, encrypted content is inaccessible, material tables are malformed, or normative text has unverified OCR uncertainty.
