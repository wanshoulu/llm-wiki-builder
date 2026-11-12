# Quality Gates

## Gate sequence

| Gate | Question | Blocking conditions |
|---|---|---|
| Source | Is every normative claim traceable? | missing source, clause or verbatim text for mandatory/prohibited rule |
| Ingestion | Was the source parsed without losing material structure? | missing attachment, malformed table, unresolved reading order, low-confidence normative OCR |
| Registry | Do scope identifiers resolve? | unknown organization, document type, domain or source ID |
| Scope | Is applicability explicit? | unknown institution, document type, direction, domain or effective period where material |
| Atomicity | Can the page change independently? | unrelated review decisions combined |
| Fidelity | Does the page preserve the source meaning and strength? | strengthened, weakened or fabricated requirement |
| Relations | Are dependencies, exceptions, conflicts and links valid? | broken target, concealed conflict, circular prerequisite without explanation |
| Execution | Can a reviewer or agent apply it? | vague judgment method, missing required context, invented threshold |
| Governance | Is publication authorized and versioned? | placeholder owner, unresolved conflict, unapproved generated content |
| Release | Is publication externally evidenced? | missing approval record or active release-manifest entry |

## Release policy

- Structural validation may be automated.
- Semantic fidelity and business correctness require an accountable human reviewer.
- `draft` and `pending_review` pages stay outside production retrieval by default.
- Release manifests list included page IDs, source versions, validation result, approver and release timestamp.
- A failed gate produces a blocking issue, not an automatically repaired fact.

## Required metrics

Report counts for:

- pages by domain, type and status;
- mandatory/prohibited pages with complete verbatim evidence;
- pages with unresolved scope;
- broken relationships;
- source conflicts;
- placeholders and missing owners;
- created, changed, deprecated and superseded pages for an update.

Do not present a single aggregate score as proof of correctness.

## Manual sampling

Before release, sample across every knowledge domain and high-risk business domain. For each sample, compare the source, summary, requirement level, applicability, judgment method and proposed review output. Expand sampling when any material defect appears.
