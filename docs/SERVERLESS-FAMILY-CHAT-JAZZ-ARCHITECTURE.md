# Serverless family chat + ChatGPT MCP + Jazz architecture

Status: architecture proposal based on current code and dependencies; docs-only

## Product goal

Use one permanent public origin, for example `https://family.example.com`.

- ChatGPT custom MCP endpoint: `https://family.example.com/mcp`
- Family web chat: `https://family.example.com/chat`
- Better Auth/OAuth: `https://family.example.com/api/auth/...`
- MCP/OAuth metadata: same origin under `/.well-known/...`

Each family member authenticates separately. The home laptop is the only machine that executes Desktop Commander tools.
The public web/control plane is serverless. The laptop connects outbound and receives durable work through Jazz.

Master diagram: `docs/architecture/SERVERLESS-FAMILY-CHAT-JAZZ.mmd`.

## Most important design change

Do **not** implement the proposed 25-minute window as one HTTP/MCP request that polls for 25 minutes.
Serverless request lifetimes, retries, disconnects and cost make that boundary fragile.

Model the 25-minute window as a durable `agentSession` lease in Jazz instead.
The laptop worker can remain connected continuously. The lease says which user/conversation may submit work during the 25-minute session.
When the lease expires, new work is rejected or requires a new session; existing claimed work follows explicit completion/indeterminate rules.

## Existing dependencies we can reuse

| Existing dependency/component | Current role | Proposed role |
| --- | --- | --- |
| Next.js 15 + React 19 | control-plane UI/API | serverless `/chat`, `/mcp`, auth and task APIs |
| Better Auth 1.7.1 | users, sessions, OAuth | family identity, ChatGPT OAuth, browser sessions |
| `@better-auth/passkey` | passkey login | family sign-in to `/chat` and account enrollment |
| `@better-auth/mcp` | protected MCP OAuth | protect `/mcp` |
| `@better-auth/oauth-provider` | OAuth authority/device grant | ChatGPT grants + laptop device authorization |
| `@better-auth/cimd` | MCP client metadata | retain MCP 2026 client registration profile |
| `jose` | JWT/JWKS | signed identity/capability verification |
| `jazz-tools` alpha.53 | devices/calls/audit sync | durable queue/event bus and live subscriptions |
| `@remote-dc/protocol` | Jazz schema | extend with chat/session records |
| `@modelcontextprotocol/server` | HTTP MCP endpoint | keep canonical `/mcp` serverless handler |
| MCP SDK in DesktopCommanderMCP | stdio bridge | execute existing local tools unchanged initially |
| `MCPDevice` + `RemoteChannel` | durable remote worker | long-lived home-laptop worker |
| NativeCredentialStore | device secrets | keep laptop OAuth credentials in OS vault |
## Jazz as the durable queue

The current shared schema already contains the essential execution queue:

- `devices` — owner/device identity, capabilities, status and heartbeat;
- `remoteCalls` — request fingerprint, tool, args, status, claim, result/error and expiry;
- `auditEvents` — durable application audit trail.

Do not invent a second execution queue unless required. Reuse `remoteCalls` for Desktop Commander jobs.
Extend the protocol schema for the web-chat product with records such as:

- `conversations` — family user, title, selected device, timestamps;
- `messages` — conversation, role, content, state and optional `remoteCallId`;
- `agentSessions` — user, conversation, device, start time, `expiresAt`, state;
- optionally `messageEvents` for partial progress if the UI needs streamed task updates.

A chat turn that needs local execution creates a `remoteCalls` row and links it from the corresponding message.
The existing device subscription receives pending calls, claims them through the control plane, executes locally, and durably completes them.
The web UI observes the same durable state and renders progress/results.

## Same-origin routing

The canonical public identity should be the **origin you own**, not a laptop tunnel hostname.
Recommended public routing:

```text
family.example.com/mcp        -> serverless Next.js MCP route
family.example.com/chat       -> serverless Next.js React UI
family.example.com/api/auth/* -> Better Auth
family.example.com/api/*      -> serverless control-plane APIs
Jazz sync                     -> managed/public Jazz sync endpoint
home laptop                   -> outbound OAuth + Jazz connections only
```

With Jazz in the request path, a public tunnel into the home laptop is no longer required for normal execution.
The worker subscribes outbound to Jazz and uses server-mediated claim/completion APIs.
A tunnel can remain as an optional maintenance/direct-debug path, but it should not define the product's permanent public identity.

If the requirement literally insists that a provider-generated tunnel URL is also the `/chat` origin, then the public web application depends on that tunnel/laptop and is no longer strictly serverless.
Use an owned domain if strict serverless + one permanent origin are both hard requirements.

## Serverless blocker in the current implementation

The current Better Auth database is `node:sqlite` with a local filesystem path and WAL mode.
That is appropriate for the existing stateful Next.js/container deployment but not for ephemeral multi-instance serverless compute.

Therefore a **strict serverless deployment cannot be achieved with zero persistence changes**.
For serverless, keep Better Auth as the auth layer but replace the local file database boundary with a durable network/database service supported by Better Auth/Kysely.
Examples include Cloudflare D1, libSQL/sqld or PostgreSQL-compatible serverless storage; the exact driver/adapter is a deployment choice and is **not currently wired in this codebase**.

Jazz has a similar deployment distinction. The current `ops/` template self-hosts a long-lived Jazz NAPI service with a persistent volume.
For a fully serverless public layer, prefer a managed Jazz sync service or a separately managed durable Jazz service; do not start a Jazz database inside a short-lived function.
The current pinned `jazz-tools@2.0.0-alpha.53` also has documented deployment/auth limitations in this repository, so hosted compatibility must be validated before production.

## Chat engine gap

The current codebase contains the web/auth/MCP/queue/device pieces, but it does **not** contain an OpenAI API client or another LLM backend for a custom `/chat` assistant.

That gives three product choices:

| Chat mode | New LLM dependency? | What `/chat` does |
| --- | --- | --- |
| Queue-first family console | No | user messages become tasks; local tool results become assistant messages |
| Full AI chat | Yes | serverless LLM orchestrator interprets messages, creates tool calls, consumes results and continues the response |
| ChatGPT-as-background-worker experiment | No new LLM API | ChatGPT MCP call starts/refreshes a session, but autonomous 25-minute polling by ChatGPT is not a reliable architectural primitive |

For a real standalone chat experience, use the second model: add a supported LLM API/service behind `/api/chat`.
Do not attempt to reuse a personal browser ChatGPT login/session as the backend of the family web application.
## Family-sharing gap in the current schema

The present authorization model is owner-only. `dispatchRemoteCall()` rejects a device unless `device.ownerId === subject`, and Jazz permissions also scope devices/calls to `session.user_id`.

That means 15 family accounts cannot currently share one owner's laptop merely by signing in.
Add an explicit authorization model, for example:

- `families` / `households`;
- `familyMembers` with role (`owner`, `adult`, `child`, `guest`);
- `deviceGrants` mapping a family member or role to the shared laptop;
- optional per-tool/per-capability grants.

Then change the call-router decision from **is device owner?** to **is owner OR has an active grant for this device/tool?**.
Keep Jazz row permissions aligned with the same rule so a family member cannot read another member's conversations or unrelated device calls.

## 25-minute session semantics

A proposed `agentSessions` row should contain at least `userId`, `conversationId`, `deviceId`, `startedAt`, `expiresAt`, `status` and a random session identifier.

Opening ChatGPT MCP or `/chat` can create/refresh a session lease. New queue writes require an active lease.
The laptop worker does not stop after 25 minutes; it remains a supervised device service and simply stops accepting tasks from expired sessions.

This preserves the user's mental model of a 25-minute work window without tying it to one long HTTP connection.
## Flow A — family member uses ChatGPT

1. Family member configures `https://family.example.com/mcp` in ChatGPT.
2. OAuth redirects to the same origin and Better Auth authenticates the family member, preferably with the existing passkey flow.
3. `/mcp` validates issuer, audience and `mcp:tools` scope with the existing protected handler.
4. The MCP tool handler checks the family/device grant.
5. A short operation creates a durable `remoteCalls` row in Jazz.
6. The home `RemoteChannel` subscription sees the pending row.
7. The device claims it through the server-mediated control-plane API.
8. `DesktopCommanderIntegration` executes the existing stdio MCP tool locally.
9. The device persists completion/failure through the control plane.
10. The serverless MCP request returns the result when it fits the platform request budget.

For operations that can exceed the serverless request budget, expose asynchronous MCP tools such as `submit_task` + `get_task_status` instead of holding `/mcp` open indefinitely.

## Flow B — family member uses `/chat`

1. User opens `https://family.example.com/chat` and authenticates with Better Auth.
2. The browser loads only conversations belonging to that user/family scope.
3. A message is persisted in Jazz through a server-authorized path.
4. If it needs a Desktop Commander action, the task dispatcher creates a linked `remoteCalls` row.
5. The same home worker executes it; there is no second Desktop Commander protocol.
6. Completion updates the linked chat message/event.
7. The browser receives the update through Jazz realtime sync or bounded API polling.
## Architectural options

| Option | Public layer | Durable state | Laptop path | New work | Serverless quality | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| **A. Serverless control plane + managed Jazz** | Next.js `/mcp` + `/chat` + Better Auth on one owned domain | external Better Auth SQL + hosted/managed Jazz | existing outbound `MCPDevice`/`RemoteChannel` | family grants, chat schema, serverless DB adapter | **Best** | **Recommended** |
| **B. Serverless control plane + self-hosted Jazz core** | same as A | external auth DB + long-lived Jazz service | existing worker | operate Jazz service yourself | Hybrid | Good if Jazz hosting cost/control matters |
| **C. Serverless frontend + tunnel to stateful local control plane** | `/chat` serverless; MCP/auth routed through tunnel | current local SQLite + local Jazz | local | complex path routing and split-origin concerns | Partial | Not preferred |
| **D. Everything on home laptop behind named tunnel** | `/mcp` + `/chat` both local | current SQLite + current Jazz volumes | local | least code change | **Not serverless** | Cheapest lab option only |

### Option A — recommended

Use the existing Next.js/React control plane as the only public application.
Deploy it on a serverless Node runtime under an owned domain. Keep Better Auth, MCP protection, passkeys, JWT/JWKS and the current Jazz call model.
Move Better Auth persistence from local `node:sqlite` to a durable network-backed SQL target.
Use Jazz's hosted/managed sync service if compatible with the pinned/runtime version, or upgrade Jazz deliberately after a compatibility gate.

The home laptop runs only the existing long-lived device service plus Desktop Commander. It needs outbound Internet access but no inbound public port.

This architecture gives the cleanest meaning to “same address”: `/mcp` and `/chat` are simply routes of one serverless origin.
### Option B — serverless web, self-hosted Jazz

Keep the Next.js/auth/MCP/chat layer serverless, but run Jazz as a small durable service with persistent storage.
This is close to the current Compose topology and preserves direct control over Jazz data, but it is not fully serverless because the Jazz core is a continuously running service.

### Option C — split serverless UI and tunnel origin

Serve `/chat` from serverless compute and route some paths through a tunnel to a stateful local control plane.
This can be made to work behind an owned reverse-proxy domain, but it increases routing, cookie, OAuth-resource and failure complexity.
It also makes the home laptop part of public web availability for tunneled paths.

### Option D — current-style home stack

Run Next.js, Better Auth SQLite and Jazz on the home laptop and expose the whole origin through Cloudflare/Tailscale/zrok.
This reuses the most current deployment code and can be very cheap, but it directly violates the strict serverless requirement.

## What the tunnel should mean in the new design

In the previous architecture, the tunnel was required because ChatGPT needed a route into the home laptop.
With Jazz as the durable remote transport, **the laptop already has an outbound control channel**, so a public inbound tunnel becomes redundant for normal tool execution.

Recommended separation:

- permanent product origin: `family.example.com`;
- `/mcp` and `/chat`: serverless control plane;
- Jazz: managed/durable sync plane;
- home laptop: outbound-only worker;
- optional tunnel: diagnostics/emergency administration only, on a different private/operator route.
## Serverless hosting choices

| Target | Fit with current code | Cost profile for ~15 family users | Required adaptation |
| --- | --- | --- | --- |
| **Vercel Node Functions** | **Highest** for current Next.js 15/Node code | Hobby can start at $0 for personal/non-commercial use; external DB/model usage separate | replace local SQLite with network SQL; validate Jazz connection lifecycle |
| **Cloudflare Workers + D1** | Medium | very low/free-tier-friendly at family scale | Next-on-Workers packaging, D1 Better Auth dialect, remove Node SQLite/NAPI assumptions, Jazz edge-WASM/version validation |
| **Stateful container + Cloudflare Tunnel** | Highest code reuse | low but continuously hosted/local | almost no persistence refactor, but not serverless |

For the smallest engineering change while preserving serverless semantics, start with a **Node-compatible serverless platform**, not an edge-only runtime.
For the smallest possible infrastructure bill, Cloudflare Workers + D1 is attractive, but it requires more runtime adaptation than Vercel-style Node functions.

## Recommended target architecture

**Recommended:** Option A with one owned domain, serverless Next.js control plane, Better Auth on durable external SQL, Jazz as the shared durable/realtime plane, and the existing home `MCPDevice` as the executor.

For the chat product, add `familyMemberships/deviceGrants`, conversations/messages and the 25-minute `agentSessions` lease to the Jazz protocol schema.
Reuse `remoteCalls` rather than inventing another tool queue.

If `/chat` must actually reason like ChatGPT, add an LLM API/orchestrator as a separate serverless component. If minimizing cash cost is more important than AI-chat behavior, start `/chat` as a queue-first task console and add the LLM later.
## Diagrams

- `docs/architecture/SERVERLESS-FAMILY-CHAT-JAZZ.mmd` — component/dependency architecture.
- `docs/architecture/SERVERLESS-FAMILY-CHAT-JAZZ-SEQUENCE.mmd` — end-to-end family user, serverless control plane, Jazz and laptop-worker sequence.

## Suggested implementation order

1. Freeze the owned public origin and canonical paths: `/mcp`, `/chat`, `/api/auth`.
2. Move Better Auth persistence away from local filesystem SQLite to a durable serverless-compatible SQL target.
3. Validate the pinned Jazz client/server version against the selected managed Jazz deployment; upgrade deliberately if required.
4. Extend `@remote-dc/protocol` with family membership/device grants and chat/session records.
5. Change owner-only call authorization to owner-or-grant authorization and update Jazz permissions consistently.
6. Add `/chat` using the existing Next.js + React app and Better Auth browser session.
7. Reuse `remoteCalls` as the Desktop Commander execution queue and connect chat messages to those calls.
8. Implement the 25-minute window as a Jazz lease, not a long request.
9. Add asynchronous MCP task tools for jobs that can exceed a serverless function's safe request lifetime.
10. Decide whether `/chat` is a queue-first task UI or add an LLM API/orchestrator for a true AI chat.
11. Keep the existing `MCPDevice` / `RemoteChannel` / stdio Desktop Commander path as the initial executor.
12. Audit remote tool policy, logging/history, family roles and destructive-operation replay before enabling high-risk tools.

No source changes are part of this research artifact.
