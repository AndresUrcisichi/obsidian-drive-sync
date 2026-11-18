import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	notices: [] as string[],
	requestUrl: vi.fn(),
}));

vi.stubGlobal('window', globalThis);
vi.stubGlobal('navigator', { onLine: true });

vi.mock('obsidian', () => ({
	Notice: class {
		constructor(message: string) {
			mocks.notices.push(message);
		}
	},
	requestUrl: mocks.requestUrl,
	Platform: { isDesktopApp: false },
}));

import {
	DRIVE_SCOPE,
	finishSignIn,
	parsePastedCode,
	prepareSignIn,
	refreshAccessToken,
	startSignIn,
} from '../helpers/auth';
import { getDriveAgent } from '../helpers/requests';

interface SentRequest {
	url: string;
	body: string;
	contentType?: string;
	headers: Record<string, string>;
}
const sent = (index: number) =>
	mocks.requestUrl.mock.calls[index]?.[0] as SentRequest;
const opened = (open: ReturnType<typeof vi.fn>) =>
	String(open.mock.calls[0]?.[0]);

const response = (
	status: number,
	json: unknown = {},
	headers: Record<string, string> = {},
) => ({
	status,
	headers,
	arrayBuffer: new ArrayBuffer(0),
	json,
	text: JSON.stringify(json),
});

const createPlugin = () => {
	const secrets = new Map<string, string>([
		['gdrive-vault-sync-refresh-token', 'saved-refresh'],
		['gdrive-vault-sync-client-secret', 'client-secret'],
	]);
	const local = new Map<string, string | null>();
	return {
		accessToken: { token: '', expiresAt: 0 },
		settings: {
			clientId: 'client-id',
			redirectUri: 'https://example.github.io/callback.html',
		},
		app: {
			vault: { getName: () => 'My vault' },
			secretStorage: {
				getSecret: (id: string) => secrets.get(id) ?? null,
				setSecret: (id: string, value: string) => secrets.set(id, value),
			},
			loadLocalStorage: (key: string) => local.get(key) ?? null,
			saveLocalStorage: (key: string, value: string | null) =>
				local.set(key, value),
		},
		secrets,
		local,
	};
};

beforeEach(() => {
	mocks.notices.length = 0;
	mocks.requestUrl.mockReset();
});

describe('refreshAccessToken', () => {
	it('talks only to Google with the device-held refresh token', async () => {
		mocks.requestUrl.mockResolvedValue(
			response(200, { access_token: 'access', expires_in: 3600 }),
		);
		const plugin = createPlugin();

		await refreshAccessToken(plugin as never);

		const request = sent(0);
		expect(request.url).toBe('https://oauth2.googleapis.com/token');
		const body = new URLSearchParams(request.body);
		expect(body.get('refresh_token')).toBe('saved-refresh');
		expect(body.get('client_secret')).toBe('client-secret');
		expect(plugin.accessToken.token).toBe('access');
	});

	it('shares one request between concurrent callers', async () => {
		mocks.requestUrl.mockResolvedValue(
			response(200, { access_token: 'access', expires_in: 3600 }),
		);
		const plugin = createPlugin();

		await Promise.all([
			refreshAccessToken(plugin as never),
			refreshAccessToken(plugin as never),
			refreshAccessToken(plugin as never),
		]);

		expect(mocks.requestUrl).toHaveBeenCalledOnce();
	});

	it('forgets a revoked refresh token', async () => {
		mocks.requestUrl.mockResolvedValue(
			response(400, { error: 'invalid_grant' }),
		);
		const plugin = createPlugin();

		await expect(refreshAccessToken(plugin as never)).resolves.toBeUndefined();

		expect(plugin.secrets.get('gdrive-vault-sync-refresh-token')).toBe('');
	});

	it.each([429, 500, 503])(
		'keeps the refresh token after transient HTTP %s',
		async (status) => {
			mocks.requestUrl.mockResolvedValue(response(status));
			const plugin = createPlugin();

			await refreshAccessToken(plugin as never);

			expect(plugin.secrets.get('gdrive-vault-sync-refresh-token')).toBe(
				'saved-refresh',
			);
		},
	);
});

describe('sign-in', () => {
	it('builds a PKCE request for the drive.file scope only', async () => {
		const open = vi.fn();
		vi.stubGlobal('window', { ...globalThis, open });
		const plugin = createPlugin();

		await prepareSignIn(plugin as never);
		startSignIn(plugin as never);

		const url = new URL(opened(open));
		expect(url.searchParams.get('scope')).toBe(DRIVE_SCOPE);
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
		expect(url.searchParams.get('client_id')).toBe('client-id');
		const state = url.searchParams.get('state') as string;
		const vault = atob(
			(state.split('.')[1] as string).replace(/-/g, '+').replace(/_/g, '/'),
		);
		expect(vault).toBe('My vault');
		vi.stubGlobal('window', globalThis);
	});

	it('rejects a callback whose state does not match', async () => {
		const plugin = createPlugin();
		vi.stubGlobal('window', { ...globalThis, open: vi.fn() });
		await prepareSignIn(plugin as never);
		startSignIn(plugin as never);
		vi.stubGlobal('window', globalThis);

		await expect(
			finishSignIn(plugin as never, 'code', 'forged.state'),
		).resolves.toBe(false);
		expect(mocks.requestUrl).not.toHaveBeenCalled();
	});

	it('stores the refresh token in secret storage, never in settings', async () => {
		const open = vi.fn();
		vi.stubGlobal('window', { ...globalThis, open });
		const plugin = createPlugin();
		await prepareSignIn(plugin as never);
		startSignIn(plugin as never);
		vi.stubGlobal('window', globalThis);
		const state = new URL(opened(open)).searchParams.get(
			'state',
		) as string;
		mocks.requestUrl.mockResolvedValue(
			response(200, {
				refresh_token: 'new-refresh',
				access_token: 'access',
				expires_in: 3600,
				scope: DRIVE_SCOPE,
			}),
		);

		await expect(
			finishSignIn(plugin as never, 'the-code', state),
		).resolves.toBe(true);

		const body = new URLSearchParams(sent(0).body);
		expect(body.get('code_verifier')).toMatch(/^[\w-]{86}$/);
		expect(plugin.secrets.get('gdrive-vault-sync-refresh-token')).toBe(
			'new-refresh',
		);
		expect(JSON.stringify(plugin.settings)).not.toContain('new-refresh');
		// A code can only be redeemed once.
		await expect(
			finishSignIn(plugin as never, 'the-code', state),
		).resolves.toBe(false);
	});

	it('opens the browser synchronously once the link is prepared', async () => {
		const open = vi.fn();
		const plugin = createPlugin();
		await prepareSignIn(plugin as never);
		vi.stubGlobal('window', { ...globalThis, open });

		// No await: iOS only honors opens inside the tap handler itself.
		startSignIn(plugin as never);

		expect(open).toHaveBeenCalledOnce();
		vi.stubGlobal('window', globalThis);
	});

	it('reuses a pending sign-in when the settings re-render', async () => {
		const plugin = createPlugin();
		const first = await prepareSignIn(plugin as never);
		const second = await prepareSignIn(plugin as never);

		expect(second).toBe(first);
	});

	it('parses the code pasted from the callback page', () => {
		expect(parsePastedCode(' abc.def|4/0Ab-x ')).toEqual({
			state: 'abc.def',
			code: '4/0Ab-x',
		});
		expect(parsePastedCode('nonsense')).toBeUndefined();
	});
});

describe('getDriveAgent', () => {
	const signedIn = () => {
		const plugin = createPlugin();
		plugin.accessToken = { token: 'access', expiresAt: Date.now() + 3_600_000 };
		return plugin;
	};

	it('adds authorization and serializes JSON requests', async () => {
		mocks.requestUrl.mockResolvedValue(response(200, { id: 'x' }));
		const agent = getDriveAgent(signedIn() as never);

		await expect(
			agent.post('drive/v3/files', { json: { name: 'a' } }).json(),
		).resolves.toEqual({ id: 'x' });

		const request = sent(0);
		expect(request.headers.Authorization).toBe('Bearer access');
		expect(request.contentType).toBe('application/json');
	});

	it('retries rate limits with backoff, honoring Retry-After', async () => {
		vi.useFakeTimers();
		mocks.requestUrl
			.mockResolvedValueOnce(response(429, {}, { 'retry-after': '1' }))
			.mockResolvedValueOnce(
				response(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }),
			)
			.mockResolvedValueOnce(response(200, { ok: true }));
		const agent = getDriveAgent(signedIn() as never);

		const result = agent.get('drive/v3/files').json();
		await vi.runAllTimersAsync();

		await expect(result).resolves.toEqual({ ok: true });
		expect(mocks.requestUrl).toHaveBeenCalledTimes(3);
		vi.useRealTimers();
	});

	it('refreshes the access token once on 401', async () => {
		mocks.requestUrl
			.mockResolvedValueOnce(response(401))
			.mockResolvedValueOnce(
				response(200, { access_token: 'fresh', expires_in: 3600 }),
			)
			.mockResolvedValueOnce(response(200, { ok: true }));
		const agent = getDriveAgent(signedIn() as never);

		await expect(agent.get('drive/v3/files').json()).resolves.toEqual({
			ok: true,
		});
		expect(sent(2).headers.Authorization).toBe(
			'Bearer fresh',
		);
	});

	it('fails fast on permanent errors without leaking the body', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		mocks.requestUrl.mockResolvedValue(
			response(404, { error: { message: 'File secret-name.md not found' } }),
		);
		const agent = getDriveAgent(signedIn() as never);

		await expect(agent.get('drive/v3/files/x').json()).rejects.toThrow(
			'HTTP 404',
		);
		expect(mocks.requestUrl).toHaveBeenCalledOnce();
		expect(mocks.notices.join(' ')).not.toContain('secret-name');
	});
});
