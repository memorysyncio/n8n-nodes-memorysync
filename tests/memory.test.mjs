// Behaviour suite: both nodes driven through mocked n8n contexts against
// a real local HTTP server speaking the MemorySync wire protocol.
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { MockMemorySync, makeContext } from './harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { MemorySync } = await import(
	new URL(`file://${join(root, 'dist/nodes/MemorySync/MemorySync.node.js')}`).href
);
const { MemorySyncChatMemory } = await import(
	new URL(
		`file://${join(root, 'dist/nodes/MemorySyncChatMemory/MemorySyncChatMemory.node.js')}`,
	).href
);

function freshMock(t) {
	const mock = new MockMemorySync();
	t.after(async () => mock.stop());
	return mock;
}

// ── main node: execute() ────────────────────────────────────────────────

test('addTurn stores with a deterministic seed and converges on retry', async (t) => {
	const mock = freshMock(t);
	await mock.start();
	const node = new MemorySync();
	const parameters = {
		operation: 'addTurn',
		endUserId: 'customer-1',
		role: 'human',
		text: 'I always take the window seat',
		sessionId: 'chat-1',
	};
	const ctx = makeContext({ baseUrl: mock.baseUrl, parameters });
	const [out1] = await node.execute.call(ctx);
	assert.equal(out1[0].json.alreadyExists, false);
	assert.match(out1[0].json.memoryId, /^m_\d+$/);

	const [out2] = await node.execute.call(makeContext({ baseUrl: mock.baseUrl, parameters }));
	assert.equal(out2[0].json.alreadyExists, true, 'identical turn must converge, not duplicate');
	assert.equal(mock.rows.length, 1);

	const stored = mock.requests.find((r) => r.url === '/v1/memory/add_turn');
	assert.match(stored.body.speaker, /^human@n8n::chat-1#h[0-9a-f]{16}$/);
	assert.equal(stored.body.metadata.session_id, 'n8n::chat-1');
});

test('addMemory sends the X-End-User-ID header and tolerates all three envelopes', async (t) => {
	const mock = freshMock(t);
	await mock.start();
	const node = new MemorySync();
	const parameters = {
		operation: 'addMemory',
		endUserId: 'customer-2',
		text: 'Prefers teal dashboards',
		source: 'n8n',
		metadata: '{"workflow":"crm"}',
	};
	const [out] = await node.execute.call(makeContext({ baseUrl: mock.baseUrl, parameters }));
	assert.equal(out[0].json.stored, true);
	const request = mock.requests.find((r) => r.url === '/memory/add');
	assert.equal(request.headers['x-end-user-id'], 'customer-2');
	assert.deepEqual(request.body.metadata, { workflow: 'crm' });

	// Silent-quota envelope: accepted, not an error.
	mock.quotaMode = 'silent';
	const [outQuota] = await node.execute.call(makeContext({ baseUrl: mock.baseUrl, parameters }));
	assert.equal(outQuota[0].json.stored, false);
	assert.equal(outQuota[0].json.accepted, true);
});

test('invalid metadata JSON produces a human-readable error', async (t) => {
	const mock = freshMock(t);
	await mock.start();
	const node = new MemorySync();
	const parameters = {
		operation: 'addMemory',
		endUserId: 'customer-2',
		text: 'x',
		metadata: '{broken',
	};
	await assert.rejects(
		() => node.execute.call(makeContext({ baseUrl: mock.baseUrl, parameters })),
		/Metadata must be valid JSON/,
	);
});

test('search fans results out as items and scopes by user header', async (t) => {
	const mock = freshMock(t);
	await mock.start();
	mock.rows.push(
		{ memory_id: 'm_9', raw_text: 'Window seat', metadata: null, created_at: '2026-01-01' },
	);
	const node = new MemorySync();
	const parameters = { operation: 'search', endUserId: 'customer-3', query: 'seat', limit: 5 };
	const [out] = await node.execute.call(makeContext({ baseUrl: mock.baseUrl, parameters }));
	assert.equal(out.length, 1);
	assert.equal(out[0].json.text, 'Window seat');
	const request = mock.requests.find((r) => r.url === '/memory/query');
	assert.equal(request.headers['x-end-user-id'], 'customer-3');
	assert.equal(request.body.k, 5);
});

test('recall returns a prompt-ready context block', async (t) => {
	const mock = freshMock(t);
	await mock.start();
	mock.rows.push({ memory_id: 'm_1', raw_text: 'Vegetarian', metadata: null });
	const node = new MemorySync();
	const parameters = { operation: 'recall', endUserId: 'u1', query: 'diet', limit: 5 };
	const [out] = await node.execute.call(makeContext({ baseUrl: mock.baseUrl, parameters }));
	assert.match(out[0].json.context, /Vegetarian/);
});

test('recall falls back to the default tenant for scopeless keys', async (t) => {
	const mock = freshMock(t);
	await mock.start();
	mock.projectsStatus = 401; // evaluation-key behaviour
	const node = new MemorySync();
	const parameters = { operation: 'recall', endUserId: 'u1', query: 'anything at all', limit: 3 };
	const [out] = await node.execute.call(makeContext({ baseUrl: mock.baseUrl, parameters }));
	assert.equal(typeof out[0].json.context, 'string');
	const recall = mock.requests.find((r) => r.url === '/v1/memory/recall');
	assert.equal(recall.body.tenant_id, 'default');
});

test('delete parses m_-prefixed ids and requires at least one', async (t) => {
	const mock = freshMock(t);
	await mock.start();
	const node = new MemorySync();
	const [out] = await node.execute.call(
		makeContext({
			baseUrl: mock.baseUrl,
			parameters: { operation: 'delete', endUserId: 'u1', memoryIds: 'm_12, 34' },
		}),
	);
	const request = mock.requests.find((r) => r.url === '/memory/forget');
	assert.deepEqual(request.body.memory_ids, [12, 34]);
	assert.ok(out[0].json.deleted);

	await assert.rejects(
		() =>
			node.execute.call(
				makeContext({
					baseUrl: mock.baseUrl,
					parameters: { operation: 'delete', endUserId: 'u1', memoryIds: ' , ' },
				}),
			),
		/at least one memory ID/,
	);
});

test('strict eval 429 surfaces as an error the workflow can catch', async (t) => {
	const mock = freshMock(t);
	await mock.start();
	mock.quotaMode = 'strict';
	const node = new MemorySync();
	const parameters = { operation: 'search', endUserId: 'u1', query: 'anything', limit: 3 };
	await assert.rejects(() => node.execute.call(makeContext({ baseUrl: mock.baseUrl, parameters })));
});

// ── chat-memory sub-node: supplyData() ─────────────────────────────────
// supplyMemory() returns a real LangChain BaseChatMemory adapter — the
// tests drive EXACTLY the interface n8n's AI Agent drives:
// loadMemoryVariables / saveContext / clear.

async function supplyMemoryFor(mock, parameters) {
	const node = new MemorySyncChatMemory();
	const ctx = makeContext({ baseUrl: mock.baseUrl, parameters });
	const supplied = await node.supplyData.call(ctx, 0);
	const memory = supplied.response;
	return {
		memory,
		ctx,
		saveTurn: (input, output) => memory.saveContext({ input }, { output }),
		loadMessages: async () => {
			const variables = await memory.loadMemoryVariables({});
			return variables.chat_history;
		},
	};
}

const CHAT_PARAMS = {
	sessionId: 'chat-42',
	endUserId: 'customer-42',
	options: { windowSize: 10 },
};

function lcText(message) {
	const content = message.content;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part === 'string' ? part : part.text ?? ''))
			.join('');
	}
	return '';
}

test('chat memory persists turns with seeds and replays them chronologically', async (t) => {
	const mock = freshMock(t);
	await mock.start();
	const { saveTurn, loadMessages } = await supplyMemoryFor(mock, CHAT_PARAMS);

	await saveTurn('My name is Rafay', 'Nice to meet you, Rafay!');
	assert.equal(mock.addTurnCalls(), 2, 'one user + one assistant turn');
	const seeds = mock.requests
		.filter((r) => r.url === '/v1/memory/add_turn')
		.map((r) => r.body.speaker);
	assert.match(seeds[0], /^human@n8n::chat-42#h/);
	assert.match(seeds[1], /^ai@n8n::chat-42#h/);

	const messages = await loadMessages();
	assert.equal(messages.length, 2);
	assert.equal(messages[0]._getType(), 'human');
	assert.equal(lcText(messages[0]), 'My name is Rafay');
	assert.equal(messages[1]._getType(), 'ai');
});

test('history is isolated per session scope', async (t) => {
	const mock = freshMock(t);
	await mock.start();
	const a = await supplyMemoryFor(mock, { ...CHAT_PARAMS, sessionId: 'chat-A' });
	const b = await supplyMemoryFor(mock, { ...CHAT_PARAMS, sessionId: 'chat-B' });
	await a.saveTurn('Session A message', 'Reply A');
	const messagesB = await b.loadMessages();
	assert.equal(messagesB.length, 0, 'session B must not see session A history');
});

test('session filter accepts both metadata envelopes (nested production + legacy flat)', async (t) => {
	// Production nests client metadata (item.metadata.metadata.session_id) —
	// the mock's add_turn reproduces that. A legacy flat row must also match,
	// mirroring the LangChain adapter's dual-shape tolerance.
	const mock = freshMock(t);
	await mock.start();
	const { saveTurn, loadMessages } = await supplyMemoryFor(mock, CHAT_PARAMS);
	await saveTurn('Nested-envelope turn', 'Nested reply');
	mock.rows.unshift({
		memory_id: `m_${mock.nextId++}`,
		raw_text: 'human: Legacy flat-envelope turn',
		metadata: { session_id: 'n8n::chat-42' },
		user_id: 'customer-42',
		seed: null,
		created_at: new Date(0).toISOString(),
	});
	const messages = await loadMessages();
	assert.equal(messages.length, 3, 'both envelope shapes must contribute history');
	assert.equal(lcText(messages[0]), 'Legacy flat-envelope turn');
	assert.equal(lcText(messages[1]), 'Nested-envelope turn');
});

test('window size caps the replayed history (windowSize counts turn pairs)', async (t) => {
	const mock = freshMock(t);
	await mock.start();
	const { saveTurn, loadMessages } = await supplyMemoryFor(mock, {
		...CHAT_PARAMS,
		options: { windowSize: 2 },
	});
	await saveTurn('one', 'ack one');
	await saveTurn('two', 'ack two');
	await saveTurn('three', 'ack three');
	const messages = await loadMessages();
	assert.equal(messages.length, 4, 'windowSize=2 keeps the last two turn pairs');
	assert.equal(lcText(messages[3]), 'ack three');
});

test('clear() is a deliberate no-op — agent can never bulk-delete', async (t) => {
	const mock = freshMock(t);
	await mock.start();
	const { memory, ctx, saveTurn } = await supplyMemoryFor(mock, CHAT_PARAMS);
	await saveTurn('keep me', 'kept');
	await memory.clear();
	assert.equal(mock.rows.length, 2, 'rows survive clear()');
	assert.equal(
		mock.requests.filter((r) => r.method === 'DELETE').length,
		0,
		'no delete request may ever leave the memory node',
	);
	assert.ok(ctx.logs.info.length >= 1);
});

test('memory outage degrades to empty history, never an error', async (t) => {
	const mock = freshMock(t);
	await mock.start();
	const { ctx, saveTurn, loadMessages } = await supplyMemoryFor(mock, CHAT_PARAMS);
	mock.failAll = true;
	const messages = await loadMessages();
	assert.deepEqual(messages, []);
	await saveTurn('lost write', 'also lost'); // must not throw
	assert.ok(ctx.logs.warn.length >= 1);
});

test('quota-silent adds are absorbed without error', async (t) => {
	const mock = freshMock(t);
	await mock.start();
	mock.quotaMode = 'silent';
	const { saveTurn } = await supplyMemoryFor(mock, CHAT_PARAMS);
	await saveTurn('over quota', 'still fine');
	assert.equal(mock.rows.length, 0, 'nothing stored, nothing thrown');
});

test('missing session or user id fails loudly at supply time', async (t) => {
	const mock = freshMock(t);
	await mock.start();
	const node = new MemorySyncChatMemory();
	await assert.rejects(
		() =>
			node.supplyData.call(
				makeContext({ baseUrl: mock.baseUrl, parameters: { ...CHAT_PARAMS, sessionId: ' ' } }),
				0,
			),
		/Session ID is required/,
	);
	await assert.rejects(
		() =>
			node.supplyData.call(
				makeContext({ baseUrl: mock.baseUrl, parameters: { ...CHAT_PARAMS, endUserId: '' } }),
				0,
			),
		/End User ID is required/,
	);
});

test('on an n8n without @n8n/ai-node-sdk the package loads and the sub-node says "update n8n"', async (t) => {
	// Reproduce an n8n release older than 2.16.0: everything resolves as
	// usual except the SDK, which does not exist. A preload hook makes
	// require('@n8n/ai-node-sdk') fail with MODULE_NOT_FOUND, then a child
	// process loads every registered file the way n8n's package loader does
	// (no per-node try/catch) and calls supplyData().
	const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { execFileSync } = await import('node:child_process');
	const sandbox = mkdtempSync(join(tmpdir(), 'n8n-old-'));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	writeFileSync(
		join(sandbox, 'hide-sdk.cjs'),
		`
		const Module = require('node:module');
		const resolve = Module._resolveFilename;
		Module._resolveFilename = function (request, ...rest) {
			if (request === '@n8n/ai-node-sdk' || request.startsWith('@n8n/ai-node-sdk/')) {
				const error = new Error("Cannot find module '" + request + "'");
				error.code = 'MODULE_NOT_FOUND';
				throw error;
			}
			return resolve.call(this, request, ...rest);
		};
		`,
	);
	writeFileSync(
		join(sandbox, 'probe.cjs'),
		`
		const root = process.argv[2];
		const pkg = require(root + '/dist/package.json');
		const loaded = [];
		for (const file of [...pkg.n8n.credentials, ...pkg.n8n.nodes]) {
			loaded.push(Object.keys(require(root + '/' + file))[0]);
		}
		const { MemorySyncChatMemory } = require(root + '/dist/nodes/MemorySyncChatMemory/MemorySyncChatMemory.node.js');
		const ctx = {
			getNodeParameter: (name, _i, fallback) => ({ sessionId: 's1', endUserId: 'u1' })[name] ?? fallback,
			getNode: () => ({ name: 'MemorySync Chat Memory', type: 'n8n-nodes-memorysync.memorySyncChatMemory' }),
		};
		new MemorySyncChatMemory().supplyData.call(ctx, 0).then(
			() => { console.log(JSON.stringify({ loaded, supplied: true })); },
			(error) => { console.log(JSON.stringify({ loaded, supplied: false, message: error.message, name: error.constructor.name })); },
		);
		`,
	);
	const out = execFileSync(
		process.execPath,
		['--require', join(sandbox, 'hide-sdk.cjs'), join(sandbox, 'probe.cjs'), root],
		{ cwd: root, encoding: 'utf8' },
	);
	const result = JSON.parse(out.trim().split('\n').pop());
	assert.deepEqual(result.loaded, ['MemorySyncApi', 'MemorySync', 'MemorySyncChatMemory'], 'every registered file must load without the SDK');
	assert.equal(result.supplied, false);
	assert.equal(result.name, 'NodeOperationError', 'the failure is a proper n8n node error, not a raw MODULE_NOT_FOUND');
	assert.match(result.message, /needs n8n 2\.16\.0 or later/);
});
