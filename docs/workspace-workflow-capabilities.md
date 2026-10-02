# Workspace workflow capabilities

Iolaus uses native, registered `workflow.*` permissions for user-facing
workflows. They replace generic private model CRUD on public REST, CLI, and MCP
surfaces. A permission grants access to start the workflow; every workflow must
also verify the current `{ tenantId, userId, profileId }` against every private
record it reads or changes.

| Permission | Allowed workflow | Required record checks |
| --- | --- | --- |
| `workflow.assessment.execute` | Assess an opportunity for the active profile | Current opportunity plus owned profile, evidence, assessment, score, and agent run |
| `workflow.application.prepare` | Prepare an owned application | Owned profile, application, source opportunity, and chosen resume asset |
| `workflow.application.inspect` | Inspect an owned application or scoped opportunity | Owned application/profile and subject-visible opportunity projection |
| `workflow.application.review` | Open human review for an owned application | Owned application and current review state |
| `workflow.profile.manage` | Update the active profile and workspace preferences | Exact active profile and owner tuple |
| `workflow.audit.record` | Record a workflow audit event | Exact action subject and allowed audit target |
| `workflow.task.sync` | Synchronize owned application tasks | Owned application, task, and active profile |
| `workflow.application-auto-submit.execute` | Submit a final approved application | Owned application, approved material revision, resume PDF, task, and CAS state |

`owner` and `admin` retain native wildcard role permissions. Hosted user
workspaces are provisioned with the native `member` role. Its grant matrix is
limited to global opportunity/company reads plus these workflow permissions;
it does not inherit SMRT's default wildcard model reads or creates.
Private installs retain their configured operator role. Role seeding is
additive and runs during migrations and access provisioning, so existing role
grants, governance limits, pricing, and historical records are preserved.
