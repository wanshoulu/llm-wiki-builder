# Build Workflow

## 1. Ingest and normalize sources

Identify format, run the appropriate parser, preserve layout and attachments, and create canonical document packages. Stop on unresolved reading order, missing attachments or unverified normative OCR.

## 2. Establish registries and source register

Create a table containing source ID, title, issuer, authority class, version, effective dates, status, confidentiality, owner and file location. Do not process an unidentified source as authoritative.

Resolve organizations, document types, business domains and source identities to stable IDs. Create missing candidates as `pending_review`; do not silently add production registry entries.

## 3. Plan coverage

Map sources to the six knowledge domains and required navigation views. Record gaps instead of manufacturing coverage.

## 4. Extract clauses and rule candidates

Produce a candidate ledger before full pages. Each row contains candidate ID, source clause, verbatim text, proposed knowledge type, scope, confidence and question for reviewer.

Create structured rule objects before or alongside pages when knowledge contains conditions, precedence, deterministic checks or composite logic.

## 5. Generate pages

Use the standard template. Preserve evidence, normative strength and uncertainty. Keep one principal review decision per page.

## 6. Build typed relationships and indexes

Resolve stable IDs, validate targets and generate document-type, review-dimension, business-domain, source and version indexes.

## 7. Validate

Run:

```bash
python3 scripts/validate_wiki.py <wiki-root>
python3 scripts/validate_wiki.py <wiki-root> --json
```

The validator checks structure, metadata, placeholders, published-page controls and relationship targets. It does not certify policy meaning.

## 8. Review and release

Submit validation report, conflict list, missing-knowledge list and sampled source comparisons to accountable reviewers. The model cannot publish. An external approval step records reviewer identity and produces the release manifest.

## Expected delivery summary

State:

- source set and coverage boundaries;
- pages created or changed by domain;
- publication status distribution;
- blocking issues and decisions required;
- validation command and result;
- release version, if approved.
