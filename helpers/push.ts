import type ObsidianGoogleDrive from '../main';
import { Modal, Notice, setIcon, Setting, TFile, TFolder } from 'obsidian';
import { md5 } from './md5';
import {
	batchAsync,
	fileNameFromPath,
	folderMimeType,
	foldersToBatches,
	getSyncMessage,
	splitPath,
	unSplitPath,
} from './drive';
import { pull } from './pull';

export class ConfirmPushModal extends Modal {
	proceed: (res: boolean) => void;

	constructor(
		t: ObsidianGoogleDrive,
		initialOperations: [string, 'create' | 'delete' | 'modify'][],
		proceed: (res: boolean) => void,
	) {
		super(t.app);
		this.proceed = proceed;

		this.setTitle('Push confirmation');
		this.contentEl
			.createEl('p')
			.setText(
				'Do you want to push the following changes to Google Drive:',
			);
		const container = this.contentEl.createDiv();

		const render = (operations: typeof initialOperations) => {
			container.empty();
			operations.map(([path, op]) => {
				const div = container.createDiv();
				div.addClass('operation-container');

				const p = div.createEl('p');
				p.createEl('b').setText(
					`${(op[0] as string).toUpperCase()}${op.slice(1)}`,
				);
				p.createSpan().setText(`: ${path}`);

				if (
					op === 'delete' &&
					operations.some(([file]) => path.startsWith(file + '/'))
				) {
					return;
				}

				const btn = div.createDiv().createEl('button');
				setIcon(btn, 'trash-2');
				btn.onclick = async () => {
					const nestedFiles = operations
						.map(([file]) => file)
						.filter(
							(file) =>
								file.startsWith(path + '/') || file === path,
						);
					const proceed = await new Promise<boolean>((resolve) => {
						new ConfirmUndoModal(
							t,
							op,
							nestedFiles,
							resolve,
						).open();
					});

					if (!proceed) return;

					nestedFiles.forEach(
						(file) => delete t.settings.operations[file],
					);
					const newOperations = operations.filter(
						([file]) => !nestedFiles.includes(file),
					);
					if (!newOperations.length) return this.close();
					render(newOperations);
				};
			});
		};

		render(initialOperations);

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText('Cancel').onClick(() => this.close()),
			)
			.addButton((btn) =>
				btn
					.setButtonText('Confirm')
					.setCta()
					.onClick(() => {
						proceed(true);
						this.close();
					}),
			);
	}

	onClose() {
		this.proceed(false);
	}
}

export class ConfirmUndoModal extends Modal {
	proceed: (res: boolean) => void;
	t: ObsidianGoogleDrive;
	filePathToId: Record<string, string>;

	constructor(
		t: ObsidianGoogleDrive,
		operation: 'create' | 'delete' | 'modify',
		files: string[],
		proceed: (res: boolean) => void,
	) {
		super(t.app);
		this.t = t;
		this.filePathToId = Object.fromEntries(
			Object.entries(this.t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			]),
		);

		const operationMap = {
			create: 'creating',
			delete: 'deleting',
			modify: 'modifying',
		};

		this.setTitle('Undo confirmation');
		this.contentEl
			.createEl('p')
			.setText(
				`Are you sure you want to undo ${operationMap[operation]} the following file(s):`,
			);
		this.contentEl.createEl('ul').append(
			...files.map((file) => {
				const li = this.contentEl.createEl('li');
				li.addClass('operation-file');
				li.setText(file);
				return li;
			}),
		);
		this.proceed = proceed;
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText('Cancel').onClick(() => this.close()),
			)
			.addButton((btn) =>
				btn
					.setButtonText('Confirm')
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						if (operation === 'delete') {
							await this.handleDelete(files);
						}
						if (operation === 'create') {
							await this.handleCreate(files[0] as string);
						}
						if (operation === 'modify') {
							await this.handleModify(files[0] as string);
						}
						proceed(true);
						this.close();
					}),
			);
	}

	onClose() {
		this.proceed(false);
	}

	async handleDelete(paths: string[]) {
		const files = await this.t.drive.searchFiles({
			include: ['id', 'mimeType', 'properties', 'modifiedTime'],
			matches: paths.map((path) => ({ properties: splitPath(path) })),
		});
		if (!files) {
			new Notice('An error occurred fetching Google Drive files.');
			return;
		}

		const pathToFile = Object.fromEntries(
			files.map((file) => [unSplitPath(file.properties), file]),
		);

		const deletedFolders = paths.filter(
			(path) => pathToFile[path]?.mimeType === folderMimeType,
		);

		if (deletedFolders.length) {
			const batches = foldersToBatches(deletedFolders);

			for (const batch of batches) {
				await Promise.all(
					batch.map((folder) => this.t.createFolder(folder)),
				);
			}
		}

		const deletedFiles = paths.filter(
			(path) => pathToFile[path]?.mimeType !== folderMimeType,
		);

		await batchAsync(
			deletedFiles.map((path) => async () => {
				const onlineFile = await this.t.drive
					.getFile(this.filePathToId[path] as string)
					.arrayBuffer();
				if (!onlineFile) {
					new Notice(
						'An error occurred fetching Google Drive files.',
					);
					return;
				}
				return this.t.createFile(
					path,
					onlineFile,
					pathToFile[path]?.modifiedTime,
				);
			}),
		);
	}

	async handleCreate(path: string) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file) return;
		return this.t.deleteFile(file);
	}

	async handleModify(path: string) {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;

		const [onlineFile, metadata] = await Promise.all([
			this.t.drive
				.getFile(this.filePathToId[path] as string)
				.arrayBuffer(),
			this.t.drive.getFileMetadata(this.filePathToId[path] as string),
		]);
		if (!onlineFile || !metadata) {
			return new Notice('An error occurred fetching Google Drive files.');
		}
		return this.t.modifyFile(file, onlineFile, metadata.modifiedTime);
	}
}

export const push = async (
	t: ObsidianGoogleDrive,
	skipConfirmation = false,
) => {
	if (t.syncing) return;
	const initialOperations = Object.entries(t.settings.operations).sort(
		([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
	); // Alphabetical

	const { vault } = t.app;
	const adapter = vault.adapter;

	// No auto-push may start while the confirmation is open.
	t.clearAutoPushTimer();
	const proceed =
		skipConfirmation ||
		(await new Promise<boolean>((resolve) => {
			new ConfirmPushModal(t, initialOperations, resolve).open();
		}));

	// Something else may have started syncing while the modal was open.
	if (!proceed || t.syncing) {
		if (!t.syncing) t.resumeAutoPushIfNeeded();
		return;
	}

	const syncNotice = await t.startSync();
	try {
		if (!(await pull(t, true))) return;
		if (!(await t.drive.getRootFolderId(true))) {
			new Notice('Could not verify the Google Drive vault folder.');
			return;
		}

		const pathsToIds = Object.fromEntries(
			Object.entries(t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			]),
		);

		const operations = Object.entries(t.settings.operations);
		const deletes = operations.filter(([_, op]) => op === 'delete');
		// Whether a write is a create or an update depends only on whether
		// Drive already has the path, not on which local event recorded it.
		const writes = operations.filter(
			([_, op]) => op === 'create' || op === 'modify',
		);
		const creates = writes.filter(([path]) => !pathsToIds[path]);
		const modifies = writes.filter(([path]) => pathsToIds[path]);

		const configOnDrive = t.settings.syncConfig
			? await t.drive.searchFiles({
					include: ['properties'],
					matches: [{ properties: { config: 'true' } }],
				})
			: [];
		if (!configOnDrive) {
			new Notice('An error occurred fetching Google Drive files.');
			return;
		}

		await Promise.all(
			configOnDrive.map(async ({ properties }) => {
				const path = unSplitPath(properties);
				if (!(await adapter.exists(path))) {
					deletes.push([path, 'delete']);
				}
			}),
		);

		if (deletes.length) {
			// Paths Drive never had need no remote delete.
			const uniqueIds = [
				...new Set(
					deletes
						.map(([path]) => pathsToIds[path])
						.filter((id): id is string => Boolean(id)),
				),
			];
			if (!(await t.drive.batchDelete(uniqueIds))) {
				new Notice('An error occurred deleting Google Drive files.');
				return;
			}
			uniqueIds.forEach((id) => {
				const path = t.settings.driveIdToPath[id];
				delete t.settings.driveIdToPath[id];
				delete t.settings.driveIdToMd5[id];
				if (path) delete pathsToIds[path];
			});
		}

		syncNotice.setMessage('Syncing (33%)');

		const createFolderOnDrive = async (
			path: string,
			extraProperties: Record<string, string> = {},
		) => {
			const parentPath = path.split('/').slice(0, -1).join('/');
			const id = await t.drive.createFolder({
				name: fileNameFromPath(path),
				parent: parentPath ? pathsToIds[parentPath] : undefined,
				properties: { ...splitPath(path), ...extraProperties },
				modifiedTime: new Date().toISOString(),
			});
			if (!id) throw new Error(`Could not create folder ${path}`);
			t.settings.driveIdToPath[id] = path;
			pathsToIds[path] = id;
		};

		const ensureFolders = async (
			paths: Iterable<string>,
			extraProperties?: Record<string, string>,
		) => {
			const missing = new Set<string>();
			for (const path of paths) {
				const parts = path.split('/');
				for (let i = 1; i <= parts.length; i++) {
					const folder = parts.slice(0, i).join('/');
					if (!pathsToIds[folder]) missing.add(folder);
				}
			}
			if (!missing.size) return;
			for (const batch of foldersToBatches(Array.from(missing))) {
				await batchAsync(
					batch.map(
						(folder) => () =>
							createFolderOnDrive(folder, extraProperties),
					),
				);
			}
		};

		const deferredPaths: string[] = [];
		let completed = 0;
		const total = creates.length + modifies.length;
		const progress = () =>
			syncNotice.setMessage(
				getSyncMessage(33, 99, ++completed, total || 1),
			);

		if (creates.length) {
			const files = creates
				.map(([path]) => vault.getAbstractFileByPath(path))
				.filter((file): file is TFile | TFolder => Boolean(file));

			// Parents first, including ones no operation mentions (for
			// example after a remote delete of a folder with local edits).
			await ensureFolders([
				...files
					.filter((file) => file instanceof TFolder)
					.map(({ path }) => path),
				...files
					.filter((file) => file instanceof TFile)
					.map((file) => file.parent?.path ?? '')
					.filter((path) => path && path !== '/'),
			]);

			const notes = files.filter((file) => file instanceof TFile);
			await batchAsync(
				notes.map((note) => async () => {
					const result = await t.drive.uploadFile(
						new Blob([await vault.readBinary(note)]),
						note.name,
						note.parent && note.parent.path !== '/'
							? pathsToIds[note.parent.path]
							: undefined,
						{
							properties: splitPath(note.path),
							modifiedTime: new Date().toISOString(),
						},
					);
					if (!result) {
						throw new Error(`Could not upload ${note.path}`);
					}
					t.settings.driveIdToPath[result.id] = note.path;
					if (result.md5Checksum) {
						t.settings.driveIdToMd5[result.id] = result.md5Checksum;
					}
					pathsToIds[note.path] = result.id;
					progress();
				}),
			);
		}

		if (modifies.length) {
			// Files another device changed since our pull are left for the
			// next pull, which keeps both versions instead of overwriting.
			const sincePull = await t.drive.getChanges(t.settings.changesToken);
			if (!sincePull) {
				new Notice('An error occurred fetching Google Drive changes.');
				return;
			}
			const changedRemotely = new Set(
				sincePull.changes
					.filter(
						({ fileId, file }) =>
							file?.md5Checksum &&
							file.md5Checksum !== t.settings.driveIdToMd5[fileId],
					)
					.map(({ fileId }) => fileId),
			);

			const files = modifies
				.filter(([path]) => !changedRemotely.has(pathsToIds[path] as string))
				.map(([path]) => vault.getFileByPath(path))
				.filter((file): file is TFile => file instanceof TFile);
			deferredPaths.push(
				...modifies
					.filter(([path]) =>
						changedRemotely.has(pathsToIds[path] as string),
					)
					.map(([path]) => path),
			);

			await batchAsync(
				files.map((file) => async () => {
					const id = pathsToIds[file.path] as string;
					const bytes = await vault.readBinary(file);
					progress();
					// Saves without content changes cost nothing.
					if (t.settings.driveIdToMd5[id] === md5(bytes)) return;

					const result = await t.drive.updateFile(
						id,
						new Blob([bytes]),
						{ modifiedTime: new Date().toISOString() },
					);
					if (!result) {
						throw new Error(`Could not update ${file.path}`);
					}
					if (result.md5Checksum) {
						t.settings.driveIdToMd5[id] = result.md5Checksum;
					}
				}),
			);
		}

		const configFilesToSync = await t.drive.getConfigFilesToSync();
		await ensureFolders(
			configFilesToSync.map((path) =>
				path.split('/').slice(0, -1).join('/'),
			),
			{ config: 'true' },
		);

		await batchAsync(
			configFilesToSync.map((path) => async () => {
				const bytes = await adapter.readBinary(path);
				const existingId = pathsToIds[path];
				if (existingId) {
					if (t.settings.driveIdToMd5[existingId] === md5(bytes)) {
						return;
					}
					const result = await t.drive.updateFile(
						existingId,
						new Blob([bytes]),
						{ modifiedTime: new Date().toISOString() },
					);
					if (result?.md5Checksum) {
						t.settings.driveIdToMd5[existingId] = result.md5Checksum;
					}
					return;
				}

				const result = await t.drive.uploadFile(
					new Blob([bytes]),
					fileNameFromPath(path),
					pathsToIds[path.split('/').slice(0, -1).join('/')],
					{
						properties: { ...splitPath(path), config: 'true' },
						modifiedTime: new Date().toISOString(),
					},
				);
				if (!result) {
					throw new Error(`Could not upload ${path}`);
				}
				t.settings.driveIdToPath[result.id] = path;
				if (result.md5Checksum) {
					t.settings.driveIdToMd5[result.id] = result.md5Checksum;
				}
				pathsToIds[path] = result.id;
			}),
		);

		// Keep edits made while this push was running, and deferred updates.
		t.settings.operations = Object.fromEntries(
			[...t.touchedDuringSync, ...deferredPaths]
				.map((path) => [path, t.settings.operations[path]] as const)
				.filter(([, op]) => op),
		) as typeof t.settings.operations;

		if (!(await t.endSync(syncNotice, false))) return;

		if (!skipConfirmation) new Notice('Sync complete!');
	} catch (error) {
		console.error('Google Drive push failed', error);
		new Notice(
			'Push did not finish. Your changes are kept and will be retried on the next push.',
		);
	} finally {
		// Persist IDs of whatever did upload, even on failure.
		await t.saveSettings();
		if (t.syncing) t.abortSync(syncNotice);
	}
};
