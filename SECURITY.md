# Security Policy

## Supported Versions

We actively maintain and patch security vulnerabilities in the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | ✅ Active support  |
| < 1.0   | ❌ No longer supported |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability, please report it by emailing **security@darkiceinteractive.com**. This ensures the issue can be assessed and patched before public disclosure.

### What to Include

Please include as much of the following information as possible to help us understand and reproduce the issue:

- Type of vulnerability (e.g., command injection, path traversal, privilege escalation)
- The component affected (e.g., `execute_code`, config file parsing, MCP server communication)
- Full paths of source file(s) related to the vulnerability
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if available)
- Potential impact — what an attacker could achieve by exploiting this

### What to Expect

- **Acknowledgement**: We will acknowledge receipt of your report within **48 hours**
- **Assessment**: We will assess the severity and scope within **5 business days**
- **Fix timeline**:
  - Critical (CVSS 9.0+): patch within **7 days**
  - High (CVSS 7.0–8.9): patch within **14 days**
  - Medium/Low: patch within **30 days**
- **Disclosure**: We will coordinate public disclosure with you after a fix is available. We follow [responsible disclosure](https://en.wikipedia.org/wiki/Responsible_disclosure) practices.
- **Credit**: With your permission, we will credit you in the release notes and security advisory.

## Security Considerations for Users

MCP Conductor runs user-provided TypeScript code inside a Deno sandbox. By design:

- **Deno sandbox**: Code executed via `execute_code` runs in a Deno subprocess with permissions scoped to what MCP servers require. Deno's permission model (`--allow-net`, `--allow-read`, etc.) limits what the sandbox can access.
- **Config file**: `~/.mcp-conductor.json` contains API keys and tokens. Ensure this file has appropriate permissions (`chmod 600 ~/.mcp-conductor.json`).
- **No arbitrary shell execution**: MCP Conductor does not execute arbitrary shell commands from its config or runtime tools. Server processes are started with fixed command arrays, not shell interpolation.
- **API keys in environment**: Server API keys are passed as environment variables to subprocess, not exposed in logs or tool responses.

## Out of Scope

The following are **not** considered security vulnerabilities for this project:

- Vulnerabilities in MCP servers you configure (report those to the respective projects)
- Issues that require physical access to the user's machine
- Social engineering attacks
- Vulnerabilities in Deno itself (report those to the [Deno project](https://github.com/denoland/deno/security))
- Rate limiting or DoS on external APIs (those are provider concerns)

## Bug Bounty

We do not currently offer a paid bug bounty program. We do offer public recognition and our sincere gratitude for responsible disclosure.
