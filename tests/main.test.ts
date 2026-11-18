import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', globalThis);

vi.mock('obsidian', () => {
	class TAbstractFile {
		path: string;
		constructor(path: string) {
			this.path = path;
		}
	}
	class TFile extends TAbstractFile {}
	return {
		App: class {},
		Menu: class {},
		Modal: class {},
		Notice: class {},
		Plugin: class {},
		PluginSettingTab: class {},
		Setting: class {},
		TAbstractFile,
		TFile,
		TFolder: class extends TAbstractFile {},
		debounce: (callback: unknown) => callback,
		requestUrl: vi.fn(),
		setIcon: vi.fn(),
	};
});

import { TFile } from 'obsidian';
import ObsidianGoogleDrive from '../main';

const createPlugin = () =>
	Object.assign(Object.create(ObsidianGoogleDrive.prototype), {
		settings: {
			autoPush: false,
			autoPushDelaySeconds: 60,
			operations: {},
			driveIdToPath: {},
			rootFolderId: '',
			lastSyncedAt: 0,
			changesToken: 'old-token',
		},
		debouncedSaveSettings: vi.fn(),
		saveSettings: vi.fn(async () => undefined),
		ribbonIcon: {
			addClass: vi.fn(),
			removeClass: vi.fn(),
		},
		touchedDuringSync: new Set<string>(),
		drive: {
			getConfigFilesToSync: vi.fn(async () => []),
			getChangesStartToken: vi.fn(async () => 'new-token'),
		},
		app: {
			secretStorage: { getSecret: vi.fn(() => 'refresh') },
			vault: {
				adapter: {
					readBinary: vi.fn(),
					writeBinary: vi.fn(),
				},
			},
		},
		syncing: true,
	}) as ObsidianGoogleDrive;

describe('ObsidianGoogleDrive operation tracking', () => {
	it('turns recreation of a deleted file into a modification', () => {
		const plugin = createPlugin();
		plugin.settings.operations['note.md'] = 'delete';
		const file = new TFile();
		Object.assign(file, { path: 'note.md' });

		plugin.handleCreate(file);

		expect(plugin.settings.operations['note.md']).toBe('modify');
	});

	it('debounces automatic push scheduling after local changes', () => {
		const setTimeout = vi
			.spyOn(window, 'setTimeout')
			.mockReturnValue(1 as never);
		const clearTimeout = vi.spyOn(window, 'clearTimeout');
		const plugin = createPlugin();
		plugin.syncing = false;
		plugin.settings.autoPush = true;
		const file = new TFile();
		Object.assign(file, { path: 'note.md' });

		plugin.handleModify(file);
		plugin.handleModify(file);

		expect(setTimeout).toHaveBeenCalledTimes(2);
		expect(setTimeout).toHaveBeenLastCalledWith(
			expect.any(Function),
			60_000,
		);
		expect(clearTimeout).toHaveBeenCalledWith(1);
		plugin.clearAutoPushTimer();
		expect(clearTimeout).toHaveBeenCalledTimes(2);
	});

	it('does not schedule automatic pushes while syncing or disabled', () => {
		const setTimeout = vi.spyOn(window, 'setTimeout');
		const plugin = createPlugin();
		plugin.settings.operations['note.md'] = 'modify';

		plugin.scheduleAutoPush();
		expect(setTimeout).not.toHaveBeenCalled();

		plugin.settings.autoPush = true;
		plugin.scheduleAutoPush();
		expect(setTimeout).not.toHaveBeenCalled();
	});

	it('cancels a pending create when the file is deleted', () => {
		const plugin = createPlugin();
		plugin.settings.operations['note.md'] = 'create';
		const file = new TFile();
		Object.assign(file, { path: 'note.md' });

		plugin.handleDelete(file);

		expect(plugin.settings.operations).not.toHaveProperty('note.md');
	});
});

describe('ObsidianGoogleDrive sync lifecycle', () => {
	it('finishes without asking Drive for a fresh checkpoint', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(1234);
		const plugin = createPlugin();

		await expect(plugin.endSync(undefined, false)).resolves.toBe(true);

		// The checkpoint comes from the changes feed during pull; fetching a
		// new one here would skip edits uploaded by others mid-sync.
		expect(plugin.drive.getChangesStartToken).not.toHaveBeenCalled();
		expect(plugin.settings.changesToken).toBe('old-token');
		expect(plugin.settings.lastSyncedAt).toBe(1234);
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
		expect(plugin.syncing).toBe(false);
	});

	it('remembers paths the user edits while a sync is running', () => {
		const plugin = createPlugin();

		plugin.handleModify(Object.assign(new TFile(), { path: 'during.md' }));

		expect(plugin.touchedDuringSync.has('during.md')).toBe(true);
	});
});

describe('ObsidianGoogleDrive settings migration', () => {
	it('drops upstream credentials from data.json', async () => {
		const plugin = createPlugin();
		Object.assign(plugin, {
			loadData: vi.fn(async () => ({
				refreshToken: 'leaked',
				accessTokenUrl: 'https://example.com',
				clientSecret: 'secret',
				autoPush: false,
			})),
		});

		await plugin.loadSettings();

		expect(plugin.settings).not.toHaveProperty('refreshToken');
		expect(plugin.settings).not.toHaveProperty('accessTokenUrl');
		expect(plugin.settings).not.toHaveProperty('clientSecret');
		expect(plugin.settings.autoPush).toBe(false);
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
	});
});
