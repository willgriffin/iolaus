# Page presentation audit

Issue 216 reviewed every SvelteKit page route and the resource slugs rendered by
the dynamic admin routes. The audit keeps content headings that identify a
document, explain a security decision, or guide an onboarding flow. Generic
admin pages share the workspace header; they do not need route-local chrome.

## Route coverage

| Route | Disposition |
| --- | --- |
| `/` | Keep the selected landing or resume experience intact. |
| `/account-deleted` | Keep the account-deletion confirmation and recovery guidance. |
| `/account/connections` | Updated legacy utility styling to the standard contained card layout. |
| `/admin` | Removed duplicate page chrome; the opportunity-review action now appears in the shared header. |
| `/admin/[resource]` | Uses the shared resource-list presentation. |
| `/admin/[resource]/[id]` | Uses the shared record-view presentation. |
| `/admin/[resource]/[id]/edit` | Uses the shared record-form presentation. |
| `/admin/[resource]/new` | Uses the shared record-form presentation. |
| `/admin/account` | Keeps data-export and destructive-account-management headings and warnings, with a shared-header return to Overview. |
| `/admin/applications/[id]` | Keep the application review workspace title, materials, and decision headings. |
| `/admin/candidate-profile-links` | Removed duplicate visible route chrome; retained an accessible page label and added a shared-header return to Resume. |
| `/admin/career` | Keeps the resume manager, removed its obsolete local breadcrumb-hiding rule, and adds a shared-header return to Overview. |
| `/admin/career/public-profile` | Removed duplicate visible route chrome; retained an accessible page label, publishing state, privacy warnings, setup headings, and a shared-header return to Resume. |
| `/admin/career/public-profile/preview/[id]` | Keep the prepared-document notice and explicit return/PDF actions. |
| `/admin/memory` | Uses the shared category overview. |
| `/admin/onboarding` | Keeps private-data, consent, and setup headings, with a shared-header return to Overview. |
| `/admin/preferences/screening-questions` | Removed duplicate route heading; scoring explanation and edit controls remain, with a shared-header return action. |
| `/admin/research` | Uses the shared category overview. |
| `/admin/resume` | Keep the resume preview and artifact workspace headings. |
| `/admin/resume/skill-discovery` | Removed duplicate route heading; evidence and privacy guidance remain, with a shared-header return action. |
| `/admin/sources/new` | Keep the source safety explanation and Sources return action. |
| `/admin/system` | Uses the shared category overview. |
| `/admin/terminal-login` | Keeps the terminal-approval title and status feedback, with a shared-header return to System. |
| `/auth/magic-link` | Keep one-time-link security feedback. |
| `/companies/[slug]` | Standardized the public collection container and retained the company title and opportunities return action. |
| `/login` | Keep identity-provider and magic-link sign-in context. |
| `/not-invited` | Keep invitation and contact guidance. |
| `/oauth/authorize` | Standardized the consent layout while retaining client identity, registered recipient, scopes, revocation guidance, and denial feedback. |
| `/opportunities` | Keep the search and triage experience. |
| `/opportunities/[id]` | Standardized the detail container and tokenized the external-posting action; retained the opportunity title, source context, and all derived-content headings. |
| `/people/[handle]` | Keep the public resume document heading and download action. |
| `/setup` | Keep initial workspace setup guidance. |
| `/shortlist` | Keep the shortlist experience and its meaningful title. |
| `/skills/[slug]` | Standardized the public collection container and retained the skill title and opportunities return action. |

## Dynamic resource coverage

All of these are rendered through the shared dynamic resource list, record, and
form presentation components. Their titles, descriptions, record actions, and
navigation are covered there rather than duplicated per route.

`opportunities`, `company-research`, `sources`, `source-crawls`,
`source-crawl-items`, `applications`, `application-material-comments`,
`fact-intakes`, `fact-candidates`, `facts`, `tasks`, `decisions`, `agent-runs`,
`evaluation-scores`, `resume-assets`, `resume-variants`, `opportunity-companies`,
`candidate-profiles`, `candidate-profile-links`, `companies`, `roles`,
`skill-categories`, `skills`, `skill-groups`, `skill-group-members`, `experience`,
`experience-companies`, `experience-roles`, `projects`, `duties`, `achievements`,
`education`, `attachments`, `resume-tailoring-configs`, `opportunity-tags`,
`opportunity-places`, `opportunity-roles`, `source-tags`, `decision-tags`,
`company-tags`, `role-tags`, `experience-tags`, `project-tags`, `achievement-tags`,
`duty-tags`, `education-tags`, `company-attachments`, `project-attachments`,
`achievement-attachments`, and `preferences`.

## QA findings

- No local breadcrumb hiding remains in `CareerResume`; navigation ownership is
  now shared between the workspace header and the common `AdminBackLink` component.
- Public detail and collection pages use theme tokens for links, containers, and
  primary actions, including the original-posting action.

- Browser QA caught an outgoing detail-header snippet reading missing record data
  during client navigation. Record actions now guard that transition; a mounted
  browser regression test covers the missing-record update.
- Checked representative generic lists, profile links, public-profile settings,
  category pages, application filters, and responsive resume navigation locally.
