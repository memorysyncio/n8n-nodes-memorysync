import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	addTurn,
	listMemories,
	memorySyncRequest,
	resolveTenantId,
} from '../shared/GenericFunctions';

export class MemorySync implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'MemorySync',
		name: 'memorySync',
		icon: { light: 'file:memorysync.svg', dark: 'file:memorysync.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		description:
			'Long-term memory for AI: store, search, recall, list, and delete memories in MemorySync',
		defaults: { name: 'MemorySync' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'memorySyncApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [{ name: 'Memory', value: 'memory' }],
				default: 'memory',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['memory'] } },
				options: [
					{
						name: 'Add Conversation Turn',
						value: 'addTurn',
						action: 'Add a conversation turn',
						description:
							'Stores the exact text with a deterministic idempotency seed — safe to retry, never duplicates',
					},
					{
						name: 'Add Memory',
						value: 'addMemory',
						action: 'Add a memory',
						description:
							'Extracts and stores durable memories from the text (server-side intelligence gating applies)',
					},
					{
						name: 'Delete Memories',
						value: 'delete',
						action: 'Delete memories',
						description: 'Permanently deletes the given memory IDs for this user',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						action: 'Get many memories',
						description: 'Get many memories for a user, newest first',
					},
					{
						name: 'Recall Context',
						value: 'recall',
						action: 'Recall context for a prompt',
						description:
							'Hierarchical recall that returns a grouped, prompt-ready context block for downstream AI steps',
					},
					{
						name: 'Search Memories',
						value: 'search',
						action: 'Search memories semantically',
						description: 'Returns the most relevant memories for a natural-language query',
					},
				],
				default: 'search',
			},
			{
				displayName: 'End User ID',
				name: 'endUserId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'customer-42',
				description:
					'Which end user these memories belong to. Every operation is isolated to this user.',
			},
			// ── Add Memory ─────────────────────────────────────────────
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				displayOptions: { show: { operation: ['addMemory'] } },
				description: 'The text to remember',
			},
			{
				displayName: 'Source',
				name: 'source',
				type: 'string',
				default: 'n8n',
				displayOptions: { show: { operation: ['addMemory'] } },
				description: 'Where this memory came from (shows in the dashboard)',
			},
			{
				displayName: 'Metadata (JSON)',
				name: 'metadata',
				type: 'string',
				default: '',
				placeholder: '{"workflow": "support-tickets"}',
				displayOptions: { show: { operation: ['addMemory'] } },
				description: 'Optional JSON object attached to the memory',
			},
			// ── Add Conversation Turn ──────────────────────────────────
			{
				displayName: 'Role',
				name: 'role',
				type: 'options',
				options: [
					{ name: 'Assistant', value: 'ai' },
					{ name: 'User', value: 'human' },
				],
				default: 'human',
				displayOptions: { show: { operation: ['addTurn'] } },
				description: 'Who said it',
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				displayOptions: { show: { operation: ['addTurn'] } },
				description: 'The exact utterance to store verbatim',
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: 'default',
				displayOptions: { show: { operation: ['addTurn'] } },
				description:
					'Conversation/session this turn belongs to (scopes the transcript; memories stay shared per user)',
			},
			// ── Search / Recall ────────────────────────────────────────
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['search', 'recall'] } },
				description: 'What to look for, in natural language',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 50 },
				default: 50,
				displayOptions: { show: { operation: ['search', 'recall'] } },
				description: 'Max number of results to return',
			},
			// ── Get Many ───────────────────────────────────────────────
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 1000 },
				default: 50,
				displayOptions: { show: { operation: ['getAll'] } },
				description: 'Max number of results to return',
			},
			// ── Delete ─────────────────────────────────────────────────
			{
				displayName: 'Memory IDs',
				name: 'memoryIds',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'm_123, m_456',
				displayOptions: { show: { operation: ['delete'] } },
				description:
					'Comma-separated memory IDs to delete (as returned by Search or Get Many, e.g. m_123)',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				const endUserId = (this.getNodeParameter('endUserId', i) as string).trim();
				if (!endUserId) {
					throw new NodeOperationError(this.getNode(), 'End User ID is required', {
						itemIndex: i,
					});
				}
				const userHeader = { 'X-End-User-ID': endUserId };
				let out: IDataObject;

				if (operation === 'addMemory') {
					const text = this.getNodeParameter('text', i) as string;
					const source = this.getNodeParameter('source', i, 'n8n') as string;
					const metadataRaw = (this.getNodeParameter('metadata', i, '') as string).trim();
					let metadata: IDataObject | undefined;
					if (metadataRaw) {
						try {
							metadata = JSON.parse(metadataRaw) as IDataObject;
						} catch {
							throw new NodeOperationError(
								this.getNode(),
								'Metadata must be valid JSON, e.g. {"key": "value"}',
								{ itemIndex: i },
							);
						}
					}
					const body: IDataObject = { text, source };
					if (metadata) body.metadata = metadata;
					const response = (await memorySyncRequest(
						this,
						'POST',
						'/memory/add',
						body as Record<string, unknown>,
						userHeader,
					)) as IDataObject;
					// Three legitimate shapes: stored memory (id), skipped
					// (low-value content), or the silent-quota {"status":"ok"}.
					if (response?.id !== undefined) {
						out = { stored: true, ...response };
					} else if (response?.status === 'skipped') {
						out = { stored: false, ...response };
					} else {
						out = { stored: false, accepted: true, ...response };
					}
				} else if (operation === 'addTurn') {
					const role = this.getNodeParameter('role', i) as 'human' | 'ai';
					const text = this.getNodeParameter('text', i) as string;
					const sessionId =
						(this.getNodeParameter('sessionId', i, 'default') as string).trim() || 'default';
					const tenantId = await resolveTenantId(this);
					const result = await addTurn(this, {
						tenantId,
						userId: endUserId,
						role,
						text,
						sessionScope: sessionId,
					});
					out = {
						accepted: result.accepted,
						memoryId: result.memoryId,
						alreadyExists: result.alreadyExists,
					};
				} else if (operation === 'search') {
					const query = this.getNodeParameter('query', i) as string;
					const limit = this.getNodeParameter('limit', i, 5) as number;
					const response = (await memorySyncRequest(
						this,
						'POST',
						'/memory/query',
						{ query, k: limit },
						userHeader,
					)) as { memories?: IDataObject[] };
					const memories = Array.isArray(response?.memories) ? response.memories : [];
					for (const memory of memories) {
						returnData.push({ json: memory, pairedItem: { item: i } });
					}
					continue;
				} else if (operation === 'recall') {
					const query = this.getNodeParameter('query', i) as string;
					const limit = this.getNodeParameter('limit', i, 5) as number;
					const tenantId = await resolveTenantId(this);
					const response = (await memorySyncRequest(this, 'POST', '/v1/memory/recall', {
						tenant_id: tenantId,
						user_id: endUserId,
						prompt: query,
						k: limit,
					})) as IDataObject;
					out = {
						context: typeof response?.context === 'string' ? response.context : '',
						memories: response?.memories ?? [],
					};
				} else if (operation === 'getAll') {
					const limit = this.getNodeParameter('limit', i, 50) as number;
					const tenantId = await resolveTenantId(this);
					const memories = await listMemories(this, tenantId, endUserId, limit);
					for (const memory of memories) {
						returnData.push({
							json: memory as unknown as IDataObject,
							pairedItem: { item: i },
						});
					}
					continue;
				} else if (operation === 'delete') {
					const idsRaw = this.getNodeParameter('memoryIds', i) as string;
					const ids = idsRaw
						.split(',')
						.map((value) => value.trim())
						.filter(Boolean)
						.map((value) => (value.startsWith('m_') ? value.slice(2) : value))
						.map((value) => Number.parseInt(value, 10))
						.filter((value) => Number.isFinite(value));
					if (ids.length === 0) {
						throw new NodeOperationError(
							this.getNode(),
							'Provide at least one memory ID, e.g. m_123',
							{ itemIndex: i },
						);
					}
					const response = (await memorySyncRequest(
						this,
						'DELETE',
						'/memory/forget',
						{ memory_ids: ids },
						userHeader,
					)) as IDataObject;
					out = { deleted: response ?? ids };
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, {
						itemIndex: i,
					});
				}

				returnData.push({ json: out, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
