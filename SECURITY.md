# Security and privacy

Use synthetic data when reporting bugs. Do not put credentials, candidate facts,
resumes, application records, browser cookies or database dumps in issues or logs.
Report vulnerabilities using GitHub private vulnerability reporting when enabled;
otherwise contact the repository owner privately before disclosing details.

Keep local services loopback-only. Authentication and approval checks must not be
bypassed for agents. Generated materials require human review; preparing a draft
does not authorize sending it to an employer. Treat external postings as untrusted.

Deployment overlays belong outside the source tree: provide database/storage,
identity-provider and model-provider values through environment configuration.
No production migration is part of this source snapshot.
