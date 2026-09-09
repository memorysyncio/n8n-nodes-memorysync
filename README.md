# n8n-nodes-memorysync

[MemorySync](https://memorysync.io) nodes for [n8n](https://n8n.io) — long-term
memory for your workflows **and** a persistent brain for n8n's AI Agent.

Two nodes in one package:

| Node | What it does |
| --- | --- |
| **MemorySync** | Workflow operations: Add Memory, Add Conversation Turn, Search, **Recall Context**, Get Many, Delete. Marked `usableAsTool`, so an AI Agent can call it autonomously. |
| **MemorySync Chat Memory** | An AI Agent **memory sub-node** (`AiMemory` output): the agent's conversation history persists in MemorySync across executions — sessions survive restarts, redeploys, and weeks between chats. |

## Install (self-hosted n8n)

Settings → **Community Nodes** → Install → `n8n-nodes-memorysync`

(n8n Cloud surfaces only verified community nodes; verification submission is in progress.)

## Credentials

Create a **MemorySync API** credential with your API key from
app.memorysync.io → Settings → API Keys. The built-in credential test makes a
real (tiny) query, so a bad key fails at setup time — not mid-workflow.

## The AI Agent memory sub-node

```
Chat Trigger ──▶ AI Agent ◀──memory── MemorySync Chat Memory
                        ◀──tool────── MemorySync (Search / Add)
```

- **Session ID** (e.g. `{{ $json.sessionId }}`) scopes the transcript; the same
  session resumes its history on the next execution.
- **End User ID** isolates everything per user.
- **Context Window Length** counts turn *pairs* handed to the agent each run.
- Turns store verbatim with deterministic idempotency seeds — a retried
  execution can never duplicate a conversation.
- `clear()` is a **deliberate no-op**: an agent can never bulk-delete a
  customer's stored history. Deletion stays an explicit human action.
- A MemorySync outage degrades to "no history this run" — the agent still
  answers; nothing throws.

Requires **n8n 2.16.0 or later** for the Chat Memory sub-node — the first
release that ships `@n8n/ai-node-sdk`, which it is built on (declared as
`n8n.aiNodeSdkVersion` + a peer dependency, so n8n only offers the package to
instances that can run it). On an older n8n the package still loads and the
MemorySync workflow node works; only the sub-node reports "update n8n" when
used. Built and tested against `n8n-workflow` 2.37.4 and `@n8n/ai-node-sdk`
0.27.4.

## Operations cheat-sheet

Resource **Memory** → one of six operations:

| Operation | Use it for |
| --- | --- |
| Add Memory | "Remember this fact about the customer" (server-side extraction applies) |
| Add Conversation Turn | Verbatim transcript capture with duplicate-proof retries |
| Search Memories | Semantic lookup — results fan out as items |
| **Recall Context** | A grouped, prompt-ready context block for a downstream AI step (unique to MemorySync) |
| Get Many | Newest-first listing for a user |
| Delete Memories | Explicit deletion by ID (`m_123`) |

## Semantics worth knowing

- Every operation is scoped by **End User ID** — header-enforced isolation.
- Free-tier quota exhaustion is silent by design: adds answer accepted-without-
  storing, reads answer empty. The node reports `stored: false, accepted: true`
  instead of failing your workflow. Evaluation keys surface strict `429`s.
- Transcript turns store under the `n8n::<session>` scope — separate history,
  same shared user memories as every other MemorySync surface.
- Node code never reads your credential. Every request goes through n8n's
  `httpRequestWithAuthentication`; the credential's own `authenticate` hook adds
  the base URL and the API key header.

## Development

Built with [`@n8n/node-cli`](https://www.npmjs.com/package/@n8n/node-cli) in
strict (n8n Cloud-eligible) mode.

```bash
npm install
npm run lint    # n8n-node lint — n8n's community-node rules, default config
npm test        # n8n-node build + 31 contract/behaviour tests (node --test)
npm run dev     # n8n-node dev — local n8n with this package linked, hot reload
```

## Version history

| Version | Changes |
| --- | --- |
| 1.0.9 | `@n8n/ai-node-sdk` is loaded when the Chat Memory sub-node runs, not when the package loads — on n8n releases older than 2.16.0 (no SDK) the MemorySync workflow node and the credential keep working and the sub-node reports a clear "update n8n" error, instead of the whole package failing to load. |
| 1.0.8 | n8n verification review, round 2: `@n8n/ai-node-sdk` declared as a peer dependency with `n8n.aiNodeSdkVersion`; build/lint/dev via `@n8n/node-cli` (strict mode, default ESLint config); node code no longer reads credentials — requests use `httpRequestWithAuthentication` and the credential's `authenticate` hook supplies base URL + key; operations grouped under a **Memory** resource. Existing workflows keep working unchanged. |
| 1.0.7 | Codex files use only documented keys and the supported `Data & Storage` category (review round 1). |
| 1.0.6 | User-Agent version derived from `package.json` instead of a typed string. |
| 1.0.5 | Codex placement updates. |
| 1.0.4 | Distinct dark-mode icon variants; unconditional error wrapping. |
| 1.0.3 | Verification-scanner findings addressed. |
| 1.0.0 – 1.0.2 | Initial releases: MemorySync node (six operations, `usableAsTool`) and MemorySync Chat Memory sub-node. |

## License

MIT
