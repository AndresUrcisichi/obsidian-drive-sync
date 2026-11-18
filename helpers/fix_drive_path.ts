import { Notice } from 'obsidian';
import type ObsidianGoogleDrive from '../main';
import { pull } from './pull';

/**
 * Forgets this device's Drive ID map and rebuilds it from a full listing.
 * Files whose content matches Drive (by MD5) are adopted without transfer.
 */
export const fixDrivePath = async (t: ObsidianGoogleDrive) => {
	if (t.syncing) return;
	t.settings.driveIdToPath = {};
	t.settings.driveIdToMd5 = {};
	t.settings.changesToken = '';
	t.settings.operations = {};
	await t.saveSettings();
	new Notice('Rebuilding the sync index from Google Drive…');
	await pull(t);
};
