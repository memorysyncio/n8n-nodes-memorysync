import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

const DEFAULT_BASE_URL = 'https://api.memorysync.io';

export class MemorySyncApi implements ICredentialType {
	name = 'memorySyncApi';

	displayName = 'MemorySync API';

	icon: Icon = { light: 'file:memorysync.svg', dark: 'file:memorysync.dark.svg' };

	documentationUrl = 'https://docs.memorysync.io/guides/n8n';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Your MemorySync API key from app.memorysync.io → Settings → API Keys',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: DEFAULT_BASE_URL,
			description: 'Override only for self-hosted or regional deployments',
		},
	];

	/**
	 * Applied by n8n to every request the nodes send through
	 * `httpRequestWithAuthentication`: the base URL and the API key both
	 * come from the stored credential, so node code never reads them.
	 */
	async authenticate(
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> {
		const baseUrl = String(credentials.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
		return {
			...requestOptions,
			baseURL: baseUrl,
			headers: {
				...(requestOptions.headers ?? {}),
				'X-API-Key': String(credentials.apiKey ?? ''),
			},
		};
	}

	// A real, metered-but-tiny call that works for every key class
	// (production, project-scoped, and evaluation keys alike).
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl || "https://api.memorysync.io"}}',
			url: '/memory/query',
			method: 'POST',
			headers: { 'X-End-User-ID': 'n8n-connection-test' },
			body: { query: 'connection test', k: 1 },
		},
	};
}
