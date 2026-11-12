# Review and Publication Controls

## Separation of duties

The knowledge-building agent may create only `draft` or `pending_review`. It must not grant approval, fabricate reviewer identity, or set a page to `published`.

An external workflow records approval and produces the release manifest. High-risk regulatory, authorization, financial or customer-rights rules should support dual review when enterprise policy requires it.

## Approval record

```yaml
approval:
  approval_record_id: APPROVAL-001
  reviewer_id: USER-001
  reviewer_role: 制度Owner
  reviewed_at: 2026-09-02T10:00:00+08:00
```

The record must be written by the approval system or an authorized human-controlled step, not copied from model output.

## Release manifest

```yaml
release:
  version: 1.0.0
  source_snapshot: SOURCE-SNAPSHOT-001
  pages:
    - knowledge_id: DOC-REQUEST-001
      approval_record_id: APPROVAL-001
```

Production retrieval uses only pages in the active manifest whose status, effective period, organization scope and approval record are valid.

## Security and confidentiality

- Preserve source and page classification.
- Do not move restricted source text into a broader-access Wiki.
- Anonymize cases and retain an audit link to the controlled original.
- Log parser, model and extraction versions, page changes, reviewers and release IDs.
- Do not expose inaccessible attachments, credentials, personal data or hidden comments through examples.

## Revocation

Support deprecation, supersession, emergency withdrawal and rollback. Removing a page from active retrieval does not delete audit history.
