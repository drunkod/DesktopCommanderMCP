# Local Mac family chat + ChatGPT MCP + Jazz architecture

Status: architecture proposal based on the current DesktopCommanderMCP and local control-plane workspaces; docs-only.

## Product goal

Run all application-owned services on one home MacBook and expose exactly one durable HTTPS origin through the existing tunnel layer.

Example public origin: `https://stable-tunnel-host.example`

- ChatGPT MCP: `https://stable-tunnel-host.example/mcp`
- Family chat: `https://stable-tunnel-host.example/chat`
- Better Auth: `https://stable-tunnel-host.example/api/auth/...`
- OAuth/MCP metadata: same origin under `/.well-known/...`

No VPS, hosted application server, hosted SQL database, or hosted Jazz service is required. The unavoidable external services are the selected tunnel relay and ChatGPT itself.

The MacBook must be awake and online for `/chat` and `/mcp` to work.

## Recommended local shape

Expose only the local Next.js control plane through the tunnel. Keep Jazz, SQLite, device APIs and Desktop Commander on loopback/private local transports.
```text
Internet
  -> static tunnel URL
  -> 127.0.0.1:3000 Next.js control plane
       /chat
       /mcp
       /api/auth/*
       /.well-known/*
       /api/device/*
       /api/chat/*

MacBook internal only
  -> Better Auth SQLite/WAL
  -> Jazz authority + persistent data directory
  -> MCPDevice / RemoteChannel
  -> DesktopCommanderIntegration
  -> Desktop Commander stdio MCP
```

This keeps the tunnel as transport only. It never becomes the user database, authorization authority, queue, or execution engine.

## Existing runtime dependencies retained

| Existing dependency/component | Current role | Proposed role |
| --- | --- | --- |
| Next.js 15 + React 19 | local control-plane UI/API | same-origin `/chat`, `/mcp`, auth, device and chat APIs |
| Better Auth 1.7.1 | OAuth/users/sessions | family users, browser sessions and ChatGPT OAuth || `@better-auth/passkey` | passkey enrollment/login | family sign-in to `/chat` and operator sign-in |
| `@better-auth/mcp` | MCP OAuth protection | protect `/mcp` |
| `@better-auth/oauth-provider` | OAuth authority/device grant | ChatGPT grants + laptop/device authorization |
| `@better-auth/cimd` | MCP client metadata | retain current MCP metadata profile |
| Better Auth bearer/JWT + `jose` | JWT/JWKS | user, worker and device identity verification |
| `node:sqlite` + WAL | local auth persistence | keep on the MacBook; no external DB required |
| `jazz-tools@2.0.0-alpha.53` | remote calls/device sync | local durable queue/event bus/realtime state |
| `@remote-dc/protocol` | Jazz schema | extend with family/chat/worker records |
| `@modelcontextprotocol/server@2` | protected HTTP MCP | keep the current local `/api/mcp` handler, expose as `/mcp` |
| Desktop Commander MCP SDK | stdio MCP | keep local tool execution path |
| `MCPDevice` | durable remote executor | keep as Mac worker |
| `RemoteChannel` | Jazz subscription/heartbeat | subscribe to local Jazz and receive `remoteCalls` |
| `DesktopCommanderIntegration` | MCP client to stdio child | keep current bridge to Desktop Commander |
| `DeviceTokenManager` | device OAuth lifecycle | keep |
| `NativeCredentialStore` | device secret persistence | keep secrets in macOS credential storage |
| Tailscale/zrok providers | static public edge | expose only `127.0.0.1:3000` |
| macOS LaunchAgent support | process supervision | supervise control plane, Jazz, tunnel and worker |

The diagram intentionally omits unrelated document/PDF/editor dependencies because they remain inside Desktop Commander tools and do not change the service topology.

## Existing persistent state

Better Auth already uses a local `node:sqlite` database with foreign keys, WAL and a busy timeout. For this architecture that is an advantage, not a serverless blocker: the MacBook is the persistent host.

The current Jazz authority script already uses `startLocalJazzServer`, port 1625 by default and a persistent `JAZZ_DATA_DIR`. Official Jazz documentation also supports a self-hosted persistent server and programmatic `startLocalJazzServer`.
Keep both persistence engines loopback-only. Only the Next.js public origin should be reachable through the tunnel.

## Jazz schema: keep two different queues

The current shared schema already has:

- `devices` — device identity, capabilities, heartbeat, revocation and reconnect state;
- `remoteCalls` — durable Desktop Commander tool jobs with claim/completion/idempotency fields;
- `auditEvents` — durable application audit.

For the family chat product, add separate chat-oriented state rather than overloading `remoteCalls`:

- `families` or `households`;
- `familyMembers` with role and membership state;
- `deviceGrants` linking family members/roles to the shared Mac and allowed capabilities;
- `conversations`;
- `messages`;
- `chatJobs` — queued user turns waiting for an AI worker;
- `agentSessions` — worker lease with `startedAt`, `expiresAt`, state and worker identity;
- optional `chatEvents` for partial progress/tool events.

Use `chatJobs` for **AI reasoning work** and keep `remoteCalls` for **Desktop Commander tool execution**. This separation makes retries, permissions and audit behavior much easier to reason about.

## Family authorization change required

The current `dispatchRemoteCall()` is owner-only: it requires `device.ownerId === subject`. Fifteen family users therefore cannot share the owner's Mac with the current rule.Change authorization conceptually from:

```text
subject owns device
```

to:

```text
subject owns device OR subject has active deviceGrant for requested capability/tool
```

Keep Jazz row permissions aligned with the same family model so one member cannot read another member's private conversations merely because everyone shares one executor.

Recommended roles are `owner`, `adult`, `child` and `guest`, with an independent capability set. Do not equate family role with unrestricted Desktop Commander access.

## One identity across `/chat` and `/mcp`

The same Better Auth user should represent a family member in both surfaces:

- `/chat`: browser session cookie after passkey sign-in;
- `/mcp`: OAuth subject after ChatGPT authorization;
- Jazz rows: store the Better Auth user ID as the application subject.

A user's ChatGPT account does not automatically identify them to the Mac. ChatGPT reaches `/mcp`, then your Better Auth OAuth flow authenticates/authorizes the family identity.

Using one origin is especially useful because passkey RP ID, OAuth issuer, MCP resource and browser cookies can all remain tied to one stable hostname.

## Your proposed ChatGPT queue-worker model

Your idea is feasible as an experiment, but it needs one important change: do not make one MCP HTTP request poll for 25 minutes.Instead, model a 25-minute worker lease in Jazz and use many short MCP tool turns:

```text
open_family_worker_session(25m)
  -> next_chat_job(wait <= short poll budget)
  -> ChatGPT reasons
  -> optional call_device_tool(...)
  -> publish_chat_reply(...)
  -> next_chat_job(...)
  -> repeat while ChatGPT keeps the run alive and lease is valid
```

Suggested new MCP tools for this experimental mode:

- `open_family_worker_session`;
- `next_chat_job`;
- `publish_chat_reply`;
- `fail_chat_job`;
- `renew_family_worker_session`;
- `get_conversation_context` if the claim result does not already include bounded context.

The current 25-minute Desktop Commander work budget is **local lifecycle metadata**. Existing acceptance notes still mark the full ChatGPT Web 25-minute soak/routing proof as pending. Therefore do not treat 25 minutes of autonomous ChatGPT polling as a guaranteed platform primitive.

ChatGPT must perform multiple model/tool turns to reason between jobs. An MCP tool itself cannot call back into the surrounding ChatGPT model for new reasoning while it is blocked inside one long tool invocation.

This makes the ChatGPT queue-worker architecture useful for R&D, but not yet the only production chat engine.
## Architectural options

| Option | AI/reasoning engine | Uses Jazz queue | New recurring infrastructure cost | Reliability | Recommendation |
| --- | --- | --- | ---: | --- | --- |
| **A. ChatGPT MCP queue worker** | owner's/worker ChatGPT conversation | yes: `chatJobs` + `remoteCalls` | tunnel only | experimental | Build as a proof of your exact idea |
| **B. Local chat orchestrator + OpenAI/other API** | official model API called outbound from Mac | yes | usage-based model cost | high | Best ChatGPT-like production behavior |
| **C. Local chat orchestrator + local model** | Ollama/llama.cpp-class local runtime | yes | $0 model API | depends on Mac/model | Best strict local/no-model-fee architecture |
| **D. Hybrid worker** | ChatGPT worker when active, API/local fallback otherwise | yes | optional usage cost | highest after implementation | Best eventual product if experiment succeeds |
| **E. Direct ChatGPT per family member** | each member's own ChatGPT | `remoteCalls` only | tunnel only | high for supported MCP use | Simplest, but does not provide the shared `/chat` experience |

### Option A — exact queue-worker experiment

A privileged ChatGPT MCP session acts as the AI worker. `/chat` writes a user message and `chatJobs(pending)` to Jazz. The ChatGPT run repeatedly claims jobs, reasons, optionally invokes the existing `call_device_tool` path, then publishes an assistant response to Jazz.

Advantages: preserves your central ChatGPT-worker idea and may avoid separate model API billing.

Risks: ChatGPT is not documented as a continuously running background queue consumer; the model can finish/stop instead of polling again. One shared ChatGPT conversation can also accumulate context from different family conversations, so conversation isolation must be explicit and tested.

For safety, `next_chat_job` should return only the claimed conversation's bounded context, never another user's rows, and every reply must be bound to the claimed `jobId`/`conversationId`.

### Option B — recommended robust AI chat

Keep the exact same local UI/Jazz/Desktop Commander architecture, but add a local orchestrator process/Next.js route that calls an official LLM API outbound. Jazz remains the queue and durable state. This gives deterministic per-conversation isolation and does not depend on ChatGPT Web remaining active.
### Option C — strict local AI

Run a local model runtime such as Ollama on the MacBook. `/chat` remains available through the same tunnel and no model API is required. The trade-off is model quality, memory/CPU/GPU pressure and slower multi-user concurrency.

This option adds a new local runtime, but no new hosted infrastructure.

### Option D — hybrid

Treat `chatJobs` as engine-neutral. A job can be claimed by a ChatGPT MCP worker, local-model worker or API worker according to policy. If the experimental ChatGPT worker disappears, another permitted engine can finish new jobs without changing `/chat`, the public URL or Desktop Commander execution.

Never allow two engines to execute the same job. Use an authoritative Jazz claim/lease and idempotency key just as the existing `remoteCalls` path does.

## Chat UI project choice

Use the official Jazz **`auth-betterauth-chat`** example as the primary code base/reference for `/chat` because it already combines the exact two core dependencies in this architecture: **Jazz + Better Auth inside one Next.js application**.

Upstream source: https://github.com/garden-co/jazz/tree/main/examples/auth-betterauth-chat

Local sparse clone created for this project:
`/Users/test/Documents/RemoteMCP-Jazz/references/jazz-auth-betterauth-chat/examples/auth-betterauth-chat`

Reference clone HEAD at the time it was added to this plan: `6d35266`. Keep the upstream URL as the canonical source and treat the local clone as research/reference material, not vendored production code.

The example demonstrates a single Next.js app serving the UI and Better Auth routes, Better Auth persistence through the Jazz adapter, ES256/JWKS integration, Jazz session handling, roles, permissions, and realtime chat rows. Its `ChatPanel.tsx` already provides the useful minimum UI pattern: Jazz `useAll()` subscription, message insert/delete, timestamps, per-row authorization, and a composer.

Important integration note: the example is part of the Jazz monorepo and its `package.json` uses workspace/catalog dependencies such as `jazz-tools`, `jazz-napi`, and the repository Next.js catalog. Therefore use it as a code base to port into the existing control-plane workspace; do not assume the sparse-cloned example can be installed standalone unchanged.

| GitHub project | Fit | Why |
| --- | --- | --- |
| **garden-co/jazz `auth-betterauth-chat`** | **Best architecture match** | Official Jazz example; Next.js + Better Auth + Jazz + roles/permissions + realtime chat; maps directly onto the current control plane |
| **assistant-ui/assistant-ui** | Best optional visual upgrade | Useful React chat primitives if a more polished assistant-style UX is wanted after the Jazz example is integrated |
| **vercel/chatbot** | Good UI/UX reference, heavier integration | polished Next.js + AI SDK app, but its default persistence/auth stack overlaps with Better Auth/Jazz |
| **mckaywrigley/chatbot-ui** | Poorer fit | current local setup brings Supabase/Docker, duplicating Jazz + Better Auth |
| **Open WebUI / LobeChat** | Too heavy | complete chat platforms with overlapping runtime/storage/auth concepts |

Recommended implementation path: **port the Jazz `auth-betterauth-chat` UI/schema/session patterns into the existing `implementation/apps/control-plane` app**, mount the resulting UI at `/chat`, then adapt its message model to the proposed `conversations`, `messages`, `chatJobs`, `chatEvents`, and family/device-grant records. Add assistant-ui later only if its visual components materially improve the experience.
## Same-origin routing on the Mac

The control-plane workspace already has the canonical `app/mcp/route.ts`, which re-exports the protected `/api/mcp` handler. That makes the desired public layout natural:

```text
https://stable-host/mcp          -> existing canonical MCP route
https://stable-host/chat         -> new family chat page
https://stable-host/api/chat/*   -> new chat/queue endpoints
https://stable-host/api/auth/*   -> existing Better Auth
https://stable-host/.well-known/*-> existing OAuth/MCP/Jazz metadata
https://stable-host/api/device/* -> existing loopback-capable device control APIs
```

The tunnel should map the stable hostname to `http://127.0.0.1:3000` and nothing else.

Do not publish Jazz port 1625 directly. The control plane and `MCPDevice` can reach Jazz locally, while remote browsers and ChatGPT interact only through the authenticated Next.js origin.

If by “the same address + `/chat`” you mean the same hostname used for the MCP registration, this is exactly the design: `/mcp` and `/chat` are sibling paths on one origin. Do not construct `/mcp/chat`.

## Local process topology

Recommended supervised processes on macOS:

1. local Jazz authority (`127.0.0.1:1625` + persistent data directory);
2. local Next.js control plane (`127.0.0.1:3000`);
3. `MCPDevice` + `RemoteChannel`;
4. Desktop Commander stdio child, supervised by the existing integration;
5. one tunnel agent (Tailscale or zrok);
6. optional local AI worker if using Option B/C/D.
## Recommended implementation order

1. Freeze the tunnel identity and public origin.
2. Keep the canonical `/mcp` route and add `/chat` to the existing Next.js app.
3. Add assistant-ui components only; do not import another auth/database stack.
4. Extend `@remote-dc/protocol` with family membership, device grants, conversations/messages, `chatJobs` and `agentSessions`.
5. Change owner-only device authorization to owner-or-explicit-grant authorization.
6. Add `/api/chat/*` endpoints plus SSE/bounded polling backed by local Jazz subscriptions.
7. Implement the experimental ChatGPT-worker MCP tools using atomic chat-job claims.
8. Keep the existing `remoteCalls` + `RemoteChannel` + server-mediated claim/completion path for Desktop Commander tools.
9. Prove the worker using harmless/read-only tools and an accelerated lease before a real 25-minute test.
10. Add a local/API fallback worker if `/chat` must remain useful when ChatGPT stops polling.
11. Put all local processes under launchd supervision and add backups for auth SQLite + `JAZZ_DATA_DIR`.
12. Only then enable higher-risk Desktop Commander capabilities for family roles.

## Recommendation

For the exact idea, start with **Option A as a controlled experiment**, because it exercises the new concept without discarding Jazz or the current remote-device work.

For a dependable family product, make the Jazz chat queue **engine-neutral** from day one. Then the ChatGPT MCP worker can be one claimant rather than the only possible source of replies. This allows Option D later without rewriting `/chat`, permissions, conversations, or Desktop Commander execution.

The strongest local-only product shape is therefore:

**one static tunnel origin + local Next.js/Better Auth/SQLite + local Jazz + engine-neutral chat queue + existing MCPDevice/Desktop Commander executor.**

## Research references

- Jazz self-hosted server setup: https://jazz.tools/docs/getting-started/server-setup
- Jazz local-first model: https://jazz.tools/docs/concepts/local-first-data-model
- assistant-ui GitHub: https://github.com/assistant-ui/assistant-ui
- Vercel Chatbot GitHub: https://github.com/vercel/chatbot
- Chatbot UI GitHub: https://github.com/mckaywrigley/chatbot-ui

No source/config/test files are changed by this architecture artifact.
