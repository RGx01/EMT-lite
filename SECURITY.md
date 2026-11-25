# Security

EMT-Lite asks for an Octopus API key, so its security is the point of it. The page has no server.
It swaps the key for a short-lived token at once and does not keep the key, and its
Content-Security-Policy lets it connect only to `api.octopus.energy`. See
[docs/design.md](docs/design.md) §2 and §4.

## Reporting a vulnerability

Please report privately, through GitHub's
[private vulnerability reporting](https://github.com/RGx01/EMT-lite/security/advisories/new),
not in a public issue. Include what an attacker could do and the steps to show it. **Do not
include a real API key, even your own:** revoke any key you have exposed, in your Octopus account
under *Personal details → API access*.

You will get a reply within a week. Things worth reporting:

- any way the key, the token or the refresh token can reach a host other than Octopus
- script injection into the page
- a header or CSP weakness on <https://emt-lite.pages.dev/>
- anything stored on the device that should not be, or that "Sign out" does not remove

## Supported versions

Only what is live at <https://emt-lite.pages.dev/> (the `main` branch).
