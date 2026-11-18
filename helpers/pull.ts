import type ObsidianGoogleDrive from '../main';
import { Notice, TAbstractFile, TFile, TFolder } from 'obsidian';
import {
	batchAsync,
	FileMetadata,
	folderMimeType,
	foldersToBatches,
	getSyncMessage,
	isPrivatePluginFile,
	unSplitPath,
} from './drive';
import { md5 } from './md5';

const FILE_FIELDS: (keyof FileMetadata)[] = [
	'id',
	'mimeType',
	'md5Checksum',
	'modifiedTime',
	'properties',
];

const pad = (n: number) => String(n).padStart(2, '0');

export const conflictPath = (path: string, exists: (p: string) => boolean) => {
	const slash = path.lastIndexOf('/');
	const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
	const file = path.slice(slash + 1);
	const dot = file.lastIndexOf('.');
	const base = dot > 0 ? file.slice(0, dot) : file;
	const ext = dot > 0 ? file.slice(dot) : '';
	const d = new Date();
	const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
	let candidate = `${dir}${base} (conflict ${stamp})${ext}`;
	for (let i = 2; exists(candidate); i++) {
		candidate = `${dir}${base} (conflict ${stamp} ${i})${ext}`;
	}
	return candidate;
};

/**
 * Brings the local vault up to date with Google Drive.
 *
 * - First run on a device (no checkpoint): lists every file of this vault on
 *   Drive and reconciles by MD5, so an existing local copy (for example the
 *   folder downloaded from drive.google.com) is adopted without downloading it.
 * - Later runs: reads only the Drive changes feed since the last checkpoint.
 *
 * Unpushed local edits always survive. When Drive also changed the same note,
 * the Drive version is saved next to it as "name (conflict …).md".
 *
 * With `silenceNotices`, the caller owns startSync/endSync.
 */
export const pull = async (t: ObsidianGoogleDrive, silenceNotices = false) => {
	let syncNotice = undefined;

	if (!silenceNotices) {
		if (t.syncing) return;
		syncNotice = await t.startSync();
	}
	try {
		const { vault } = t.app;
		const { adapter } = vault;
		const { configDir } = vault;
		const isConfig = (path: string) =>
			path === configDir || path.startsWith(configDir + '/');
		const vaultName = vault.getName();
		const bootstrap =
			!t.settings.changesToken ||
			!Object.keys(t.settings.driveIdToPath).length;

		// 1. Reconcile local edits made while Obsidian was closed.
		const cloudSet = new Set(
			Object.values(t.settings.driveIdToPath).filter(
				(path) => !isConfig(path),
			),
		);
		const localSet = new Set(
			vault
				.getAllLoadedFiles()
				.map((file) => file.path)
				.filter((path) => path !== '/'),
		);

		// Hidden or not-yet-indexed files (for example another device's
		// config folder) are missing from the index but still on disk.
		for (const path of cloudSet) {
			if (!localSet.has(path) && !(await adapter.exists(path))) {
				t.settings.operations[path] = 'delete';
			}
		}

		for (const path in t.settings.operations) {
			if (isConfig(path)) continue;
			const operation = t.settings.operations[path];
			const existsLocally = localSet.has(path);
			if (operation === 'delete' && existsLocally) {
				t.settings.operations[path] = 'modify';
			} else if (operation === 'create' && !existsLocally) {
				delete t.settings.operations[path];
			} else if (operation === 'modify' && !existsLocally) {
				t.settings.operations[path] = 'delete';
			}
		}

		localSet.forEach((path) => {
			if (!cloudSet.has(path) && !t.settings.operations[path]) {
				t.settings.operations[path] = 'create';
			}
		});

		// 2. Collect what changed on Drive.
		let upserts: FileMetadata[] = [];
		const removedIds = new Set<string>();
		let nextToken: string | undefined;

		if (bootstrap) {
			nextToken = await t.drive.getChangesStartToken();
			const files = await t.drive.searchFiles({ include: FILE_FIELDS });
			if (!files || !nextToken) {
				new Notice('An error occurred fetching Google Drive files.');
				t.abortSync(syncNotice);
				return false;
			}
			upserts = files;
			// Anything we mapped before but Drive no longer has is gone.
			const remoteIds = new Set(files.map(({ id }) => id));
			Object.keys(t.settings.driveIdToPath).forEach((id) => {
				if (!remoteIds.has(id)) removedIds.add(id);
			});
		} else {
			const result = await t.drive.getChanges(t.settings.changesToken);
			if (!result) {
				new Notice('An error occurred fetching Google Drive changes.');
				t.abortSync(syncNotice);
				return false;
			}
			nextToken = result.newStartPageToken;

			// The feed lists a file once per change; only the last one matters.
			const latest = new Map<string, (typeof result.changes)[number]>();
			result.changes.forEach((change) =>
				latest.set(change.fileId, change),
			);
			latest.forEach((change, id) => {
				if (change.removed || !change.file || change.file.trashed) {
					if (t.settings.driveIdToPath[id]) removedIds.add(id);
					return;
				}
				const { properties } = change.file;
				if (
					properties?.vault !== vaultName ||
					properties?.obsidian === 'vault'
				) {
					return;
				}
				upserts.push(change.file);
			});
		}

		upserts = upserts.filter(
			({ properties, mimeType }) =>
				properties?.obsidian !== 'vault' &&
				(t.settings.syncConfig || properties?.config !== 'true') &&
				// Native Docs/Sheets have no downloadable bytes.
				(mimeType === folderMimeType ||
					!mimeType?.startsWith('application/vnd.google-apps.')),
		);

		// A path change for a known ID means it moved; drop the old location.
		upserts.forEach(({ id, properties }) => {
			const oldPath = t.settings.driveIdToPath[id];
			if (oldPath && oldPath !== unSplitPath(properties)) {
				removedIds.add(id);
			}
		});

		// 3. Apply remote deletions, unless the local copy has unpushed edits.
		const toTrash: TAbstractFile[] = [];
		const configToRemove: string[] = [];
		removedIds.forEach((id) => {
			const path = t.settings.driveIdToPath[id];
			delete t.settings.driveIdToPath[id];
			delete t.settings.driveIdToMd5[id];
			if (!path) return;

			const operation = t.settings.operations[path];
			if (operation === 'delete') {
				delete t.settings.operations[path];
				return;
			}
			if (operation === 'create' || operation === 'modify') {
				t.settings.operations[path] = 'create';
				return;
			}
			if (isConfig(path)) {
				if (t.settings.syncConfig) configToRemove.push(path);
				return;
			}
			const file = vault.getAbstractFileByPath(path);
			if (!file) return;
			if (file instanceof TFolder) {
				const hasLocalEdits = Object.entries(t.settings.operations).some(
					([p, op]) =>
						p.startsWith(path + '/') &&
						(op === 'create' || op === 'modify'),
				);
				if (hasLocalEdits) {
					t.settings.operations[path] = 'create';
					return;
				}
			}
			toTrash.push(file);
		});

		// Moved IDs come back through the upsert pass below.
		if (toTrash.length) {
			await t.drive.deleteFilesMinimumOperations(toTrash);
		}
		for (const path of configToRemove.sort().reverse()) {
			const stat = await adapter.stat(path);
			if (!stat) continue;
			if (stat.type === 'file') await adapter.remove(path);
			else if (!(await adapter.list(path)).files.length) {
				await adapter.rmdir(path, false);
			}
		}

		syncNotice?.setMessage('Syncing (33%)');

		// 4. Folders first, shallowest first.
		const folders = upserts.filter(
			({ mimeType }) => mimeType === folderMimeType,
		);
		folders.forEach(({ id, properties }) => {
			t.settings.driveIdToPath[id] = unSplitPath(properties);
		});
		if (folders.length) {
			for (const batch of foldersToBatches(
				folders.map(({ properties }) => unSplitPath(properties)),
			)) {
				await Promise.all(
					batch.map(async (folder) => {
						if (t.settings.operations[folder] !== 'delete') {
							delete t.settings.operations[folder];
						}
						if (
							vault.getFolderByPath(folder) ||
							(await adapter.exists(folder))
						) {
							return;
						}
						if (t.settings.operations[folder] === 'delete') return;
						return t.createFolder(folder);
					}),
				);
			}
		}

		// 5. Files: skip what we already have, keep both on conflict.
		const files = upserts.filter(
			({ mimeType }) => mimeType !== folderMimeType,
		);
		let completed = 0;
		let conflicts = 0;

		/**
		 * A remote change under a folder deleted locally revives that folder:
		 * otherwise the pending folder delete would trash the new remote edit.
		 */
		const reviveAncestors = async (path: string) => {
			const parts = path.split('/');
			for (let i = 1; i < parts.length; i++) {
				const folder = parts.slice(0, i).join('/');
				if (t.settings.operations[folder] === 'delete') {
					delete t.settings.operations[folder];
				}
				if (await adapter.exists(folder)) continue;
				try {
					await t.createFolder(folder);
				} catch (error) {
					// Another worker may have created it meanwhile.
					if (!(await adapter.exists(folder))) throw error;
				}
			}
		};

		const readLocal = async (path: string) => {
			const file = vault.getFileByPath(path);
			return file ? vault.readBinary(file) : adapter.readBinary(path);
		};

		const saveConflictCopy = async (path: string, remote: ArrayBuffer) => {
			const copyPath = conflictPath(path, (p) =>
				Boolean(vault.getAbstractFileByPath(p)),
			);
			// Created through the vault so it is tracked and pushed.
			await vault.createBinary(copyPath, remote);
			t.settings.operations[path] = 'modify';
			conflicts++;
		};

		await batchAsync(
			files.map((file) => async () => {
				const path = unSplitPath(file.properties);
				completed++;
				syncNotice?.setMessage(
					getSyncMessage(33, 100, completed, files.length),
				);

				const knownMd5 = t.settings.driveIdToMd5[file.id];
				const remoteMd5 = file.md5Checksum;
				t.settings.driveIdToPath[file.id] = path;
				if (isPrivatePluginFile(t, path)) return;

				const existsLocally =
					Boolean(vault.getFileByPath(path)) ||
					(await adapter.exists(path));
				const operation = t.settings.operations[path];

				if (
					remoteMd5 &&
					knownMd5 === remoteMd5 &&
					(existsLocally || operation === 'delete')
				) {
					// Our own upload or a metadata-only change.
					return;
				}

				// MD5 of the local copy we are about to replace, if any.
				let expectedLocalMd5: string | undefined;

				if (operation === 'delete' && !isConfig(path)) {
					// Local delete vs remote edit: the remote edit wins.
					delete t.settings.operations[path];
				} else if (
					existsLocally &&
					(operation === 'create' || operation === 'modify')
				) {
					const localMd5 = md5(await readLocal(path));
					if (remoteMd5 && localMd5 === remoteMd5) {
						t.settings.driveIdToMd5[file.id] = remoteMd5;
						delete t.settings.operations[path];
						return;
					}
					const editedLocally = !knownMd5 || localMd5 !== knownMd5;
					if (editedLocally) {
						if (!isConfig(path)) {
							const remote = await t.drive
								.getFile(file.id)
								.arrayBuffer();
							await saveConflictCopy(path, remote);
						} else {
							// Settings: local wins, it is pushed next.
							t.settings.operations[path] = 'modify';
						}
						// Only now is the remote version safe locally; marking it
						// known earlier would hide it if the download failed.
						if (remoteMd5) t.settings.driveIdToMd5[file.id] = remoteMd5;
						return;
					}
					// The op was stale: the bytes still match the last sync.
					delete t.settings.operations[path];
					expectedLocalMd5 = localMd5;
				} else if (existsLocally) {
					expectedLocalMd5 = md5(await readLocal(path));
				}

				await reviveAncestors(path);
				const content = await t.drive.getFile(file.id).arrayBuffer();

				// The user may have typed while we were downloading.
				if (
					expectedLocalMd5 &&
					!isConfig(path) &&
					md5(await readLocal(path)) !== expectedLocalMd5
				) {
					await saveConflictCopy(path, content);
					if (remoteMd5) t.settings.driveIdToMd5[file.id] = remoteMd5;
					return;
				}

				const localFile = vault.getFileByPath(path);
				if (localFile instanceof TFile) {
					await t.modifyFile(localFile, content, file.modifiedTime);
				} else {
					await t.upsertFile(path, content, file.modifiedTime);
				}
				if (remoteMd5) t.settings.driveIdToMd5[file.id] = remoteMd5;
			}),
		);

		// Remaining "create" ops for paths now mapped on Drive are not new.
		const mapped = new Set(Object.values(t.settings.driveIdToPath));
		for (const [path, op] of Object.entries(t.settings.operations)) {
			if (op === 'create' && mapped.has(path)) {
				t.settings.operations[path] = 'modify';
			}
		}

		t.settings.changesToken = nextToken;
		t.lastPullAt = Date.now();

		if (conflicts) {
			new Notice(
				`${conflicts} note(s) changed on two devices. The Google Drive version was saved as a "(conflict …)" copy next to each one.`,
				0,
			);
		}

		if (silenceNotices) return true;

		const ended = await t.endSync(syncNotice);
		if (ended) {
			new Notice(
				upserts.length || removedIds.size
					? 'Files have been synced from Google Drive!'
					: "You're up to date!",
			);
		}
		return ended;
	} catch (error) {
		t.abortSync(syncNotice);
		new Notice('Sync failed unexpectedly. Please try again.');
		console.error('Google Drive pull failed', error);
		return false;
	}
};
