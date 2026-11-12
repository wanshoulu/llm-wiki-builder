# Extraction and Writing Rules

## Source trust order

Apply the enterprise's approved authority order. If none is supplied, do not invent one; record the conflict for review. Typical source classes include law and regulation, superior policy, internal policy, approved template, operating standard, authoritative interpretation and historical case.

## Extraction sequence

For each source:

1. Record title, issuer, version, effective period, status and accountable owner.
2. Identify document types, institutions, directions and business domains covered.
3. Extract candidate definitions, mandatory rules, prohibitions, recommendations, judgment methods, templates and cases.
4. Split candidates into atomic review decisions.
5. Preserve verbatim evidence and clause location.
6. Draft a faithful summary, applicability and executable judgment method.
7. Link prerequisites, exceptions, conflicts, related knowledge and examples.
8. Set `pending_review` unless an authorized reviewer has approved publication.

## Language-strength preservation

Do not strengthen or weaken normative force.

| Source wording | Allowed level |
|---|---|
| 必须、应当、不得、严禁 | mandatory or prohibited |
| 原则上、一般应 | preserve the qualifier; record exceptions if stated |
| 宜、建议、可 | recommended |
| 案例中采用 | informative unless a rule source confirms it |

Never convert a common practice into a mandatory rule.

## Judgment methods

Translate evidence into reviewable steps only when the steps follow from the source. A useful method states:

- input or document element to inspect;
- conditions to evaluate;
- required contextual facts;
- pass, warning, fail or manual-review outcome;
- exception handling;
- evidence to cite.

Do not invent numeric thresholds. If interpretation is required, mark it as pending review and state the decision needed.

## Examples

- Keep examples short and tied to one review point.
- Label generated examples as generated until approved.
- Preserve anonymization requirements.
- Do not copy confidential content into a broadly accessible Wiki.
- A historical case may demonstrate application but cannot independently establish policy.

## Uncertainty record

Use this block when information is incomplete:

```yaml
status: pending_review
uncertainty:
  reason: 原文未明确分支机构是否适用
  required_decision: 确认适用机构范围
  reviewer_role: 制度Owner
```

Do not fill unknown values with plausible text.
