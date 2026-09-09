import type {
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { MemorySyncChatHistory } from './history';

type MemoryOptions = {
	windowSize?: number;
};

type AiNodeSdk = typeof import('@n8n/ai-node-sdk');

/**
 * `@n8n/ai-node-sdk` is a peer dependency: n8n strips peers at install time
 * and resolves the SDK from its own node_modules, and only n8n 2.16.0+
 * ships it. It is loaded here, when the sub-node is actually used, rather
 * than at module load — a static import would make the WHOLE package
 * (the workflow node and the credential included) fail to load on an older
 * instance, whereas this keeps them working and turns the one unusable
 * node into a clear "update n8n" error.
 */
async function loadAiNodeSdk(ctx: ISupplyDataFunctions, itemIndex: number): Promise<AiNodeSdk> {
	try {
		return await import('@n8n/ai-node-sdk');
	} catch (error) {
		throw new NodeOperationError(
			ctx.getNode(),
			'MemorySync Chat Memory needs n8n 2.16.0 or later (the first release that ships @n8n/ai-node-sdk). Please update your n8n instance.',
			{ itemIndex, description: (error as Error).message },
		);
	}
}

export class MemorySyncChatMemory implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'MemorySync Chat Memory',
		name: 'memorySyncChatMemory',
		icon: { light: 'file:../MemorySync/memorysync.svg', dark: 'file:../MemorySync/memorysync.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: 'Persistent agent memory',
		description:
			'Persistent AI Agent chat memory backed by MemorySync — conversation history survives across workflow executions',
		defaults: { name: 'MemorySync Chat Memory' },
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Memory'],
				Memory: ['Other memories'],
			},
			resources: {
				primaryDocumentation: [{ url: 'https://docs.memorysync.io/guides/n8n' }],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiMemory],
		outputNames: ['Memory'],
		credentials: [{ name: 'memorySyncApi', required: true }],
		properties: [
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '={{ $json.sessionId }}',
				required: true,
				placeholder: 'chat-with-customer-42',
				description:
					'Unique identifier for this conversation. Turns store under this session; the same session resumes its history on the next execution.',
			},
			{
				displayName: 'End User ID',
				name: 'endUserId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'customer-42',
				description:
					'Which end user this conversation belongs to. History is isolated per user AND per session.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Context Window Length',
						name: 'windowSize',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 100 },
						default: 10,
						description: 'Number of recent messages to hand the agent each turn',
					},
				],
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const sessionId = (this.getNodeParameter('sessionId', itemIndex) as string).trim();
		const endUserId = (this.getNodeParameter('endUserId', itemIndex) as string).trim();
		const options = this.getNodeParameter('options', itemIndex, {}) as MemoryOptions;
		if (!sessionId) {
			throw new NodeOperationError(
				this.getNode(),
				'Session ID is required — map it from your chat trigger, e.g. {{ $json.sessionId }}',
				{ itemIndex },
			);
		}
		if (!endUserId) {
			throw new NodeOperationError(this.getNode(), 'End User ID is required', { itemIndex });
		}

		const { WindowedChatMemory, supplyMemory } = await loadAiNodeSdk(this, itemIndex);
		const history = new MemorySyncChatHistory(this, endUserId, sessionId);
		const memory = new WindowedChatMemory(history, {
			windowSize: options.windowSize ?? 10,
		});
		return supplyMemory(this, memory);
	}
}
