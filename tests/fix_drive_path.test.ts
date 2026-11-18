import { describe, expect, it, vi } from 'vitest';

const pull = vi.hoisted(() => vi.fn(async () => true));

vi.mock('obsidian', () => ({ Notice: vi.fn() }));
vi.mock('../helpers/pull', () => ({ pull }));

import { fixDrivePath } from '../helpers/fix_drive_path';

const createPlugin = (syncing = false) => ({
	syncing,
	settings: {
		driveIdToPath: { 'a-id': 'a.md' },
		driveIdToMd5: { 'a-id': 'abc' },
		changesToken: 'token',
		operations: { 'a.md': 'modify' },
	},
	saveSettings: vi.fn(async () => undefined),
});

describe('fixDrivePath', () => {
	it('forgets the local index and rebuilds it with a full pull', async () => {
		const plugin = createPlugin();

		await fixDrivePath(plugin as never);

		expect(plugin.settings).toEqual({
			driveIdToPath: {},
			driveIdToMd5: {},
			changesToken: '',
			operations: {},
		});
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
		expect(pull).toHaveBeenCalledWith(plugin);
	});

	it('does nothing while a sync is running', async () => {
		pull.mockClear();
		const plugin = createPlugin(true);

		await fixDrivePath(plugin as never);

		expect(plugin.settings.changesToken).toBe('token');
		expect(pull).not.toHaveBeenCalled();
	});
});
