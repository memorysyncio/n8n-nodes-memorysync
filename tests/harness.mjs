// Shared test harness: a real local HTTP server standing in for the
// MemorySync platform, plus minimal mocks of n8n's execution contexts.
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export class MockMemorySync {
	constructor() {
		this.rows = [];
		this.requests = [];
		this.quotaMode = null; // null | 'silent' | 'strict'
		this.failAll = false;
		this.nextId = 1;
		this.tenantId = 'acme';
		this.projectsStatus = 200;
		this.server = null;
		this.baseUrl = '';
	}

	async start() {
		this.server = createServer((req, res) => {
			let body = '';
			req.on('data', (chunk) => (body += chunk));
			req.on('end', () => {
				const parsed = body ? JSON.parse(body) : {};
				this.requests.push({
					method: req.method,
					url: req.url,
					headers: req.headers,
					body: parsed,
				});
				this.route(req, res, parsed);
			});
		});
		await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
		this.baseUrl = `http://127.0.0.1:${this.server.address().port}`;
	}

	async stop() {
		await new Promise((resolve) => this.server.close(resolve));
	}

	json(res, status, payload) {
		res.writeHead(status, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(payload));
	}

	route(req, res, body) {
		if (this.failAll) {
			req.socket.destroy();
			return;
		}
		const url = new URL(req.url, 'http://x');
		const path = url.pathname;

		if (req.method === 'GET' && path === '/org/projects') {
			if (this.projectsStatus !== 200) {
				return this.json(res, this.projectsStatus, { detail: 'no scope' });
			}
			return this.json(res, 200, [{ id: 'proj_1', tenant_id: this.tenantId }]);
		}

		const metered =
			(req.method === 'POST' && ['/v1/memory/add_turn', '/memory/add'].includes(path)) ||
			(req.method === 'POST' && ['/memory/query', '/v1/memory/recall'].includes(path));
		if (this.quotaMode && metered) {
			if (this.quotaMode === 'strict') {
				return this.json(res, 429, {
					detail: { error: 'limit_exceeded', message: 'You have reached your monthly limit.' },
				});
			}
			if (path === '/memory/query') return this.json(res, 200, { memories: [] });
			if (path === '/v1/memory/recall') return this.json(res, 200, { context: '', memories: [] });
			return this.json(res, 200, { status: 'ok' });
		}

		if (req.method === 'POST' && path === '/v1/memory/add_turn') {
			const seed = body.speaker;
			const existing = this.rows.find((row) => row.seed && row.seed === seed);
			if (existing) {
				return this.json(res, 200, {
					memory_id: existing.memory_id,
					status: 'stored',
					already_exists: true,
				});
			}
			const memoryId = `m_${this.nextId++}`;
			this.rows.push({
				memory_id: memoryId,
				raw_text: body.text,
				// Production wraps client metadata one level deeper:
				// item.metadata = { speaker, source, ..., metadata: {session_id} }.
				// Reproduce that exact envelope so the session filter is tested
				// against the real shape (a flat filter passed here but returned
				// zero history live).
				metadata: {
					speaker: body.speaker ?? null,
					source: body.source ?? null,
					episodic: true,
					metadata: body.metadata ?? {},
					_raw_text: body.text,
				},
				user_id: body.user_id,
				seed,
				created_at: new Date(Date.now() + this.rows.length * 1000).toISOString(),
			});
			return this.json(res, 200, { memory_id: memoryId, status: 'stored', already_exists: false });
		}

		if (req.method === 'POST' && path === '/memory/add') {
			const memoryId = this.nextId++;
			this.rows.push({
				memory_id: `m_${memoryId}`,
				raw_text: body.text,
				metadata: body.metadata ?? null,
				user_id: req.headers['x-end-user-id'],
				seed: null,
				created_at: new Date().toISOString(),
			});
			return this.json(res, 200, { id: memoryId, text: body.text, source: body.source });
		}

		if (req.method === 'POST' && path === '/memory/query') {
			return this.json(res, 200, {
				memories: this.rows.slice(-5).map((row) => ({ id: row.memory_id, text: row.raw_text })),
			});
		}

		if (req.method === 'POST' && path === '/v1/memory/recall') {
			const lines = this.rows.slice(-5).map((row) => `- ${row.raw_text}`);
			return this.json(res, 200, {
				context: lines.join('\n'),
				memories: this.rows.slice(-5).map((row) => ({ memory_id: row.memory_id, value: row.raw_text })),
			});
		}

		if (req.method === 'GET' && /^\/v1\/memory\/[^/]+\/[^/]+\/list$/.test(path)) {
			// Newest first, like production.
			const memories = [...this.rows].reverse().map((row) => ({
				memory_id: row.memory_id,
				raw_text: row.raw_text,
				metadata: row.metadata,
				created_at: row.created_at,
				source: 'n8n',
			}));
			return this.json(res, 200, { memories, total: memories.length });
		}

		if (req.method === 'DELETE' && path === '/memory/forget') {
			const ids = body.memory_ids ?? [];
			return this.json(res, 200, { deleted_ids: ids });
		}

		this.json(res, 404, { detail: `unhandled ${req.method} ${path}` });
	}

	addTurnCalls() {
		return this.requests.filter((r) => r.url === '/v1/memory/add_turn').length;
	}
}

/** Minimal httpRequest helper matching n8n's IHttpRequestOptions surface. */
async function httpRequest(options) {
	// axios semantics: a relative `url` is joined onto `baseURL`.
	const url = options.baseURL
		? `${options.baseURL.replace(/\/+$/, '')}/${options.url.replace(/^\/+/, '')}`
		: options.url;
	const response = await fetch(url, {
		method: options.method,
		headers: options.headers,
		body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
	});
	const text = await response.text();
	let payload;
	try {
		payload = text ? JSON.parse(text) : undefined;
	} catch {
		payload = text;
	}
	if (response.status >= 400) {
		const error = new Error(`HTTP ${response.status}`);
		error.httpCode = String(response.status);
		error.statusCode = response.status;
		error.response = { body: payload };
		throw error;
	}
	return payload;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { MemorySyncApi } = await import(
	new URL(`file://${join(root, 'dist/credentials/MemorySyncApi.credentials.js')}`).href
);
const credentialType = new MemorySyncApi();

/** Build a mock n8n execution/supply-data context. */
export function makeContext({ baseUrl, apiKey = 'ms_test', parameters = {}, items = [{ json: {} }] }) {
	const logs = { warn: [], info: [] };
	const credentials = { apiKey, baseUrl };
	return {
		logs,
		getInputData: () => items,
		getNodeParameter: (name, _itemIndex, fallback) =>
			name in parameters ? parameters[name] : fallback,
		// n8n's verification review: node code must never read credentials
		// directly — httpRequestWithAuthentication applies them from the
		// credential file. Calling this from a node is therefore a test failure.
		getCredentials: async () => {
			throw new Error('node code must not call getCredentials(); use httpRequestWithAuthentication');
		},
		getNode: () => ({ name: 'MemorySync', type: 'n8n-nodes-memorysync.memorySync' }),
		continueOnFail: () => false,
		// logWrapper telemetry hooks (no-op in tests)
		addInputData: () => ({ index: 0 }),
		addOutputData: () => {},
		helpers: {
			httpRequest,
			// What n8n does: look the credential up by type, run the credential
			// class's authenticate() over the request, then send it.
			async httpRequestWithAuthentication(credentialsType, options) {
				if (credentialsType !== credentialType.name) {
					throw new Error(`unknown credential type ${credentialsType}`);
				}
				const authenticated = await credentialType.authenticate(credentials, options);
				return httpRequest(authenticated);
			},
		},
		logger: {
			warn: (message) => logs.warn.push(message),
			info: (message) => logs.info.push(message),
		},
	};
}
