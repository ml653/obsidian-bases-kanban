import type { App } from 'obsidian';
import { Modal } from 'obsidian';

export interface ConfirmModalOptions {
	title: string;
	message: string;
	confirmText?: string;
	cancelText?: string;
	/** Style the confirm button as a destructive action. */
	warning?: boolean;
	onConfirm: () => Promise<void> | void;
}

/**
 * Minimal yes/no confirmation dialog. Used to guard destructive actions such
 * as deleting a card's underlying note.
 */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly options: ConfirmModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		const { title, message, confirmText, cancelText, warning } = this.options;
		this.setTitle(title);
		this.contentEl.createEl('p', { text: message });

		const actionsEl = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const cancelBtn = actionsEl.createEl('button', {
			text: cancelText ?? 'Cancel',
			attr: { type: 'button' },
		});
		const confirmBtn = actionsEl.createEl('button', {
			text: confirmText ?? 'Confirm',
			cls: warning ? 'mod-warning' : 'mod-cta',
			attr: { type: 'button' },
		});

		cancelBtn.addEventListener('click', () => this.close());
		confirmBtn.addEventListener('click', () => {
			this.close();
			void this.options.onConfirm();
		});

		window.requestAnimationFrame(() => confirmBtn.focus());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
