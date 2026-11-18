import { getDriveClient } from './helpers/drive';
import {
	BUILD_DEFAULTS,
	finishSignIn,
	getClientSecret,
	isSignedIn,
	parsePastedCode,
	PROTOCOL_ACTION,
	setClientSecret,
	signOut,
	startSignIn,
} from './helpers/auth';
import { pull } from './helpers/pull';
import { push } from './helpers/push';
import { reset } from './helpers/reset';
import {
	App,
	debounce,
	Notice,
	Plugin,
	PluginSettingTab,
	type SettingDefinitionItem,
	TAbstractFile,
	TFile,
} from 'obsidian';
import { fixDrivePath } from './helpers/fix_drive_path';

type Operation = 'create' | 'delete' | 'modify';

interface PluginSettings {
	clientId: string;
	redirectUri: string;
	autoPush: boolean;
	autoPushDelaySeconds: number;
	pullOnResume: boolean;
	syncConfig: boolean;
	operations: Record<string, Operation>;
	driveIdToPath: Record<string, string>;
	driveIdToMd5: Record<string, string>;
	rootFolderId: string;
	lastSyncedAt: number;
	changesToken: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	clientId: '',
	redirectUri: '',
	autoPush: true,
	autoPushDelaySeconds: 30,
	pullOnResume: true,
	syncConfig: true,
	operations: {},
	driveIdToPath: {},
	driveIdToMd5: {},
	rootFolderId: '',
	lastSyncedAt: 0,
	changesToken: '',
};

// Fields from the upstream plugin that must not linger in data.json.
const LEGACY_KEYS = ['refreshToken', 'accessTokenUrl', 'clientSecret'];

const RESUME_PULL_COOLDOWN_MS = 30_000;

export default class ObsidianGoogleDrive extends Plugin {
	settings!: PluginSettings;
	accessToken = {
		token: '',
		expiresAt: 0,
	};
	drive = getDriveClient(this);
	ribbonIcon?: HTMLElement;
	syncing = false;
	autoPushTimer?: number;
	lastPullAt = 0;
	/** Paths changed by the user while a sync was running. */
	touchedDuringSync = new Set<string>();

	async onload() {
		const { vault } = this.app;

		await this.loadSettings();

		this.addSettingTab(new SettingsTab(this.app, this));

		this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
			if (!params.code || !params.state) return;
			void this.completeSignIn(params.code, params.state);
		});

		this.ribbonIcon = this.addRibbonIcon(
			'refresh-cw',
			'Push to Google Drive',
			() => {
				if (this.syncing || !this.requireSignIn()) return;
				void push(this);
			},
		);

		this.addCommand({
			id: 'push',
			name: 'Push to Google Drive',
			callback: () => this.requireSignIn() && push(this),
		});

		this.addCommand({
			id: 'pull',
			name: 'Pull from Google Drive',
			callback: () => this.requireSignIn() && pull(this),
		});

		this.addCommand({
			id: 'reset',
			name: 'Reset local vault to Google Drive',
			callback: () => this.requireSignIn() && reset(this),
		});

		this.addCommand({
			id: 'fix-drive-path',
			name: 'Rebuild sync index from Google Drive',
			callback: () => this.requireSignIn() && fixDrivePath(this),
		});

		this.registerEvent(
			this.app.workspace.on('quit', () => this.saveSettings()),
		);

		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(
				vault.on('create', this.handleCreate.bind(this)),
			);
			this.registerEvent(
				vault.on('delete', this.handleDelete.bind(this)),
			);
			this.registerEvent(
				vault.on('modify', this.handleModify.bind(this)),
			);
			this.registerEvent(
				vault.on('rename', this.handleRename.bind(this)),
			);

			// Phones suspend Obsidian in the background: catch up on return.
			this.registerDomEvent(document, 'visibilitychange', () => {
				if (
					document.visibilityState === 'visible' &&
					this.settings.pullOnResume &&
					Date.now() - this.lastPullAt > RESUME_PULL_COOLDOWN_MS
				) {
					void this.backgroundPull();
				}
			});

			if (!isSignedIn(this)) {
				new Notice(
					'To start syncing with Google Drive, open the plugin settings and sign in. Back up your vault before the first sync.',
					10000,
				);
				return;
			}
			void this.backgroundPull();
		});
	}

	onunload() {
		this.clearAutoPushTimer();
		void this.saveSettings();
	}

	requireSignIn() {
		if (isSignedIn(this)) return true;
		new Notice('Sign in to Google Drive in the plugin settings first.');
		return false;
	}

	async completeSignIn(code: string, state: string) {
		if (!(await finishSignIn(this, code, state))) return;
		new Notice('Signed in to Google Drive. Starting the first sync…');
		await this.backgroundPull();
	}

	/** Silent pull used on startup and when the app comes back to the front. */
	async backgroundPull() {
		if (this.syncing || !isSignedIn(this) || !navigator.onLine) return;
		this.syncing = true;
		this.ribbonIcon?.addClass('spin');
		try {
			if (await pull(this, true)) await this.endSync();
		} finally {
			if (this.syncing) this.abortSync();
		}
	}

	async loadSettings() {
		const stored = ((await this.loadData()) ?? {}) as Record<
			string,
			unknown
		>;
		const hadLegacy = LEGACY_KEYS.some((key) => key in stored);
		LEGACY_KEYS.forEach((key) => delete stored[key]);
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			stored as Partial<PluginSettings>,
		);
		if (hadLegacy) await this.saveSettings();
	}

	saveSettings() {
		return this.saveData(this.settings);
	}

	debouncedSaveSettings = debounce(this.saveSettings.bind(this), 500, true);

	clearAutoPushTimer() {
		if (this.autoPushTimer === undefined) return;
		window.clearTimeout(this.autoPushTimer);
		this.autoPushTimer = undefined;
	}

	scheduleAutoPush() {
		this.clearAutoPushTimer();
		if (!this.settings.autoPush || this.syncing || !isSignedIn(this)) {
			return;
		}

		const delay =
			Math.max(5, this.settings.autoPushDelaySeconds || 30) * 1000;
		this.autoPushTimer = window.setTimeout(() => {
			this.autoPushTimer = undefined;
			if (
				this.syncing ||
				!this.settings.autoPush ||
				!navigator.onLine ||
				!Object.keys(this.settings.operations).length
			) {
				return;
			}
			void push(this, true);
		}, delay);
	}

	resumeAutoPushIfNeeded() {
		if (Object.keys(this.settings.operations).length) {
			this.scheduleAutoPush();
		}
	}

	private track(path: string) {
		if (this.syncing) this.touchedDuringSync.add(path);
	}

	handleCreate(file: TAbstractFile) {
		this.track(file.path);
		if (this.settings.operations[file.path] === 'delete') {
			if (file instanceof TFile) {
				this.settings.operations[file.path] = 'modify';
			} else {
				delete this.settings.operations[file.path];
			}
		} else {
			if (file.path.includes('"')) {
				new Notice(
					`File path ${file.path} contains double quotes and will not be synced.`,
				);
				return;
			}
			this.settings.operations[file.path] = 'create';
		}
		this.debouncedSaveSettings();
		this.scheduleAutoPush();
	}

	handleDelete(file: TAbstractFile) {
		this.track(file.path);
		if (this.settings.operations[file.path] === 'create') {
			delete this.settings.operations[file.path];
		} else if (!file.path.includes('"')) {
			this.settings.operations[file.path] = 'delete';
		}
		this.debouncedSaveSettings();
		this.scheduleAutoPush();
	}

	handleModify(file: TAbstractFile) {
		this.track(file.path);
		const operation = this.settings.operations[file.path];
		if (operation === 'create' || operation === 'modify') {
			this.scheduleAutoPush();
			return;
		}
		this.settings.operations[file.path] = 'modify';
		this.debouncedSaveSettings();
		this.scheduleAutoPush();
	}

	handleRename(file: TAbstractFile, oldPath: string) {
		this.handleDelete({ ...file, path: oldPath });
		this.handleCreate(file);
		this.debouncedSaveSettings();
	}

	async createFolder(path: string) {
		const oldOperation = this.settings.operations[path];
		await this.app.vault.createFolder(path);
		if (oldOperation) this.settings.operations[path] = oldOperation;
		else delete this.settings.operations[path];
	}

	async createFile(
		path: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date,
	) {
		const oldOperation = this.settings.operations[path];
		await this.app.vault.createBinary(path, content, {
			mtime: toMillis(modificationDate),
		});
		if (oldOperation) this.settings.operations[path] = oldOperation;
		else delete this.settings.operations[path];
	}

	async modifyFile(
		file: TFile,
		content: ArrayBuffer,
		modificationDate?: number | string | Date,
	) {
		const oldOperation = this.settings.operations[file.path];
		await this.app.vault.modifyBinary(file, content, {
			mtime: toMillis(modificationDate),
		});
		if (oldOperation) this.settings.operations[file.path] = oldOperation;
		else delete this.settings.operations[file.path];
	}

	async upsertFile(
		file: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date,
	) {
		const oldOperation = this.settings.operations[file];
		await this.app.vault.adapter.writeBinary(file, content, {
			mtime: toMillis(modificationDate),
		});
		if (oldOperation) this.settings.operations[file] = oldOperation;
		else delete this.settings.operations[file];
	}

	async deleteFile(file: TAbstractFile) {
		await this.app.fileManager.trashFile(file);
		delete this.settings.operations[file.path];
	}

	async startSync() {
		if (!navigator.onLine) {
			new Notice(
				'You are offline. Sync will work again once you are connected.',
			);
			throw new Error('No internet connection');
		}
		this.clearAutoPushTimer();
		this.ribbonIcon?.addClass('spin');
		this.syncing = true;
		this.touchedDuringSync.clear();
		return new Notice('Syncing (0%)', 0);
	}

	async endSync(syncNotice?: Notice, retainConfigChanges = true) {
		const syncedAt = Date.now();
		if (retainConfigChanges) {
			// Keep unpushed local settings changes newer than the checkpoint.
			const configFilesToSync = await this.drive.getConfigFilesToSync();
			await Promise.all(
				configFilesToSync.map(async (file) =>
					this.app.vault.adapter.writeBinary(
						file,
						await this.app.vault.adapter.readBinary(file),
						{ mtime: Date.now() },
					),
				),
			);
		}

		// The changes checkpoint is advanced by pull from the feed itself, so
		// nothing another device uploads mid-sync can slip through.
		this.settings.lastSyncedAt = syncedAt;
		await this.saveSettings();
		this.ribbonIcon?.removeClass('spin');
		this.syncing = false;
		syncNotice?.hide();
		this.resumeAutoPushIfNeeded();
		return true;
	}

	abortSync(syncNotice?: Notice) {
		this.ribbonIcon?.removeClass('spin');
		this.syncing = false;
		syncNotice?.hide();
		this.resumeAutoPushIfNeeded();
	}
}

const toMillis = (date?: number | string | Date) => {
	if (typeof date === 'string') return new Date(date).getTime();
	if (date instanceof Date) return date.getTime();
	return date;
};

class SettingsTab extends PluginSettingTab {
	plugin: ObsidianGoogleDrive;

	constructor(app: App, plugin: ObsidianGoogleDrive) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const plugin = this.plugin;
		return [
			{
				name: 'Google account',
				render: (setting) => {
					const signedIn = isSignedIn(plugin);
					setting
						.setName('Google account')
						.setDesc(
							signedIn
								? 'Signed in. Only files this plugin creates in your Drive are visible to it.'
								: 'Sign in to start syncing. A browser window opens; approve access and you are sent back to Obsidian.',
						);
					setting.addButton((button) =>
						signedIn
							? button.setButtonText('Sign out').onClick(async () => {
									await signOut(plugin);
									this.update();
								})
							: button
									.setButtonText('Sign in with Google')
									.setCta()
									.onClick(() => void startSignIn(plugin)),
					);
				},
			},
			{
				name: 'Paste sign-in code',
				render: (setting) => {
					setting
						.setName('Paste sign-in code')
						.setDesc(
							'Only needed if the browser did not send you back to Obsidian. Copy the code shown on the sign-in page.',
						);
					let value = '';
					setting.addText((text) =>
						text
							.setPlaceholder('Paste the code here')
							.onChange((v) => (value = v)),
					);
					setting.addButton((button) =>
						button.setButtonText('Use code').onClick(async () => {
							const parsed = parsePastedCode(value);
							if (!parsed) {
								new Notice('That code is not valid.');
								return;
							}
							await plugin.completeSignIn(parsed.code, parsed.state);
							this.update();
						}),
					);
				},
			},
			{
				name: 'Automatically push changes',
				desc: 'Push shortly after you stop editing.',
				control: {
					type: 'toggle',
					key: 'autoPush',
					defaultValue: true,
				},
			},
			{
				name: 'Auto-push delay (seconds)',
				desc: 'Quiet time after the last edit before pushing. Minimum 5.',
				control: {
					type: 'text',
					key: 'autoPushDelaySeconds',
					placeholder: '30',
					validate: (value: string) =>
						/^\d+$/.test(String(value)) && Number(value) >= 5
							? undefined
							: 'Enter a whole number of seconds, 5 or more.',
				},
			},
			{
				name: 'Pull when returning to Obsidian',
				desc: 'Check Google Drive for changes when the app comes back to the foreground.',
				control: {
					type: 'toggle',
					key: 'pullOnResume',
					defaultValue: true,
				},
			},
			{
				name: 'Sync settings and plugins',
				desc: 'Also sync the configuration folder (appearance, hotkeys, community plugins and their settings). This plugin\'s own sign-in and sync state never leave the device.',
				control: {
					type: 'toggle',
					key: 'syncConfig',
					defaultValue: true,
				},
			},
			{
				name: 'Client ID',
				desc: BUILD_DEFAULTS.clientId
					? 'Leave empty to use the client ID built into this plugin.'
					: 'OAuth client ID of type "Web application" from your Google Cloud project.',
				control: {
					type: 'text',
					key: 'clientId',
					placeholder: BUILD_DEFAULTS.clientId || 'xxxx.apps.googleusercontent.com',
				},
			},
			{
				name: 'Client secret',
				render: (setting) => {
					setting
						.setName('Client secret')
						.setDesc(
							BUILD_DEFAULTS.clientSecret
								? 'Leave empty to use the built-in value. Stored in Obsidian secret storage, not in the vault.'
								: 'Stored in Obsidian secret storage on this device, never in the vault or on Drive.',
						);
					setting.addText((text) => {
						text.inputEl.type = 'password';
						text
							.setPlaceholder(
								getClientSecret(plugin) ? '••••••••' : 'Client secret',
							)
							.onChange((value) => setClientSecret(plugin, value));
					});
				},
			},
			{
				name: 'Redirect URI',
				desc: 'The callback page registered in your OAuth client.',
				control: {
					type: 'text',
					key: 'redirectUri',
					placeholder:
						BUILD_DEFAULTS.redirectUri ||
						'https://<user>.github.io/<repo>/callback.html',
					validate: (value: string) => {
						if (!value) return;
						try {
							if (new URL(value).protocol !== 'https:') {
								return 'The redirect URI must use HTTPS.';
							}
						} catch {
							return 'Enter a valid URL.';
						}
						return;
					},
				},
			},
		];
	}

	async setControlValue(key: string, value: unknown) {
		if (key === 'autoPushDelaySeconds') value = Number(value);
		await super.setControlValue(key, value);
		if (key === 'autoPush') {
			if (value) this.plugin.resumeAutoPushIfNeeded();
			else this.plugin.clearAutoPushTimer();
		}
	}
}
