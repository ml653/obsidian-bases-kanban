import type { App, BasesEntry, BasesPropertyId } from 'obsidian';
import { Keymap, Menu, NullValue, setIcon } from 'obsidian';
import type { TFile } from 'obsidian';
import { CSS_CLASSES, DATA_ATTRIBUTES, FILENAME_PROPERTY } from '../constants.ts';

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
	onUpdateFilenameProperty: (file: TFile, newTitle: string) => Promise<void>;
	onDeleteCard: (file: TFile) => void;
	/**
	 * Called when inline title editing begins, with the edit field as argument.
	 * Returns a cleanup function invoked when editing ends. Used on mobile to fit
	 * the board into the space above the soft keyboard and keep the edited field
	 * scrolled into view.
	 */
	onBeginInlineEdit?: (editingEl: HTMLElement) => () => void;
}

export function computeCardFingerprint(entry: BasesEntry, ctx: CardRenderCtx): string {
	const parts: string[] = [];
	for (const propId of ctx.order) {
		if (propId === ctx.groupByPropertyId) continue;
		const val = entry.getValue(propId);
		parts.push(val === null ? '' : val.toString());
	}
	if (ctx.cardTitlePropertyId && !ctx.cardTitlePropertyId.startsWith('file.')) {
		const val = entry.getValue(ctx.cardTitlePropertyId);
		parts.push(val === null ? '' : val.toString());
	}
	// Always include the filename property in the fingerprint — it drives the
	// displayed title whenever no non-file.* cardTitlePropertyId is configured.
	{
		const val = entry.getValue(FILENAME_PROPERTY);
		parts.push(val === null ? '' : val.toString());
	}
	if (ctx.imagePropertyId) {
		const val = entry.getValue(ctx.imagePropertyId);
		parts.push(val === null ? '' : val.toString());
	}
	return parts.join('\x00');
}

/**
 * Resolve the display title for a card.
 *
 * Priority:
 *   1. Explicit cardTitlePropertyId (if set and non-empty, and not a file.*
 *      property whose value would be a raw timestamp basename).
 *   2. The `filename` frontmatter property (human-readable title stored by
 *      quick-add when file names are datetime stamps).
 *   3. Raw file basename as last resort.
 */
export function renderCardTitle(titleEl: HTMLElement, entry: BasesEntry, ctx: CardRenderCtx): void {
	// Helper: get the filename frontmatter value if present and non-empty.
	const filenameText = (): string | null => {
		const v = entry.getValue(FILENAME_PROPERTY);
		if (!v || v instanceof NullValue) return null;
		const t = v.toString().trim();
		return t || null;
	};

	if (!ctx.cardTitlePropertyId) {
		titleEl.textContent = filenameText() ?? entry.file.basename;
		return;
	}

	// file.* properties (e.g. file.basename, file.name) resolve to the raw OS
	// filename, which may be a datetime stamp. Prefer `filename` frontmatter
	// when available so the human-readable title is shown instead.
	if (ctx.cardTitlePropertyId.startsWith('file.')) {
		titleEl.textContent = filenameText() ?? entry.file.basename;
		return;
	}

	const titleValue = entry.getValue(ctx.cardTitlePropertyId);
	if (!titleValue || titleValue instanceof NullValue) {
		titleEl.textContent = filenameText() ?? entry.file.basename;
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

	let isEditing = false;

	const startEditing = (e: Event) => {
		if (isEditing) return;
		e.stopPropagation();
		e.preventDefault();
		isEditing = true;

		const currentTitle = titleEl.textContent ?? entry.file.basename;
		cardEl.classList.add(CSS_CLASSES.CARD_EDITING);

		const input = cardEl.doc.createElement('textarea');
		input.className = CSS_CLASSES.CARD_TITLE_INPUT;
		input.rows = 1;
		input.value = currentTitle;
		titleEl.insertAdjacentElement('afterend', input);

		// Auto-size the textarea to its content so long titles wrap and the
		// field grows vertically instead of scrolling.
		const autoSize = () => {
			if (typeof input.setCssStyles !== 'function') return;
			input.setCssStyles({ height: 'auto' });
			input.setCssStyles({ height: `${input.scrollHeight}px` });
		};

		input.focus();
		input.select();
		autoSize();

		// On mobile, fit the board above the soft keyboard and keep this field
		// in view so it isn't hidden behind the keyboard (no-op elsewhere).
		// Released in finish().
		const unlockHeight = cb.onBeginInlineEdit?.(input) ?? (() => {});

		const finish = () => {
			if (!isEditing) return;
			isEditing = false;
			unlockHeight();
			input.remove();
			cardEl.classList.remove(CSS_CLASSES.CARD_EDITING);
			cardEl.focus({ preventScroll: true });
		};

		const commit = async () => {
			const newName = input.value.trim();
			finish();
			if (!newName) return;
			// Compare against the displayed title (filename property if present,
			// otherwise the raw basename) so unchanged edits are no-ops.
			const currentTitle = titleEl.textContent?.trim() ?? entry.file.basename;
			if (newName === currentTitle) return;
			await cb.onUpdateFilenameProperty(entry.file, newName);
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
		input.addEventListener('input', autoSize);
		input.addEventListener('blur', () => void commit());
	};

	const openMenu = (anchorEl: HTMLElement, event?: MouseEvent) => {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle('Open note')
				.setIcon('lucide-file-text')
				.onClick(() => {
					if (!ctx.app?.workspace) return;
					void ctx.app.workspace.openLinkText(filePath, '', false);
				}),
		);
		menu.addItem((item) =>
			item
				.setTitle('Edit title')
				.setIcon('lucide-pencil')
				.onClick(() => startEditing(new Event('obk:start-edit'))),
		);
		menu.addItem((item) =>
			item
				.setTitle('Delete')
				.setIcon('lucide-trash-2')
				.setWarning(true)
				.onClick(() => cb.onDeleteCard(entry.file)),
		);

		if (event) {
			menu.showAtMouseEvent(event);
		} else {
			const rect = anchorEl.getBoundingClientRect();
			menu.showAtPosition({ x: rect.left, y: rect.bottom });
		}
	};

	// Overflow menu button — opens an actions menu (open note, edit title, delete)
	const menuBtn = cardEl.createDiv({ cls: CSS_CLASSES.CARD_MENU_BTN });
	menuBtn.setAttribute('aria-label', 'Card actions');
	menuBtn.setAttribute('role', 'button');
	menuBtn.setAttribute('tabindex', '-1');
	setIcon(menuBtn, 'lucide-more-vertical');

	menuBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		e.preventDefault();
		openMenu(menuBtn, e);
	});
	menuBtn.addEventListener('mousedown', (e) => e.preventDefault());

	for (const propertyId of ctx.order) {
		if (propertyId === ctx.groupByPropertyId) continue;
		// filename is used as the card title — suppress it from the property list.
		if (propertyId === FILENAME_PROPERTY) continue;
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
		if (e.target instanceof Element && e.target.closest(`.${CSS_CLASSES.CARD_MENU_BTN}`)) return;
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

	// Allow the keyboard handler to trigger inline editing via a custom event.
	cardEl.addEventListener('obk:start-edit', () => startEditing(new Event('obk:start-edit')));

	// Prevent middle-click autoscroll inside cards.
	cardEl.addEventListener('mousedown', (e) => {
		if (e.button !== 1) return;
		if (e.target instanceof Element && e.target.closest('a')) return;
		e.preventDefault();
	});

	return cardEl;
}
