# Security policy

VisionCLI sees your screen and can click and type for you, so security reports matter to us.

## Reporting a vulnerability

Please **don't open a public issue**. Instead, either:

- use GitHub's private reporting: [Report a vulnerability](https://github.com/thethirdsourcers/visioncli/security/advisories/new), or
- email **visioncli@thethirdsourcers.com** with "Security" in the subject.

Include what you found, how to reproduce it, and which versions and platforms are affected. We'll acknowledge it within 3 working days, keep you updated, and credit you in the release notes if you'd like.

## Supported versions

Fixes go into the latest release; please check you're on it (VisionCLI updates itself, or see the [releases](https://github.com/thethirdsourcers/visioncli/releases)).

## Areas we care most about

- Computer control: actions running without the user's approval, or bypassing the "always ask" rules for passwords and system settings.
- The local control server (`127.0.0.1`, token-protected) and the browser connection (Chrome's remote debugging).
- Anything that sends screen content, questions or keys anywhere the [privacy policy](https://visioncli.thethirdsourcers.com/privacy.html) doesn't describe.
- The update and package signing chain (release signatures, the apt/dnf repository key).
