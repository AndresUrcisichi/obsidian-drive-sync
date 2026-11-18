import type ObsidianGoogleDrive from '../main';
import { requestUrl, RequestUrlResponse } from 'obsidian';
import { refreshAccessToken } from './auth';

interface RequestOptions {
	body?: BodyInit;
	headers?: Record<string, string>;
	json?: unknown;
}

interface DriveResponse {
	readonly ok: boolean;
	readonly status: number;
	arrayBuffer(): Promise<ArrayBuffer>;
	json<T>(): Promise<T>;
	text(): Promise<string>;
}

export class DriveRequestError extends Error {
	constructor(
		readonly status: number,
		readonly reason: string,
	) {
		super(`Google Drive request failed (HTTP ${status}${reason ? `: ${reason}` : ''})`);
	}
}

const MAX_ATTEMPTS = 6;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_REASONS = new Set([
	'rateLimitExceeded',
	'userRateLimitExceeded',
	'backendError',
]);

export const sleep = (ms: number) =>
	new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** Exponential backoff with full jitter: 0.5s, 1s, 2s, 4s, 8s (capped 16s). */
export const backoffDelay = (attempt: number, retryAfter?: string) => {
	const seconds = Number(retryAfter);
	if (retryAfter && Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(seconds * 1000, 30_000);
	}
	const cap = Math.min(16_000, 500 * 2 ** attempt);
	return cap / 2 + Math.random() * (cap / 2);
};

const errorReason = (response: RequestUrlResponse) => {
	try {
		const body = response.json as {
			error?: { errors?: { reason?: string }[]; status?: string };
		};
		return (
			body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? ''
		);
	} catch {
		return '';
	}
};

const serializeBody = async (
	options: RequestOptions,
): Promise<{ body?: string | ArrayBuffer; contentType?: string }> => {
	if (options.json !== undefined) {
		return {
			body: JSON.stringify(options.json),
			contentType: 'application/json',
		};
	}

	if (options.body === undefined || options.body === null) return {};
	if (typeof options.body === 'string') return { body: options.body };
	if (options.body instanceof ArrayBuffer) return { body: options.body };
	if (ArrayBuffer.isView(options.body)) {
		return {
			body: options.body.buffer.slice(
				options.body.byteOffset,
				options.body.byteOffset + options.body.byteLength,
			),
		};
	}

	const encoded = new Request('https://localhost', {
		method: 'POST',
		body: options.body,
	});
	return {
		body: await encoded.arrayBuffer(),
		contentType: encoded.headers.get('Content-Type') ?? undefined,
	};
};

const toDriveResponse = (response: RequestUrlResponse): DriveResponse => ({
	ok: response.status >= 200 && response.status < 300,
	status: response.status,
	arrayBuffer: async () => response.arrayBuffer,
	json: async <T>() => response.json as T,
	text: async () => response.text,
});

export const getDriveAgent = (t: ObsidianGoogleDrive) => {
	const ensureToken = async (force = false) => {
		if (
			force ||
			!t.accessToken.token ||
			t.accessToken.expiresAt - Date.now() < 60_000
		) {
			if (!(await refreshAccessToken(t))) {
				throw new DriveRequestError(401, 'not signed in');
			}
		}
	};

	const send = (
		method: string,
		path: string,
		options: RequestOptions = {},
	) => {
		const response = (async () => {
			// Serialize once; retries reuse the same bytes.
			const { body, contentType } = await serializeBody(options);
			const url = new URL(path, 'https://www.googleapis.com/').toString();
			let refreshedAfter401 = false;

			for (let attempt = 0; ; attempt++) {
				await ensureToken();

				let result: RequestUrlResponse;
				try {
					result = await requestUrl({
						url,
						method,
						headers: {
							...options.headers,
							Authorization: `Bearer ${t.accessToken.token}`,
						},
						body,
						contentType,
						throw: false,
					});
				} catch (error) {
					// Network failure: retry unless we are clearly offline.
					if (attempt + 1 >= MAX_ATTEMPTS || !navigator.onLine) {
						throw error;
					}
					await sleep(backoffDelay(attempt));
					continue;
				}

				if (result.status >= 200 && result.status < 300) {
					return toDriveResponse(result);
				}

				if (result.status === 401 && !refreshedAfter401) {
					refreshedAfter401 = true;
					await ensureToken(true);
					continue;
				}

				const reason = errorReason(result);
				const retryable =
					RETRYABLE_STATUS.has(result.status) ||
					(result.status === 403 && RETRYABLE_REASONS.has(reason));

				if (retryable && attempt + 1 < MAX_ATTEMPTS) {
					await sleep(
						backoffDelay(attempt, result.headers?.['retry-after']),
					);
					continue;
				}

				// Never surface response bodies in notices: they can echo
				// file names, IDs, or tokens. Details stay in the console.
				console.error(`Drive ${method} ${path.split('?')[0]} failed`, {
					status: result.status,
					reason,
				});
				throw new DriveRequestError(result.status, reason);
			}
		})();

		return {
			arrayBuffer: () => response.then((result) => result.arrayBuffer()),
			json: <T>() => response.then((result) => result.json<T>()),
			text: () => response.then((result) => result.text()),
			then: response.then.bind(response),
		};
	};

	return {
		get: (path: string, options?: RequestOptions) =>
			send('GET', path, options),
		post: (path: string, options?: RequestOptions) =>
			send('POST', path, options),
		patch: (path: string, options?: RequestOptions) =>
			send('PATCH', path, options),
		delete: (path: string, options?: RequestOptions) =>
			send('DELETE', path, options),
	};
};
