import type { App, BasesEntry, BasesPropertyId } from 'obsidian';
import { Keymap, NullValue } from 'obsidian';
import type { TFile } from 'obsidian';
import { CSS_CLASSES, DATA_ATTRIBUTES } from '../constants.ts';

export interface CardRenderCtx {
	app: App;
	doc: Document;
	groupByPropertyId: BasesPropertyId | null;
	cardTitlePropertyId: BasesPropertyId | null;
	imagePropertyId: BasesPropertyId | null;
	imageFit: string;
	imageAspectRatio: number;
	wrapValues: boolean;
	order: BasesPropertyId[];
	getDisplayName: (id: BasesPropertyId) => string;
}

export interface CardCallbacks {
	onHoverPreview: (linktext: string, sourcePath: string, event: MouseEvent, targetEl: HTMLElement) => void;
	onSetActiveCard: (path: string | null) => void;
	onOpenInBackgroundTab: (file: TFile) => void;
	onFocusCard: (path: string) => void;
	onRenameCard: (file: TFile, newName: string) => Promise<void>;
}

export function computeCardFingerprint(entry: BasesEntry, ctx: CardRenderCtx): string {
	const parts: string[] = [];
	for (const propId of ctx.order) {
		if (propId === ctx.groupByPropertyId) continue;
		const val = entry.getValue(propId);
		parts.push(val === null ? '' : val.toString());
	}
	if (ctx.cardTitlePropertyId) {
		const val = entry.getValue(ctx.cardTitlePropertyId);
		parts.push(val === null ? '' : val.toString());
	}
	if (ctx.imagePropertyId) {
		const val = entry.getValue(ctx.imagePropertyId);
		parts.push(val === null ? '' : val.toString());
	}
	return parts.join('\x00');
}

export function renderCardTitle(titleEl: HTMLElement, entry: BasesEntry, ctx: CardRenderCtx): void {
	if (!ctx.cardTitlePropertyId) {
		titleEl.textContent = entry.file.basename;
		return;
	}
	const titleValue = entry.getValue(ctx.cardTitlePropertyId);
	if (!titleValue || titleValue instanceof NullValue) {
		titleEl.textContent = entry.file.basename;
		return;
	}
	titleValue.renderTo(titleEl, ctx.app.renderContext);
}

export function renderCardCover(
	coverEl: HTMLElement,
	entry: BasesEntry,
	filePath: string,
	ctx: CardRenderCtx,
): boolean {
	if (!ctx.imagePropertyId) return false;
	const value = entry.getValue(ctx.imagePropertyId);
	if (!value || value instanceof NullValue) return false;
	const raw = value.toString().trim();
	if (!raw) return false;

	if (/^https?:\/\//i.test(raw)) {
		coverEl.createEl('img', { attr: { src: raw, alt: '' } });
		return true;
	}

	let linkText = raw.replace(/^!\s*/, '');
	const wikiMatch = linkText.match(/^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/);
	if (wikiMatch) linkText = wikiMatch[1];
	linkText = linkText.trim();
	if (!linkText) return false;

	const app = ctx.app;
	if (!app) return false;
	const file = app.metadataCache.getFirstLinkpathDest(linkText, filePath);
	if (!file) return false;

	coverEl.createEl('img', {
		attr: { src: app.vault.getResourcePath(file), alt: '' },
	});
	return true;
}

export function createCard(entry: BasesEntry, ctx: CardRenderCtx, cb: CardCallbacks): HTMLElement {
	const cardEl = ctx.doc.createElement('div');
	cardEl.className = CSS_CLASSES.CARD;
	const filePath = entry.file.path;
	cardEl.setAttribute(DATA_ATTRIBUTES.ENTRY_PATH, filePath);
	cardEl.setAttribute('tabindex', '0');
	cardEl.addEventListener('focus', () => cb.onFocusCard(filePath));

	if (ctx.imagePropertyId) {
		const coverEl = cardEl.createDiv({ cls: CSS_CLASSES.CARD_COVER });
		coverEl.classList.add(
			ctx.imageFit === 'contain' ? CSS_CLASSES.CARD_COVER_FIT_CONTAIN : CSS_CLASSES.CARD_COVER_FIT_COVER,
		);
		coverEl.style.aspectRatio = `1 / ${ctx.imageAspectRatio}`;
		const rendered = renderCardCover(coverEl, entry, filePath, ctx);
		if (!rendered) coverEl.remove();
	}

	const titleEl = cardEl.createDiv({ cls: CSS_CLASSES.CARD_TITLE });
	renderCardTitle(titleEl, entry, ctx);

	// Pencil button — opens the note (click on card body does inline edit)
	const editBtn = cardEl.createDiv({ cls: CSS_CLASSES.CARD_EDIT_BTN });
	editBtn.setAttribute('aria-label', 'Open note');
	editBtn.setAttribute('role', 'button');
	editBtn.setAttribute('tabindex', '-1');
	editBtn.textContent = '✎';

	editBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		e.preventDefault();
		if (!ctx.app?.workspace) return;
		void ctx.app.workspace.openLinkText(filePath, '', false);
	});
	editBtn.addEventListener('mousedown', (e) => e.preventDefault());

	let isEditing = false;

	const startEditing = (e: Event) => {
		if (isEditing) return;
		e.stopPropagation();
		e.preventDefault();
		isEditing = true;

		const currentTitle = titleEl.textContent ?? entry.file.basename;
		cardEl.classList.add(CSS_CLASSES.CARD_EDITING);

		const input = cardEl.doc.createElement('input');
		input.type = 'text';
		input.className = CSS_CLASSES.CARD_TITLE_INPUT;
		input.value = currentTitle;
		titleEl.insertAdjacentElement('afterend', input);
		input.focus();
		input.select();

		const finish = () => {
			if (!isEditing) return;
			isEditing = false;
			input.remove();
			cardEl.classList.remove(CSS_CLASSES.CARD_EDITING);
			cardEl.focus({ preventScroll: true });
		};

		const commit = async () => {
			const newName = input.value.trim();
			finish();
			if (newName && newName !== entry.file.basename) {
				await cb.onRenameCard(entry.file, newName);
			}
		};

		input.addEventListener('keydown', (ke) => {
			if (ke.key === 'Enter') {
				ke.preventDefault();
				void commit();
			} else if (ke.key === 'Escape') {
				ke.preventDefault();
				finish();
			}
			ke.stopPropagation();
		});
		input.addEventListener('blur', () => void commit());
	};

	for (const propertyId of ctx.order) {
		if (propertyId === ctx.groupByPropertyId) continue;
		const value = entry.getValue(propertyId);
		if (!value || value instanceof NullValue) continue;
		if (!value.toString().trim()) continue;
		const label = ctx.getDisplayName(propertyId);
		const propertyEl = cardEl.createDiv({ cls: CSS_CLASSES.CARD_PROPERTY });
		propertyEl.setAttribute('data-label', propertyId);
		if (ctx.wrapValues) {
			propertyEl.classList.add(CSS_CLASSES.CARD_PROPERTY_WRAP);
		}
		propertyEl.createSpan({ text: label, cls: CSS_CLASSES.CARD_PROPERTY_LABEL });
		const valueEl = propertyEl.createSpan({ cls: CSS_CLASSES.CARD_PROPERTY_VALUE });
		value.renderTo(valueEl, ctx.app.renderContext);
	}

	// JS-managed hover: mouseenter/mouseleave instead of CSS :hover so the
	// class is never applied when an element slides under a stationary cursor
	// after a drag reorders the DOM.
	cardEl.addEventListener('mouseenter', () => cardEl.classList.add(CSS_CLASSES.CARD_HOVER));
	cardEl.addEventListener('mouseleave', () => cardEl.classList.remove(CSS_CLASSES.CARD_HOVER));
	cardEl.addEventListener('mouseover', (e) => {
		if (e.target instanceof Element && e.target.closest('a')) return;
		if (e.relatedTarget instanceof Element && cardEl.contains(e.relatedTarget)) return;
		cb.onHoverPreview(filePath, '', e, cardEl);
	});

	const clickHandler = (e: MouseEvent) => {
		if (e.target instanceof Element && e.target.closest('a')) return;
		if (e.target instanceof Element && e.target.closest(`.${CSS_CLASSES.CARD_EDIT_BTN}`)) return;
		if (e.target instanceof Element && e.target.closest(`.${CSS_CLASSES.CARD_TITLE_INPUT}`)) return;
		if (e.type === 'auxclick' && e.button !== 1) return;
		cb.onSetActiveCard(filePath);
		if (!ctx.app?.workspace) return;
		// Middle-click → open in background tab
		if (e.button === 1) {
			cb.onOpenInBackgroundTab(entry.file);
			return;
		}
		// Cmd/Ctrl+click → open note in new tab
		if (Keymap.isModEvent(e)) {
			void ctx.app.workspace.openLinkText(filePath, '', true);
			return;
		}
		// Regular left-click → inline title edit
		startEditing(e);
	};
	cardEl.addEventListener('click', clickHandler);
	cardEl.addEventListener('auxclick', clickHandler);

	// Prevent middle-click autoscroll inside cards.
	cardEl.addEventListener('mousedown', (e) => {
		if (e.button !== 1) return;
		if (e.target instanceof Element && e.target.closest('a')) return;
		e.preventDefault();
	});

	return cardEl;
}
