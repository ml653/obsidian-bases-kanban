import type { App } from 'obsidian';
import { Modal, TextComponent } from 'obsidian';
import { CSS_CLASSES } from './constants.ts';

export interface QuickAddModalOptions {
	columnValue: string;
	swimlaneValue: string | null;
	onSubmit: (title: string) => Promise<void> | void;
	onClose?: () => void;
}

export class QuickAddModal extends Modal {
	private input: TextComponent | null = null;
	private submitting = false;

	constructor(
		app: App,
		private readonly options: QuickAddModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		const { columnValue, swimlaneValue } = this.options;
		this.modalEl.classList.add(CSS_CLASSES.QUICK_ADD_MODAL);
		this.setTitle('Add card');

		const formEl = this.contentEl.createEl('form', { cls: CSS_CLASSES.QUICK_ADD_FORM });

		// Destination context: show which lane / column the card lands in.
		const destEl = formEl.createDiv({ cls: CSS_CLASSES.QUICK_ADD_DESTINATION });
		destEl.createSpan({ text: 'Adding to', cls: CSS_CLASSES.QUICK_ADD_DESTINATION_LABEL });
		if (swimlaneValue) {
			destEl.createSpan({ text: swimlaneValue, cls: CSS_CLASSES.QUICK_ADD_DESTINATION_PILL });
			destEl.createSpan({ text: '›', cls: CSS_CLASSES.QUICK_ADD_DESTINATION_SEP });
		}
		destEl.createSpan({ text: columnValue, cls: CSS_CLASSES.QUICK_ADD_DESTINATION_PILL });

		const fieldEl = formEl.createDiv({ cls: CSS_CLASSES.QUICK_ADD_FIELD });
		this.input = new TextComponent(fieldEl);
		this.input.setPlaceholder('Card title');
		this.input.inputEl.classList.add(CSS_CLASSES.QUICK_ADD_INPUT);
		this.input.inputEl.setAttribute('enterkeyhint', 'done');
		this.input.inputEl.setAttribute('autocapitalize', 'sentences');

		const actionsEl = formEl.createDiv({ cls: CSS_CLASSES.QUICK_ADD_ACTIONS });
		const cancelBtn = actionsEl.createEl('button', {
			text: 'Cancel',
			attr: { type: 'button' },
		});
		const submitBtn = actionsEl.createEl('button', {
			text: 'Add card',
			cls: 'mod-cta',
			attr: { type: 'submit' },
		});

		cancelBtn.addEventListener('click', () => this.close());
		formEl.addEventListener('submit', (evt) => {
			evt.preventDefault();
			void this.submit(submitBtn);
		});

		window.requestAnimationFrame(() => this.input?.inputEl.focus());
	}

	onClose(): void {
		this.contentEl.empty();
		this.input = null;
		this.submitting = false;
		this.options.onClose?.();
	}

	private async submit(submitBtn: HTMLButtonElement): Promise<void> {
		if (this.submitting) return;

		const title = this.input?.getValue().trim() ?? '';

		if (!title) {
			this.input?.inputEl.focus();
			return;
		}

		this.submitting = true;
		submitBtn.disabled = true;
		try {
			await this.options.onSubmit(title);
			this.close();
		} catch (error) {
			this.submitting = false;
			submitBtn.disabled = false;
			throw error;
		}
	}
}
