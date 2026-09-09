import type { ChatHistory, Message } from '@n8n/ai-node-sdk';
import type { ISupplyDataFunctions } from 'n8n-workflow';

import { addTurn, listMemories, resolveTenantId } from '../shared/GenericFunctions';

function messageText(message: Message): string {
	return message.content
		.filter((part) => part.type === 'text' && typeof part.text === 'string')
		.map((part) => (part as { text: string }).text.trim())
		.filter(Boolean)
		.join('\n')
		.trim();
}

/**
 * Chat history persisted in MemorySync: every turn is stored verbatim
 * under the `n8n::<session>` scope for one end user, so the same session
 * resumes its transcript on the next execution — across restarts, redeploys
 * and weeks between chats.
 *
 * Implements the SDK's `ChatHistory` interface directly (type-only import),
 * so this module has no runtime dependency on `@n8n/ai-node-sdk` — see the
 * node file for why that matters.
 */
export class MemorySyncChatHistory implements ChatHistory {
	private readonly scope: string;

	constructor(
		private readonly ctx: ISupplyDataFunctions,
		private readonly endUserId: string,
		private readonly sessionId: string,
	) {
		this.scope = `n8n::${sessionId}`;
	}

	async getMessages(): Promise<Message[]> {
		try {
			const tenantId = await resolveTenantId(this.ctx);
			const items = await listMemories(this.ctx, tenantId, this.endUserId, 200);
			const messages: Message[] = [];
			// The list arrives newest first; history must be chronological.
			for (const item of items.reverse()) {
				// Production nests client metadata one level deeper
				// (metadata.metadata.session_id); older shapes were flat.
				// Accept both, exactly like the LangChain adapter.
				const outer = (item.metadata ?? {}) as {
					session_id?: string;
					metadata?: { session_id?: string };
				};
				const sessionOfItem = outer.metadata?.session_id ?? outer.session_id;
				if (sessionOfItem !== this.scope) continue;
				const raw = typeof item.raw_text === 'string' ? item.raw_text : '';
				if (raw.startsWith('human: ')) {
					messages.push({
						role: 'user',
						content: [{ type: 'text', text: raw.slice(7) }],
						id: item.memory_id,
					});
				} else if (raw.startsWith('ai: ')) {
					messages.push({
						role: 'assistant',
						content: [{ type: 'text', text: raw.slice(4) }],
						id: item.memory_id,
					});
				}
			}
			return messages;
		} catch (error) {
			// A memory outage must degrade to "no history", never break the
			// agent run.
			this.ctx.logger.warn(
				`MemorySync chat memory: history unavailable (${(error as Error).message})`,
			);
			return [];
		}
	}

	async addMessage(message: Message): Promise<void> {
		const role = message.role === 'user' ? 'human' : message.role === 'assistant' ? 'ai' : null;
		if (!role) return; // never persist system/tool noise
		const text = messageText(message);
		if (!text) return;
		try {
			const tenantId = await resolveTenantId(this.ctx);
			await addTurn(this.ctx, {
				tenantId,
				userId: this.endUserId,
				role,
				text,
				sessionScope: this.sessionId,
			});
		} catch (error) {
			// Fail-open: losing one write must not fail the workflow.
			this.ctx.logger.warn(
				`MemorySync chat memory: store skipped (${(error as Error).message})`,
			);
		}
	}

	async addMessages(messages: Message[]): Promise<void> {
		for (const message of messages) {
			await this.addMessage(message);
		}
	}

	async clear(): Promise<void> {
		// Deliberate no-op. An agent-triggered clear must never bulk-delete a
		// customer's stored conversation; deletion stays an explicit human
		// action (dashboard or the Delete operation).
		this.ctx.logger.info(
			'MemorySync chat memory: clear() ignored by design — delete memories explicitly if intended.',
		);
	}
}
