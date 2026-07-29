# Security policy

## Supported versions

Honey Bee is pre-release software. Security fixes are applied to the latest
commit on `main`; older commits and unpublished builds are not supported.

## Reporting a vulnerability

Do not open a public issue containing a vulnerability, credential, exploit, or
private project data. In the repository's **Security** tab, use **Report a vulnerability**
for this repository. Include the affected version, reproduction steps, impact,
and the smallest safe proof of concept.

Do not include real API keys, access tokens, Unity project credentials, agent
transcripts, PTY logs, or proprietary project files. Replace them with
redacted fixtures.

## Repository safeguards

- Runtime state, PTY logs, local databases, source DOCX files, environment
  files, registry credentials, and common private-key formats are ignored.
- `node scripts/security/check-no-secrets.mjs` blocks known secret patterns,
  forbidden paths, binary reference documents, and unexpectedly large files.
- The repository's pre-commit hook runs the staged-content secret scan and the
  production dependency license allowlist.
- GitHub Actions repeats both checks. GitHub secret scanning and push
  protection are enabled on the public repository.

These controls reduce risk but cannot prove that arbitrary text is safe.
Review staged changes before every commit and rotate any credential that may
have been exposed.
