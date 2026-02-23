# OpenErrata Privacy Policy

**Effective date:** February 22, 2026

OpenErrata is a browser extension that investigates web content for factual
accuracy using large language models. This policy describes what data the
extension collects, how it is used, and how it is stored.

## What Data We Collect

### Post content you visit

When you visit a supported page (LessWrong, X/Twitter, or Substack), the
extension extracts the post's text, images, and public metadata (title, author
name/handle, publication date, tags, engagement counts) and sends it to the
OpenErrata API server for investigation. Only content on supported platforms is
extracted — the extension does not read or transmit content from other websites.

### Extension settings (stored locally)

The extension stores the following in your browser's local storage:

- API server URL
- API key (if configured)
- OpenAI API key (if you provide one)
- Auto-investigate preference
- HMAC attestation secret (if configured)

These settings never leave your device except as described below.

### OpenAI API key (if provided)

If you provide an OpenAI API key to trigger on-demand investigations, the key
is sent to the OpenErrata API server over HTTPS in a request header. On the
server, it is encrypted with AES-256-GCM, used within 30 minutes to run the
investigation, and then permanently deleted. Your key is never stored in
plaintext on the server or written to server logs.

### Anonymous viewer identifiers

When the extension sends post content to the API, the server derives an
anonymous identifier from a hash of your IP address range (/24 for IPv4, /48
for IPv6) and User-Agent string. This is used solely for per-day view-credit
rate limiting. Your full IP address and User-Agent are not stored.

## What Data We Do Not Collect

- Email addresses, real names, or account credentials
- Browsing history or activity outside of supported platform pages
- Demographic, location, or device information
- Analytics, telemetry, or crash reports
- Cookies or cross-site tracking identifiers

## How Data Is Used

Post content and metadata are used exclusively to perform LLM-based factual
investigations. Specifically:

1. The server verifies the submitted content against the source platform where
   possible.
2. The content is sent to OpenAI's API for analysis.
3. The resulting investigation (claims, reasoning, and sources) is stored and
   made publicly available through the OpenErrata API so that anyone can
   inspect the fact-checking process.

Anonymous view credits are used to weight investigation priority and prevent
abuse.

## Third-Party Services

- **OpenAI** — Post text and images are sent to OpenAI's API for LLM
  investigation. OpenAI's data usage policies apply to that processing. See
  [OpenAI's privacy policy](https://openai.com/privacy).
- **Platform APIs** — The server may fetch canonical post content from
  LessWrong's public GraphQL API to verify content authenticity.

No data is shared with advertising networks, data brokers, analytics providers,
or any other third parties.

## Data Retention

- **Investigations and claims** are retained indefinitely as part of the public
  fact-checking record.
- **Author names and handles** from investigated posts are retained as part of
  investigation records (this is publicly available platform data).
- **Anonymous view credits** are bucketed by day and can be expired.
- **User OpenAI keys** are encrypted, used once, and deleted within 30 minutes.
- **Local extension settings** persist until you uninstall the extension or
  clear them manually.

## Data Security

- All communication between the extension and the API server uses HTTPS.
- User-provided OpenAI keys are encrypted at rest with AES-256-GCM on the
  server and deleted after use.
- The extension requests only the permissions necessary for its operation.

## Public Investigations

OpenErrata is designed for transparency. All completed investigations —
including claims, reasoning, sources, and content provenance — are publicly
accessible through the OpenErrata API. Post content that has been investigated
is part of this public record.

## Self-Hosted Instances

If you configure the extension to use a self-hosted OpenErrata API server, your
data is sent to that server instead. The data practices of self-hosted instances
are governed by whoever operates them, not by this policy.

## Changes to This Policy

We may update this policy as the product evolves. Material changes will be noted
in the extension's changelog.

## Contact

For questions about this privacy policy, contact: privacy@openerrata.com
