import type ObsidianGoogleDrive from '../main';
import { Notice, Platform, requestUrl } from 'obsidian';

// Only files this OAuth client creates are visible to the plugin. Google
// classifies this scope as non-sensitive, so a personal Cloud project can be
// published to production without verification (no 7-day token expiry).
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const PROTOCOL_ACTION = 'gdrive-vault-sync-auth';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const REFRESH_SECRET_ID = 'gdrive-vault-sync-refresh-token';
const CLIENT_SECRET_ID = 'gdrive-vault-sync-client-secret';
const PENDING_KEY = 'gdrive-vault-sync-pending-auth';
const PENDING_TTL_MS = 15 * 60_000;

declare const __GDVS_CLIENT_ID__: string;
declare const __GDVS_CLIENT_SECRET__: string;
declare const __GDVS_REDIRECT_URI__: string;

const buildDefault = (value: () => string) => {
	try {
		return value();
	} catch {
		return '';
	}
};

export const BUILD_DEFAULTS = {
	clientId: buildDefault(() => __GDVS_CLIENT_ID__),
	clientSecret: buildDefault(() => __GDVS_CLIENT_SECRET__),
	redirectUri: buildDefault(() => __GDVS_REDIRECT_URI__),
};

const base64Url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');

const randomString = (byteLength: number) =>
	base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));

const sha256 = async (value: string) =>
	new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
	);

interface PendingAuth {
	verifier: string;
	nonce: string;
	createdAt: number;
}

export const getClientId = (t: ObsidianGoogleDrive) =>
	t.settings.clientId || BUILD_DEFAULTS.clientId;

export const getRedirectUri = (t: ObsidianGoogleDrive) =>
	t.settings.redirectUri || BUILD_DEFAULTS.redirectUri;

export const getClientSecret = (t: ObsidianGoogleDrive) =>
	t.app.secretStorage.getSecret(CLIENT_SECRET_ID) ||
	BUILD_DEFAULTS.clientSecret;

export const setClientSecret = (t: ObsidianGoogleDrive, secret: string) =>
	t.app.secretStorage.setSecret(CLIENT_SECRET_ID, secret.trim());

export const getRefreshToken = (t: ObsidianGoogleDrive) =>
	t.app.secretStorage.getSecret(REFRESH_SECRET_ID) || '';

export const setRefreshToken = (t: ObsidianGoogleDrive, token: string) =>
	t.app.secretStorage.setSecret(REFRESH_SECRET_ID, token);

export const isSignedIn = (t: ObsidianGoogleDrive) =>
	Boolean(getRefreshToken(t));

export const missingClientConfig = (t: ObsidianGoogleDrive) => {
	const missing: string[] = [];
	if (!getClientId(t)) missing.push('client ID');
	if (!getClientSecret(t)) missing.push('client secret');
	if (!getRedirectUri(t)) missing.push('redirect URI');
	return missing;
};

/**
 * Starts the OAuth authorization-code flow with PKCE. Google sends the code to
 * the static callback page, which forwards it to Obsidian through the
 * `obsidian://gdrive-vault-sync-auth` URI (or shows it for manual pasting).
 */
export const startSignIn = async (t: ObsidianGoogleDrive) => {
	const missing = missingClientConfig(t);
	if (missing.length) {
		new Notice(`Set the ${missing.join(', ')} in the plugin settings first.`);
		return;
	}

	const pending: PendingAuth = {
		verifier: randomString(64),
		nonce: randomString(24),
		createdAt: Date.now(),
	};
	t.app.saveLocalStorage(PENDING_KEY, JSON.stringify(pending));

	// The callback page reads the vault name from the state so Obsidian routes
	// the redirect to this vault when several are open.
	const state = `${pending.nonce}.${base64Url(
		new TextEncoder().encode(t.app.vault.getName()),
	)}`;

	const url = new URL(AUTH_URL);
	url.search = new URLSearchParams({
		client_id: getClientId(t),
		redirect_uri: getRedirectUri(t),
		response_type: 'code',
		scope: DRIVE_SCOPE,
		access_type: 'offline',
		prompt: 'consent',
		include_granted_scopes: 'false',
		code_challenge: base64Url(await sha256(pending.verifier)),
		code_challenge_method: 'S256',
		state,
	}).toString();

	openInSystemBrowser(url.toString());
};

/**
 * On desktop, window.open can land in Obsidian's built-in web viewer, where
 * the obsidian:// redirect back never fires. Use the system browser instead.
 */
const openInSystemBrowser = (url: string) => {
	if (Platform.isDesktopApp) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- electron is only reachable through require at runtime, and only on desktop
			const { shell } = require('electron') as {
				shell: { openExternal: (url: string) => Promise<void> };
			};
			void shell.openExternal(url);
			return;
		} catch {
			// Fall through to window.open.
		}
	}
	window.open(url);
};

const takePending = (t: ObsidianGoogleDrive): PendingAuth | undefined => {
	const raw = t.app.loadLocalStorage(PENDING_KEY) as string | null;
	t.app.saveLocalStorage(PENDING_KEY, null);
	if (!raw) return;
	try {
		const pending = JSON.parse(raw) as PendingAuth;
		if (Date.now() - pending.createdAt > PENDING_TTL_MS) return;
		return pending;
	} catch {
		return;
	}
};

/**
 * Accepts either the protocol handler parameters or a pasted
 * `<state>|<code>` string from the callback page.
 */
export const finishSignIn = async (
	t: ObsidianGoogleDrive,
	code: string,
	state: string,
) => {
	const pending = takePending(t);
	const nonce = state.split('.')[0];
	if (!pending || !nonce || nonce !== pending.nonce) {
		new Notice(
			'Sign-in expired or started on another device. Start it again from the plugin settings.',
		);
		return false;
	}

	try {
		const response = await requestUrl({
			url: TOKEN_URL,
			method: 'POST',
			contentType: 'application/x-www-form-urlencoded',
			body: new URLSearchParams({
				client_id: getClientId(t),
				client_secret: getClientSecret(t),
				code,
				code_verifier: pending.verifier,
				grant_type: 'authorization_code',
				redirect_uri: getRedirectUri(t),
			}).toString(),
			throw: false,
		});

		const body = response.json as {
			refresh_token?: string;
			access_token?: string;
			expires_in?: number;
			scope?: string;
			error?: string;
		};

		if (response.status !== 200 || !body.refresh_token) {
			console.error('Token exchange failed', response.status, body.error);
			new Notice(
				`Google rejected the sign-in (${body.error ?? response.status}).`,
			);
			return false;
		}

		if (body.scope && !body.scope.split(' ').includes(DRIVE_SCOPE)) {
			new Notice('Google Drive access was not granted.');
			return false;
		}

		setRefreshToken(t, body.refresh_token);
		if (body.access_token && body.expires_in) {
			t.accessToken = {
				token: body.access_token,
				expiresAt: Date.now() + body.expires_in * 1000,
			};
		}
		return true;
	} catch (error) {
		console.error('Token exchange failed', error);
		new Notice('Could not reach Google to finish signing in.');
		return false;
	}
};

export const parsePastedCode = (value: string) => {
	const [state, code] = value.trim().split('|');
	if (!state || !code) return;
	return { state, code };
};

type AccessToken = { token: string; expiresAt: number };
let inFlightRefresh: Promise<AccessToken | undefined> | undefined;

/**
 * Exchanges the stored refresh token for an access token directly with
 * Google. Concurrent callers share one request.
 */
export const refreshAccessToken = (t: ObsidianGoogleDrive) => {
	inFlightRefresh ??= doRefresh(t).finally(() => {
		inFlightRefresh = undefined;
	});
	return inFlightRefresh;
};

const doRefresh = async (
	t: ObsidianGoogleDrive,
): Promise<AccessToken | undefined> => {
	const refreshToken = getRefreshToken(t);
	if (!refreshToken) {
		new Notice('Sign in to Google Drive in the plugin settings first.');
		return;
	}

	try {
		const response = await requestUrl({
			url: TOKEN_URL,
			method: 'POST',
			contentType: 'application/x-www-form-urlencoded',
			body: new URLSearchParams({
				client_id: getClientId(t),
				client_secret: getClientSecret(t),
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
			}).toString(),
			throw: false,
		});

		if (response.status === 400 || response.status === 401) {
			const error = (response.json as { error?: string } | undefined)
				?.error;
			console.error(`Refresh token rejected (HTTP ${response.status})`, error);
			if (error === 'invalid_grant') setRefreshToken(t, '');
			new Notice(
				'Google Drive access was revoked or expired. Sign in again in the plugin settings.',
				0,
			);
			return;
		}

		if (response.status < 200 || response.status >= 300) {
			new Notice(
				`Could not refresh Google Drive access (HTTP ${response.status}). Try again later.`,
			);
			return;
		}

		const { expires_in, access_token } = response.json as {
			expires_in: number;
			access_token: string;
		};

		t.accessToken = {
			token: access_token,
			expiresAt: Date.now() + expires_in * 1000,
		};
		return t.accessToken;
	} catch {
		new Notice(
			'Could not refresh Google Drive access. Check your connection and try again.',
		);
	}
	return;
};

export const signOut = async (t: ObsidianGoogleDrive) => {
	const token = getRefreshToken(t);
	setRefreshToken(t, '');
	t.accessToken = { token: '', expiresAt: 0 };
	if (!token) return;
	try {
		await requestUrl({
			url: 'https://oauth2.googleapis.com/revoke',
			method: 'POST',
			contentType: 'application/x-www-form-urlencoded',
			body: new URLSearchParams({ token }).toString(),
			throw: false,
		});
	} catch {
		// Local sign-out already happened; revocation is best effort.
	}
};
