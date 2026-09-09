/**
 * Shared MemorySync plumbing for both nodes.
 *
 * Self-contained by design: the n8n verified-community-node program
 * forbids runtime npm dependencies, so everything here rides on the
 * helpers the n8n runtime provides and the standard library.
 *
 * Node code never touches the credential itself. Every call goes through
 * `httpRequestWithAuthentication`, and the credential's `authenticate`
 * hook (credentials/MemorySyncApi.credentials.ts) supplies the base URL
 * and the API key header — so a key can never leak into node code, and a
 * future credential change (rotation, OAuth) needs no node changes.
 */

import type {
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ISupplyDataFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { USER_AGENT } from './version';

/** The credential type both nodes declare. */
export const CREDENTIAL_TYPE = 'memorySyncApi';

/** Namespace used when the key cannot list projects (evaluation keys). */
export const FALLBACK_TENANT = 'default';

/** One turn beyond this length is truncated before storage. */
export const MAX_TURN_CHARS = 16000;

/**
 * FNV-1a 64-bit over UTF-16 code units, as a fixed-width hex string.
 * Character-for-character identical to every other MemorySync adapter
 * (Python and JS), so a turn persisted here and again by any other
 * surface converges on one stored row.
 */
export function fnv1a64(input: string): string {
	const PRIME = 0x100000001b3n;
	const MASK = 0xffffffffffffffffn;
	let hash = 0xcbf29ce484222325n;
	for (let i = 0; i < input.length; i += 1) {
		hash ^= BigInt(input.charCodeAt(i));
		hash = (hash * PRIME) & MASK;
	}
	return hash.toString(16).padStart(16, '0');
}

type Ctx = IExecuteFunctions | ISupplyDataFunctions;

/**
 * One authenticated call to the MemorySync API. `path` is relative
 * (`/memory/query`); the credential's `authenticate` hook prepends the
 * configured base URL and adds the API key header.
 */
export async function memorySyncRequest(
	ctx: Ctx,
	method: IHttpRequestMethods,
	path: string,
	body?: Record<string, unknown>,
	extraHeaders?: Record<string, string>,
): Promise<unknown> {
	const options: IHttpRequestOptions = {
		method,
		url: path,
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
			'User-Agent': USER_AGENT,
			...(extraHeaders ?? {}),
		},
		json: true,
	};
	if (body !== undefined) {
		options.body = body;
	}
	return await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL_TYPE, options);
}

/** The HTTP status carried by an n8n request error, if any. */
export function httpStatusOf(error: unknown): string | undefined {
	const candidate = error as {
		httpCode?: string | number | null;
		statusCode?: number;
		status?: number;
		response?: { status?: number; statusCode?: number };
	};
	const raw =
		candidate?.httpCode ??
		candidate?.statusCode ??
		candidate?.status ??
		candidate?.response?.status ??
		candidate?.response?.statusCode;
	return raw === undefined || raw === null ? undefined : String(raw);
}

/**
 * Resolve the tenant id the v1 routes need. Keys without the
 * projects:read scope (evaluation keys) answer 401/403 — those fall
 * back to the fixed namespace "default", deterministically. Any other
 * failure re-raises rather than silently switching namespaces.
 */
export async function resolveTenantId(ctx: Ctx): Promise<string> {
	let projects: Array<{ tenant_id?: string }>;
	try {
		projects = (await memorySyncRequest(ctx, 'GET', '/org/projects')) as Array<{
			tenant_id?: string;
		}>;
	} catch (error) {
		const status = httpStatusOf(error);
		if (status === '401' || status === '403') {
			return FALLBACK_TENANT;
		}
		throw new NodeApiError(ctx.getNode(), error as JsonObject);
	}
	const tenant = Array.isArray(projects) && projects[0]?.tenant_id;
	if (tenant) return String(tenant);
	throw new NodeOperationError(ctx.getNode(), 'Could not determine the tenant for this API key.');
}

/** Items from /v1/memory/{tenant}/{user}/list (newest first). */
export interface V1MemoryItem {
	memory_id: string;
	raw_text?: string;
	summary?: string | null;
	metadata?: Record<string, unknown> | null;
	created_at?: string;
	source?: string;
	score?: number;
}

export async function listMemories(
	ctx: Ctx,
	tenantId: string,
	userId: string,
	limit = 0,
): Promise<V1MemoryItem[]> {
	const path = `/v1/memory/${encodeURIComponent(tenantId)}/${encodeURIComponent(userId)}/list?limit=${encodeURIComponent(String(limit))}`;
	const raw = (await memorySyncRequest(ctx, 'GET', path)) as { memories?: V1MemoryItem[] };
	return Array.isArray(raw?.memories) ? raw.memories : [];
}

/**
 * Store one verbatim turn with a deterministic idempotency seed.
 * Never throws for quota-silent responses; the caller decides how to
 * surface other failures.
 */
export async function addTurn(
	ctx: Ctx,
	params: {
		tenantId: string;
		userId: string;
		role: 'human' | 'ai';
		text: string;
		sessionScope: string;
	},
): Promise<{ memoryId: string | null; alreadyExists: boolean; accepted: boolean }> {
	let trimmed = params.text.trim();
	if (!trimmed) return { memoryId: null, alreadyExists: false, accepted: false };
	if (trimmed.length > MAX_TURN_CHARS) trimmed = trimmed.slice(0, MAX_TURN_CHARS);
	const seed = `${params.role}@n8n::${params.sessionScope}#h${fnv1a64(`${params.role}:${trimmed}`)}`;
	const response = (await memorySyncRequest(ctx, 'POST', '/v1/memory/add_turn', {
		tenant_id: params.tenantId,
		user_id: params.userId,
		source: 'n8n',
		text: `${params.role}: ${trimmed}`,
		speaker: seed,
		sync_embed: false,
		metadata: { session_id: `n8n::${params.sessionScope}` },
	})) as { memory_id?: string; already_exists?: boolean; status?: string };
	// Silent-quota envelope: {"status":"ok"} without an id — accepted
	// by contract, nothing stored. Never an error for the workflow.
	return {
		memoryId: response?.memory_id ?? null,
		alreadyExists: Boolean(response?.already_exists),
		accepted: true,
	};
}
