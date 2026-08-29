# Security Policy

Crosslink handles device identity, end-to-end encryption, authorization, and
network reachability. Please report suspected vulnerabilities privately.

## Reporting a vulnerability

Use GitHub's private vulnerability report form:

https://github.com/jacobpowaza/crosslink/security/advisories/new

Include affected versions, impact, reproduction steps or a proof of concept,
and any suggested mitigation. Do not include live private keys, pairing codes,
tokens, or third-party personal data. Please do not open a public issue until a
fix is available or the maintainers agree disclosure is safe.

We aim to acknowledge reports within 3 business days, provide an initial
assessment within 7 business days, and coordinate a release and disclosure
timeline with the reporter. These are targets, not guarantees.

## Supported versions

Until Crosslink reaches 1.0, only the latest published minor release receives
security fixes. After 1.0, this section will list supported release lines.

## Scope

Reports about cryptographic misuse, authentication or authorization bypass,
secret exposure, unsafe defaults, remote code execution, denial of service,
and signaling or relay isolation are especially valuable. Vulnerabilities in a
third-party dependency may also be reported when they are reachable through
Crosslink.

Good-faith research that avoids privacy violations, data destruction, service
disruption, and access beyond what is necessary to demonstrate the issue is
welcome. We will not pursue legal action for research consistent with this policy.
