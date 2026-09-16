# Product

## Platform

web

## Users

The primary user is the operator of four domains and five sites deployed across two VPS servers. The operator needs to configure and observe load balancing without editing Worker source code.

## Product Purpose

Provide a Cloudflare-hosted control plane and Worker data plane for highly available, multi-site HTTP load balancing. Success means the operator can create pools, monitors, load balancers, and proximity rules through a graphical interface, understand traffic and TTFB, and safely fail over between the two VPS servers.

## Positioning

The product recreates the essential operating model of Cloudflare Load Balancing while remaining deployable on Cloudflare's developer platform and configurable from a single self-hosted WebUI.

## Operating Context

- Four domains map to five sites.
- Each site may use endpoints on two VPS servers.
- The operator works primarily from a desktop administration dashboard.
- Configuration changes must be testable, versioned, publishable, and reversible.

## Capabilities and Constraints

- Dashboard for load-balancing analytics, request volume, logs, health, latency, and TTFB.
- Graphical management of load balancers, pools, endpoints, health monitors, failover, weights, session affinity, and proximity steering.
- Active health checks plus request-time passive failover.
- Geographic proximity steering based on configured endpoint coordinates and Cloudflare request geolocation.
- GET and HEAD requests may retry once; non-idempotent requests do not retry automatically.
- Target deployment is Cloudflare Workers with D1 and KV.
- A one-command installer should provision and deploy the Cloudflare resources when credentials are available.
- Initial design and code live under `Load balancing/`.
- Cloudflare Access is the recommended authentication method, with a generated management-token fallback.

## Implemented Architecture

- One deployed Worker with isolated traffic, control, and scheduled-health modules.
- D1-backed drafts, relationships, health history, events, and versioned snapshots.
- KV-backed published configuration with a short isolate-memory cache on the traffic path.
- Cloudflare Access JWT verification with a generated management-token fallback.
- Dependency-safe deletion for load balancers, pools, monitors, and origins.
- One-command Wrangler installer for D1, KV, migrations, secrets, assets, Cron, and an optional WebUI Custom Domain; business DNS and exact Worker Routes are managed later from the WebUI.
- AES-GCM encrypted Cloudflare API credentials entered from the WebUI, with no plaintext readback endpoint.
- Sampled request analytics to keep D1 write usage practical on the free plan.

## Brand Commitments

The administration experience uses BoardUI's public visual language as its design reference: a floating rounded sidebar, quiet neutral surfaces, compact stat cards, direct data tables, one strong blue accent, and restrained status colors. It remains operational, information-dense, and familiar without copying paid template source, reproducing Cloudflare trademarks, or implying that it is an official Cloudflare product.

## Evidence on Hand

- A supplied screenshot of Cloudflare's proximity-steering coordinate interface.
- Confirmed initial topology: four domains, five sites, two VPS servers.
- Production traffic samples and real endpoint names are not yet available; prototypes must clearly use synthetic demonstration data.

## Product Principles

- Keep the request path independent from the management UI.
- Prefer safe defaults and explicit publish/rollback over instant destructive changes.
- Show health and routing consequences before exposing advanced configuration.
- Make failures diagnosable from one screen without requiring raw logs.
- Keep frequent operational interactions fast, restrained, and accessible.
