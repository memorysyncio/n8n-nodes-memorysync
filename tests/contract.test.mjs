// Contract pins: the package's registry metadata and node descriptions
// stay wired to REAL MemorySync endpoints and n8n's community-node rules.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// The FastAPI surface this node is allowed to call (task-46-audited routes).
const REAL_ENDPOINTS = [
	['POST', '/memory/add'],
	['POST', '/memory/query'],
	['POST', '/v1/memory/add_turn'],
	['POST', '/v1/memory/recall'],
	['DELETE', '/memory/forget'],
	['GET', '/org/projects'],
];

test('package name and keyword follow the community-node registry contract', () => {
	assert.ok(pkg.name.startsWith('n8n-nodes-'), 'name must start with n8n-nodes-');
	assert.ok(
		pkg.keywords.includes('n8n-community-node-package'),
		'keyword n8n-community-node-package is how n8n discovers the package',
	);
});

test('verified-program hard rule: zero runtime dependencies', () => {
	assert.equal(pkg.dependencies, undefined, 'runtime dependencies are forbidden for verified nodes');
	assert.deepEqual(
		Object.keys(pkg.peerDependencies).sort(),
		['@n8n/ai-node-sdk', 'n8n-workflow'],
		'only n8n-workflow and @n8n/ai-node-sdk may be peers (valid-peer-dependencies rule)',
	);
	assert.equal(pkg.peerDependencies['n8n-workflow'], '*');
	assert.equal(pkg.peerDependencies['@n8n/ai-node-sdk'], '*');
});

test('ai-node-sdk metadata: n8n.aiNodeSdkVersion pairs with the peer dependency', () => {
	// n8n's manual review round 2 (2026-09-04): "If you are using the beta
	// ai-node-sdk please include all of the metadata required and the
	// peerDependency for it." The ai-node-package-json lint rule requires
	// n8n.aiNodeSdkVersion (positive integer) whenever the SDK is a peer.
	assert.equal(pkg.n8n.aiNodeSdkVersion, 1);
	assert.equal(Number.isInteger(pkg.n8n.aiNodeSdkVersion) && pkg.n8n.aiNodeSdkVersion > 0, true);
	assert.equal(pkg.n8n.strict, true, 'strict mode = default eslint config, required for Cloud verification');
	assert.equal('aiNodeSdkVersion' in pkg, false, 'must live inside the n8n section, not at the root');
});

test('build, lint and dev go through @n8n/node-cli', () => {
	// Review round 2: "We strongly recommend using our node-cli which will
	// be required in the future."
	assert.equal(pkg.scripts.build, 'n8n-node build');
	assert.equal(pkg.scripts.lint, 'n8n-node lint');
	assert.equal(pkg.scripts['lint:fix'], 'n8n-node lint --fix');
	assert.equal(pkg.scripts.dev, 'n8n-node dev');
	assert.ok(pkg.devDependencies['@n8n/node-cli'], '@n8n/node-cli must be a devDependency');
	// Strict mode requires the default config, byte-for-byte modulo whitespace.
	const eslintConfig = readFileSync(join(root, 'eslint.config.mjs'), 'utf8').replace(/\s+/g, ' ').trim();
	assert.equal(eslintConfig, "import { config } from '@n8n/node-cli/eslint'; export default config;");
	for (const forbidden of ['preinstall', 'install', 'postinstall']) {
		assert.equal(pkg.scripts[forbidden], undefined, `${forbidden} lifecycle script is forbidden`);
	}
});

test('dev n8n-workflow pin equals the one @n8n/ai-utilities ships against', () => {
	// The SDK re-exports types from a pinned n8n-workflow. A different copy at
	// the top level gives two ISupplyDataFunctions and supplyMemory() stops
	// type-checking — so the devDependency must track the SDK's pin exactly
	// (bump both together).
	const aiUtilities = JSON.parse(
		readFileSync(join(root, 'node_modules/@n8n/ai-utilities/package.json'), 'utf8'),
	);
	assert.equal(
		pkg.devDependencies['n8n-workflow'],
		aiUtilities.dependencies['n8n-workflow'],
		`devDependencies.n8n-workflow must be ${aiUtilities.dependencies['n8n-workflow']} (what @n8n/ai-utilities ${aiUtilities.version} pins)`,
	);
	assert.ok(
		!existsSync(join(root, 'node_modules/@n8n/ai-utilities/node_modules/n8n-workflow')),
		'a nested n8n-workflow copy means the pins diverged',
	);
});

test('the n8n field points at files that exist after build', () => {
	assert.equal(pkg.n8n.n8nNodesApiVersion, 1);
	for (const file of [...pkg.n8n.credentials, ...pkg.n8n.nodes]) {
		assert.ok(existsSync(join(root, file)), `${file} missing from dist — build first`);
	}
	// n8n-node build copies icons; tsc emits the codex JSON and package.json
	// (both are in tsconfig "include") — every runtime asset must be in dist.
	for (const asset of [
		'dist/package.json',
		'dist/nodes/MemorySync/MemorySync.node.json',
		'dist/nodes/MemorySyncChatMemory/MemorySyncChatMemory.node.json',
		'dist/nodes/MemorySync/memorysync.svg',
		'dist/nodes/MemorySync/memorysync.dark.svg',
		'dist/credentials/memorysync.svg',
		'dist/credentials/memorysync.dark.svg',
	]) {
		assert.ok(existsSync(join(root, asset)), `${asset} missing from dist`);
	}
	const distPkg = JSON.parse(readFileSync(join(root, 'dist/package.json'), 'utf8'));
	assert.equal(distPkg.version, pkg.version, 'dist/package.json is what the User-Agent reads at runtime');
	for (const rel of ['nodes/MemorySync/MemorySync.node.json', 'nodes/MemorySyncChatMemory/MemorySyncChatMemory.node.json']) {
		assert.deepEqual(
			JSON.parse(readFileSync(join(root, 'dist', rel), 'utf8')),
			JSON.parse(readFileSync(join(root, rel), 'utf8')),
			`${rel} in dist must equal the source codex file`,
		);
	}
});

test('codex files: only documented keys, only a supported category', () => {
	// n8n's manual verification review (2026-09-04) rejected the package on
	// two codex points: `subcategories` is not part of the .node.json format
	// (only node, nodeVersion, codexVersion, categories, resources, alias),
	// and `AI` is not a supported category — the n8n UI silently drops it.
	// Their suggested category for a memory node is Data & Storage.
	const ALLOWED_KEYS = new Set(['node', 'nodeVersion', 'codexVersion', 'categories', 'resources', 'alias']);
	const SUPPORTED_CATEGORIES = new Set([
		'Data & Storage', 'Finance & Accounting', 'Marketing & Content', 'Productivity', 'Miscellaneous',
		'Sales', 'Development', 'Analytics', 'Communication', 'Utility',
	]);
	for (const rel of ['nodes/MemorySync/MemorySync.node.json', 'nodes/MemorySyncChatMemory/MemorySyncChatMemory.node.json']) {
		const codex = JSON.parse(readFileSync(join(root, rel), 'utf8'));
		for (const key of Object.keys(codex)) assert.ok(ALLOWED_KEYS.has(key), `${rel}: "${key}" is not a codex key`);
		assert.ok(!('subcategories' in codex), `${rel}: subcategories was the rejected key`);
		assert.deepEqual(codex.categories, ['Data & Storage'], `${rel}: one supported category`);
		for (const category of codex.categories) assert.ok(SUPPORTED_CATEGORIES.has(category), `${rel}: "${category}" is not supported by n8n`);
		assert.equal(codex.node, `${pkg.name}.${rel.split('/').pop().replace('.node.json', '').replace(/^./, (c) => c.toLowerCase())}`);
		for (const link of [...codex.resources.credentialDocumentation, ...codex.resources.primaryDocumentation]) {
			assert.equal(link.url, 'https://docs.memorysync.io/guides/n8n');
		}
	}
});

test('User-Agent announces the exact version in package.json', async () => {
	// 1.0.4 shipped announcing itself as 1.0.3: the header was a typed string.
	// The version module now reads package.json (copied into dist by tsc), and
	// this pins the module, the compiled header and the manifest to one value.
	const { USER_AGENT, PACKAGE_VERSION } = await import(
		new URL(`file://${join(root, 'dist/nodes/shared/version.js')}`).href
	);
	assert.equal(PACKAGE_VERSION, pkg.version);
	assert.equal(USER_AGENT, `${pkg.name}/${pkg.version}`);
	const generic = readFileSync(join(root, 'dist/nodes/shared/GenericFunctions.js'), 'utf8');
	assert.ok(!/n8n-nodes-memorysync\/\d+\.\d+\.\d+/.test(generic), 'no hand-typed version may remain in the request plumbing');
	assert.ok(generic.includes('USER_AGENT'), 'request plumbing must use the generated USER_AGENT');
});

test('node code never reads credentials: every call is httpRequestWithAuthentication', () => {
	// n8n's manual review round 2: "Credentials shouldn't be accessed directly
	// in nodes as httpRequestWithAuthentication supplies it from the
	// credential file." Enforced over every compiled node/helper file.
	const compiled = [
		'dist/nodes/shared/GenericFunctions.js',
		'dist/nodes/shared/version.js',
		'dist/nodes/MemorySync/MemorySync.node.js',
		'dist/nodes/MemorySyncChatMemory/MemorySyncChatMemory.node.js',
		'dist/nodes/MemorySyncChatMemory/history.js',
	];
	for (const rel of compiled) {
		const source = readFileSync(join(root, rel), 'utf8');
		assert.ok(!source.includes('getCredentials'), `${rel} must not call getCredentials()`);
		assert.ok(!source.includes('X-API-Key'), `${rel} must not build the auth header itself`);
		assert.ok(!/helpers\.httpRequest\b/.test(source), `${rel} must not use the unauthenticated httpRequest helper`);
	}
	const generic = readFileSync(join(root, 'dist/nodes/shared/GenericFunctions.js'), 'utf8');
	assert.ok(generic.includes('httpRequestWithAuthentication'), 'request plumbing must go through httpRequestWithAuthentication');
	assert.ok(generic.includes("'memorySyncApi'"), 'the credential type name is passed to n8n, which loads the credential itself');
});

test('credential applies base URL and X-API-Key itself and ships a live test request', async () => {
	const { MemorySyncApi } = await import(
		new URL(`file://${join(root, 'dist/credentials/MemorySyncApi.credentials.js')}`).href
	);
	const credential = new MemorySyncApi();
	assert.equal(credential.name, 'memorySyncApi');
	assert.equal(typeof credential.authenticate, 'function', 'authenticate() is the only place credentials are read');

	// Default deployment.
	const authed = await credential.authenticate(
		{ apiKey: 'ms_live_123', baseUrl: 'https://api.memorysync.io' },
		{ method: 'POST', url: '/memory/query', headers: { 'X-End-User-ID': 'u1' }, json: true },
	);
	assert.equal(authed.baseURL, 'https://api.memorysync.io');
	assert.equal(authed.url, '/memory/query', 'the relative path is left for axios to join');
	assert.equal(authed.headers['X-API-Key'], 'ms_live_123');
	assert.equal(authed.headers['X-End-User-ID'], 'u1', 'existing headers survive');
	assert.equal(authed.method, 'POST');

	// Regional / self-hosted override, trailing slash tolerated; empty falls back.
	const regional = await credential.authenticate({ apiKey: 'k', baseUrl: 'https://eu.memorysync.io/' }, { url: '/x', headers: {} });
	assert.equal(regional.baseURL, 'https://eu.memorysync.io');
	const fallback = await credential.authenticate({ apiKey: 'k', baseUrl: '' }, { url: '/x' });
	assert.equal(fallback.baseURL, 'https://api.memorysync.io');

	assert.equal(credential.test.request.url, '/memory/query');
	assert.equal(credential.test.request.method, 'POST');
	const masked = credential.properties.find((p) => p.name === 'apiKey');
	assert.equal(masked.typeOptions.password, true, 'API key must be masked in the UI');
});

test('main node: one resource, six operations, usableAsTool, and only real endpoints in source', async () => {
	const { MemorySync } = await import(
		new URL(`file://${join(root, 'dist/nodes/MemorySync/MemorySync.node.js')}`).href
	);
	const node = new MemorySync();
	const description = node.description;
	assert.equal(description.usableAsTool, true);
	assert.equal(description.credentials[0].name, 'memorySyncApi');
	// >5 operations must be organised under a resource (resource-operation-pattern rule).
	const resource = description.properties.find((p) => p.name === 'resource');
	assert.equal(resource.type, 'options');
	assert.equal(resource.noDataExpression, true);
	assert.deepEqual(resource.options.map((o) => o.value), ['memory']);
	assert.equal(resource.default, 'memory', 'existing workflows (no resource stored) must keep working');
	const operationParam = description.properties.find((p) => p.name === 'operation');
	assert.deepEqual(operationParam.displayOptions, { show: { resource: ['memory'] } });
	const operations = operationParam.options;
	assert.deepEqual(
		operations.map((o) => o.value).sort(),
		['addMemory', 'addTurn', 'delete', 'getAll', 'recall', 'search'],
	);
	assert.deepEqual(
		operations.map((o) => o.name),
		[...operations.map((o) => o.name)].sort((a, b) => a.localeCompare(b)),
		'operation options must be alphabetised',
	);
	const getMany = operations.find((o) => o.value === 'getAll');
	assert.equal(getMany.name, 'Get Many');
	assert.ok(getMany.action.startsWith('Get many'));
	for (const option of operations) {
		assert.ok(option.action, `${option.value} needs an action (tool + AI Agent display)`);
		assert.equal(option.action[0], option.action[0].toUpperCase(), 'actions are sentence-cased');
	}

	// Every endpoint literal in the compiled sources must be a real route.
	const sources = [
		readFileSync(join(root, 'dist/nodes/MemorySync/MemorySync.node.js'), 'utf8'),
		readFileSync(join(root, 'dist/nodes/shared/GenericFunctions.js'), 'utf8'),
	].join('\n');
	const known = new Set(REAL_ENDPOINTS.map(([, path]) => path));
	for (const match of sources.matchAll(/['"`](\/(?:v1\/)?(?:memory|org)\/[A-Za-z0-9_/${}-]*)['"`]/g)) {
		const literal = match[1].replace(/\$\{[^}]*\}/g, 'X');
		const normalized = literal
			.replace('/v1/memory/X/X/list', '/v1/memory/{t}/{u}/list')
			.replace(/\?.*$/, '');
		if (normalized === '/v1/memory/{t}/{u}/list') continue; // list route, parameterized
		assert.ok(
			known.has(normalized),
			`unknown endpoint literal in node source: ${match[1]}`,
		);
	}
});

test('memory sub-node: AiMemory output, no inputs, session+user required', async () => {
	const { MemorySyncChatMemory } = await import(
		new URL(
			`file://${join(root, 'dist/nodes/MemorySyncChatMemory/MemorySyncChatMemory.node.js')}`,
		).href
	);
	const node = new MemorySyncChatMemory();
	const description = node.description;
	assert.deepEqual(description.inputs, []);
	assert.equal(description.outputs.length, 1);
	assert.equal(String(description.outputs[0]), 'ai_memory');
	const names = description.properties.map((p) => p.name);
	assert.ok(names.includes('sessionId'));
	assert.ok(names.includes('endUserId'));
	assert.equal(typeof node.supplyData, 'function');
});

test('the SDK peer is loaded lazily: the package still loads on n8n without @n8n/ai-node-sdk', () => {
	// n8n strips peer dependencies at install time and resolves the SDK from
	// its own node_modules; releases before 2.16.0 have none. n8n loads every
	// node file of a package with no per-node try/catch, so a top-level
	// require of the SDK would take the workflow node and the credential down
	// with it on those instances. The SDK may therefore only be required
	// inside supplyData(), and the history module may not touch it at all.
	const nodeJs = readFileSync(
		join(root, 'dist/nodes/MemorySyncChatMemory/MemorySyncChatMemory.node.js'),
		'utf8',
	);
	const sdkRequire = /require\(["']@n8n\/ai-node-sdk["']\)/;
	assert.ok(
		!/^(const|let|var) .*require\(["']@n8n\/ai-node-sdk["']\)/m.test(nodeJs),
		'no module-level require of the SDK (that is what runs at package load)',
	);
	assert.equal((nodeJs.match(new RegExp(sdkRequire.source, 'g')) ?? []).length, 1, 'the SDK is required exactly once — inside the lazy loader');
	assert.ok(
		/Promise\.resolve\(\)\.then\(\(\) => __importStar\(require\(["']@n8n\/ai-node-sdk["']\)\)\)/.test(nodeJs),
		'the lazy loader is a dynamic import (deferred require) awaited inside supplyData',
	);
	assert.ok(nodeJs.includes('needs n8n 2.16.0 or later'), 'a missing SDK must produce the "update n8n" error');
	const historyJs = readFileSync(join(root, 'dist/nodes/MemorySyncChatMemory/history.js'), 'utf8');
	assert.ok(!sdkRequire.test(historyJs), 'history implements ChatHistory with type-only imports (no SDK require)');
	// The other registered files never touch the SDK either.
	for (const rel of ['dist/nodes/MemorySync/MemorySync.node.js', 'dist/nodes/shared/GenericFunctions.js', 'dist/credentials/MemorySyncApi.credentials.js']) {
		assert.ok(!/@n8n\/ai-node-sdk/.test(readFileSync(join(root, rel), 'utf8')), `${rel} must not depend on the SDK`);
	}
});

test('fnv1a64 parity vector matches the Python adapters', async () => {
	const { fnv1a64 } = await import(
		new URL(`file://${join(root, 'dist/nodes/shared/GenericFunctions.js')}`).href
	);
	// Pinned vector: python fnv1a64('human:hello') over UTF-16 code units.
	assert.equal(fnv1a64('human:hello'), 'dc7ad99e64417378');
});
