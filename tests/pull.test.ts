import { beforeEach, describe, expect, it, vi } from 'vitest';

const notices = vi.hoisted(() => [] as string[]);

vi.mock('obsidian', () => {
	class TFile {
		path: string;
		constructor(path: string) {
			this.path = path;
		}
	}
	class TFolder {
		path: string;
		children: { path: string }[] = [];
		constructor(path: string) {
			this.path = path;
		}
	}
	return {
		Notice: class {
			constructor(message: string) {
				notices.push(message);
			}
		},
		requestUrl: vi.fn(),
		TAbstractFile: class {},
		TFile,
		TFolder,
	};
});

import { conflictPath, pull } from '../helpers/pull';
import { md5 } from '../helpers/md5';
import { TFile, TFolder } from 'obsidian';

const makeFile = (path: string) => Object.assign(new TFile(), { path });

const bytes = (text: string) => new TextEncoder().encode(text).buffer;

const remote = (
	id: string,
	path: string,
	content?: string,
	extra: Record<string, string> = {},
) => ({
	id,
	mimeType:
		content === undefined
			? 'application/vnd.google-apps.folder'
			: 'text/markdown',
	md5Checksum: content === undefined ? undefined : md5(content),
	modifiedTime: '2026-11-01T00:00:00.000Z',
	properties: { path, vault: 'Vault', ...extra },
});

const createPlugin = (local: Record<string, string> = {}) => {
	const files = new Map<string, TFile | TFolder>(
		Object.keys(local).map((path) => [path, makeFile(path)]),
	);
	const contents = new Map(Object.entries(local));
	const remoteContents = new Map<string, string>();

	const adapter = {
		exists: vi.fn(async (path: string) => files.has(path)),
		stat: vi.fn(
			async (
				_path: string,
			): Promise<{ type: 'file' | 'folder' } | undefined> =>
				undefined,
		),
		remove: vi.fn(async () => undefined),
		list: vi.fn(async () => ({ files: [], folders: [] })),
		rmdir: vi.fn(async () => undefined),
		readBinary: vi.fn(async (path: string) =>
			bytes(contents.get(path) ?? ''),
		),
	};
	const vault = {
		adapter,
		configDir: 'config',
		getName: () => 'Vault',
		getAllLoadedFiles: vi.fn(() => [...files.values()]),
		getAbstractFileByPath: vi.fn((path: string) => files.get(path) ?? null),
		getFileByPath: vi.fn((path: string) => {
			const file = files.get(path);
			return file instanceof TFile ? file : null;
		}),
		getFolderByPath: vi.fn(() => null),
		readBinary: vi.fn(async (file: TFile) =>
			bytes(contents.get(file.path) ?? ''),
		),
		createBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
			files.set(path, makeFile(path));
			contents.set(path, new TextDecoder().decode(data));
		}),
	};
	const plugin = {
		app: { vault },
		manifest: { id: 'gdrive-vault-sync' },
		lastPullAt: 0,
		settings: {
			lastSyncedAt: 0,
			changesToken: 'changes',
			syncConfig: true,
			driveIdToPath: {} as Record<string, string>,
			driveIdToMd5: {} as Record<string, string>,
			operations: {} as Record<string, 'create' | 'delete' | 'modify'>,
		},
		drive: {
			searchFiles: vi.fn(
				async (): Promise<unknown[] | undefined> => [],
			),
			getChangesStartToken: vi.fn(async () => 'start-token'),
			getChanges: vi.fn(
				async (): Promise<
					| { changes: unknown[]; newStartPageToken: string }
					| undefined
				> => ({ changes: [], newStartPageToken: 'next-token' }),
			),
			deleteFilesMinimumOperations: vi.fn(async () => undefined),
			getFile: vi.fn((id: string) => ({
				arrayBuffer: async () => bytes(remoteContents.get(id) ?? ''),
			})),
		},
		abortSync: vi.fn(),
		endSync: vi.fn(async () => true),
		createFolder: vi.fn(async () => undefined),
		modifyFile: vi.fn(async () => undefined),
		upsertFile: vi.fn(async () => undefined),
	};
	return { plugin, files, contents, remoteContents };
};

describe('pull (incremental)', () => {
	beforeEach(() => {
		notices.length = 0;
	});

	it('advances the checkpoint to the token returned by the feed', async () => {
		const { plugin } = createPlugin();
		plugin.settings.driveIdToPath = { 'a-id': 'a.md' };

		await expect(pull(plugin as never, true)).resolves.toBe(true);

		expect(plugin.settings.changesToken).toBe('next-token');
		expect(plugin.drive.searchFiles).not.toHaveBeenCalled();
		expect(plugin.endSync).not.toHaveBeenCalled();
	});

	it('aborts and keeps the checkpoint when the feed fails', async () => {
		const { plugin } = createPlugin();
		plugin.settings.driveIdToPath = { 'a-id': 'a.md' };
		plugin.drive.getChanges.mockResolvedValueOnce(undefined);

		await expect(pull(plugin as never, true)).resolves.toBe(false);

		expect(plugin.settings.changesToken).toBe('changes');
		expect(plugin.abortSync).toHaveBeenCalledOnce();
	});

	it('skips downloads whose MD5 matches what this device already has', async () => {
		const { plugin } = createPlugin({ 'a.md': 'same' });
		plugin.settings.driveIdToPath = { 'a-id': 'a.md' };
		plugin.settings.driveIdToMd5 = { 'a-id': md5('same') };
		plugin.drive.getChanges.mockResolvedValueOnce({
			changes: [
				{ fileId: 'a-id', removed: false, file: remote('a-id', 'a.md', 'same') },
			],
			newStartPageToken: 'next-token',
		});

		await pull(plugin as never, true);

		expect(plugin.drive.getFile).not.toHaveBeenCalled();
		expect(plugin.modifyFile).not.toHaveBeenCalled();
	});

	it('downloads remote edits and records their MD5', async () => {
		const { plugin, files, remoteContents } = createPlugin({ 'a.md': 'old' });
		plugin.settings.driveIdToPath = { 'a-id': 'a.md' };
		plugin.settings.driveIdToMd5 = { 'a-id': md5('old') };
		remoteContents.set('a-id', 'new');
		plugin.drive.getChanges.mockResolvedValueOnce({
			changes: [
				{ fileId: 'a-id', removed: false, file: remote('a-id', 'a.md', 'new') },
			],
			newStartPageToken: 'next-token',
		});

		await pull(plugin as never, true);

		expect(plugin.modifyFile).toHaveBeenCalledWith(
			files.get('a.md'),
			expect.any(ArrayBuffer),
			'2026-11-01T00:00:00.000Z',
		);
		expect(plugin.settings.driveIdToMd5['a-id']).toBe(md5('new'));
	});

	it('keeps both versions when a note changed locally and on Drive', async () => {
		const { plugin, contents, remoteContents } = createPlugin({
			'notes/a.md': 'mine',
		});
		plugin.settings.driveIdToPath = { 'a-id': 'notes/a.md' };
		plugin.settings.driveIdToMd5 = { 'a-id': md5('base') };
		plugin.settings.operations = { 'notes/a.md': 'modify' };
		remoteContents.set('a-id', 'theirs');
		plugin.drive.getChanges.mockResolvedValueOnce({
			changes: [
				{
					fileId: 'a-id',
					removed: false,
					file: remote('a-id', 'notes/a.md', 'theirs'),
				},
			],
			newStartPageToken: 'next-token',
		});

		await pull(plugin as never, true);

		const copy = [...contents.keys()].find((p) => p.includes('(conflict'));
		expect(copy).toMatch(/^notes\/a \(conflict \d{4}-\d{2}-\d{2} \d{4}\)\.md$/);
		expect(contents.get(copy as string)).toBe('theirs');
		expect(contents.get('notes/a.md')).toBe('mine');
		expect(plugin.modifyFile).not.toHaveBeenCalled();
		expect(plugin.settings.operations['notes/a.md']).toBe('modify');
		expect(notices.some((n) => n.includes('conflict'))).toBe(true);
	});

	it('takes the remote version when a pending op is stale', async () => {
		const { plugin, files, remoteContents } = createPlugin({ 'a.md': 'base' });
		plugin.settings.driveIdToPath = { 'a-id': 'a.md' };
		plugin.settings.driveIdToMd5 = { 'a-id': md5('base') };
		// For example a save that did not change the bytes.
		plugin.settings.operations = { 'a.md': 'modify' };
		remoteContents.set('a-id', 'theirs');
		plugin.drive.getChanges.mockResolvedValueOnce({
			changes: [
				{ fileId: 'a-id', removed: false, file: remote('a-id', 'a.md', 'theirs') },
			],
			newStartPageToken: 'next-token',
		});

		await pull(plugin as never, true);

		expect(plugin.modifyFile).toHaveBeenCalledWith(
			files.get('a.md'),
			expect.any(ArrayBuffer),
			'2026-11-01T00:00:00.000Z',
		);
		expect(plugin.settings.operations).toEqual({});
		expect(notices.some((n) => n.includes('conflict'))).toBe(false);
	});

	it('revives a locally deleted folder when Drive has a newer file inside', async () => {
		const { plugin, remoteContents } = createPlugin();
		plugin.settings.driveIdToPath = { 'f-id': 'F', 'a-id': 'F/a.md' };
		plugin.settings.driveIdToMd5 = { 'a-id': md5('old') };
		plugin.settings.operations = { F: 'delete', 'F/a.md': 'delete' };
		remoteContents.set('a-id', 'edited elsewhere');
		plugin.drive.getChanges.mockResolvedValueOnce({
			changes: [
				{
					fileId: 'a-id',
					removed: false,
					file: remote('a-id', 'F/a.md', 'edited elsewhere'),
				},
			],
			newStartPageToken: 'next-token',
		});

		await pull(plugin as never, true);

		expect(plugin.settings.operations).toEqual({});
		expect(plugin.createFolder).toHaveBeenCalledWith('F');
		expect(plugin.upsertFile).toHaveBeenCalledWith(
			'F/a.md',
			expect.any(ArrayBuffer),
			'2026-11-01T00:00:00.000Z',
		);
	});

	it('does not mark hidden files that are still on disk as deleted', async () => {
		const { plugin } = createPlugin();
		plugin.settings.driveIdToPath = { 'c-id': '.obsidian/app.json' };
		plugin.app.vault.adapter.exists.mockImplementation(
			async (path: string) => path === '.obsidian/app.json',
		);

		await pull(plugin as never, true);

		expect(plugin.settings.operations).toEqual({});
	});

	it('leaves config files alone when settings sync is off', async () => {
		const { plugin } = createPlugin();
		plugin.settings.syncConfig = false;
		plugin.settings.driveIdToPath = { 'x-id': 'x.md' };
		plugin.drive.getChanges.mockResolvedValueOnce({
			changes: [
				{
					fileId: 'c-id',
					removed: false,
					file: remote('c-id', 'config/app.json', '{}', { config: 'true' }),
				},
			],
			newStartPageToken: 'next-token',
		});

		await pull(plugin as never, true);

		expect(plugin.drive.getFile).not.toHaveBeenCalled();
		expect(plugin.upsertFile).not.toHaveBeenCalled();
	});

	it('trashes remotely deleted files but keeps ones with local edits', async () => {
		const { plugin, files } = createPlugin({
			'gone.md': 'x',
			'edited.md': 'y',
		});
		plugin.settings.driveIdToPath = {
			'gone-id': 'gone.md',
			'edited-id': 'edited.md',
		};
		plugin.settings.operations = { 'edited.md': 'modify' };
		plugin.drive.getChanges.mockResolvedValueOnce({
			changes: [
				{ fileId: 'gone-id', removed: true },
				{ fileId: 'edited-id', removed: true },
			],
			newStartPageToken: 'next-token',
		});

		await pull(plugin as never, true);

		expect(plugin.drive.deleteFilesMinimumOperations).toHaveBeenCalledWith([
			files.get('gone.md'),
		]);
		expect(plugin.settings.operations['edited.md']).toBe('create');
		expect(plugin.settings.driveIdToPath).toEqual({});
	});

	it('ignores files from other vaults and never writes its own data.json', async () => {
		const { plugin } = createPlugin();
		plugin.settings.driveIdToPath = { 'x-id': 'x.md' };
		plugin.drive.getChanges.mockResolvedValueOnce({
			changes: [
				{
					fileId: 'other-id',
					removed: false,
					file: { ...remote('other-id', 'b.md', 'b'), properties: { path: 'b.md', vault: 'Other' } },
				},
				{
					fileId: 'own-id',
					removed: false,
					file: remote(
						'own-id',
						'config/plugins/gdrive-vault-sync/data.json',
						'{"secret":1}',
						{ config: 'true' },
					),
				},
			],
			newStartPageToken: 'next-token',
		});

		await pull(plugin as never, true);

		expect(plugin.drive.getFile).not.toHaveBeenCalled();
		expect(plugin.upsertFile).not.toHaveBeenCalled();
	});

	it('reconciles creates and deletes made while Obsidian was closed', async () => {
		const { plugin } = createPlugin({ 'new.md': 'n', 'stable.md': 's' });
		plugin.settings.driveIdToPath = {
			'old-id': 'old.md',
			'stable-id': 'stable.md',
		};

		await pull(plugin as never, true);

		expect(plugin.settings.operations).toEqual({
			'old.md': 'delete',
			'new.md': 'create',
		});
	});
});

describe('pull (first run on a device)', () => {
	it('adopts an existing local copy by MD5 without downloading it', async () => {
		const { plugin } = createPlugin({ 'a.md': 'same', 'local-only.md': 'l' });
		plugin.settings.changesToken = '';
		plugin.drive.searchFiles.mockResolvedValueOnce([
			remote('folder-id', 'folder'),
			remote('a-id', 'a.md', 'same'),
		]);

		await pull(plugin as never, true);

		expect(plugin.drive.getFile).not.toHaveBeenCalled();
		expect(plugin.settings.driveIdToPath).toEqual({
			'folder-id': 'folder',
			'a-id': 'a.md',
		});
		expect(plugin.settings.driveIdToMd5['a-id']).toBe(md5('same'));
		expect(plugin.settings.operations).toEqual({ 'local-only.md': 'create' });
		expect(plugin.settings.changesToken).toBe('start-token');
		expect(plugin.createFolder).toHaveBeenCalledWith('folder');
	});

	it('downloads files the device does not have yet', async () => {
		const { plugin, remoteContents } = createPlugin();
		plugin.settings.changesToken = '';
		remoteContents.set('a-id', 'hello');
		plugin.drive.searchFiles.mockResolvedValueOnce([
			remote('a-id', 'a.md', 'hello'),
		]);

		await pull(plugin as never, true);

		expect(plugin.upsertFile).toHaveBeenCalledWith(
			'a.md',
			expect.any(ArrayBuffer),
			'2026-11-01T00:00:00.000Z',
		);
	});
});

describe('conflictPath', () => {
	it('adds a numeric suffix when the name is taken', () => {
		const taken = new Set<string>();
		const first = conflictPath('a/b.md', (p) => taken.has(p));
		taken.add(first);
		const second = conflictPath('a/b.md', (p) => taken.has(p));

		expect(second).toBe(first.replace(').md', ' 2).md'));
	});

	it('handles files without an extension', () => {
		expect(conflictPath('LICENSE', () => false)).toMatch(
			/^LICENSE \(conflict .+\)$/,
		);
	});
});
