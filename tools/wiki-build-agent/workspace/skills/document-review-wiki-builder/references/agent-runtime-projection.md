# Document-review Agent runtime projection

The authoritative Wiki is the source of truth. The projection is a deterministic, disposable build artifact containing only knowledge IDs present in `governance/release-manifest.yaml`.

## Required output paths

- `_common/format-profiles.md`: four-profile parameter table and document-type mapping consumed by `profile-loader.js`.
- `_common/punctuation-spec.md`: punctuation, numbering, date and common-error guidance.
- `_common/citations.md`: rule traceability, category fallback and final fallback tables consumed by `citations.js`.
- `doc-types/*.md`: one page per runtime document type, with `doc_type` and `title` frontmatter.
- `style/style-prompts.md`: language and tone guidance grouped by document type.
- `lexicon/taboo-words.md`: prohibited or discouraged expressions with replacement/advice tables.
- `projection-manifest.json`: source release, generated files and included knowledge IDs.

## Compilation rules

1. Read the external release manifest first.
2. Include only pages whose `knowledge_id` is released and whose status is `published`.
3. Resolve document types through `runtime_doc_type` in the document-type registry.
4. Preserve source title, clause and rule title in the citations table.
5. Copy common runtime templates from this Skill, then add released knowledge.
6. Never edit authoritative pages while compiling.
7. Write UTF-8 and use forward-slash relative paths in the projection manifest.

Run:

`python scripts/compile_agent_projection.py <wiki-root> --output <output-root>`

