import type { BasesEntry } from 'obsidian';
import { COLOR_PALETTE, CSS_CLASSES, DATA_ATTRIBUTES } from '../constants.ts';
import { createCard, computeCardFingerprint, type CardRenderCtx, type CardCallbacks } from './card.ts';

export interface ColumnRenderCtx {
	doc: Document;
	card: CardRenderCtx;
	cardCb: CardCallbacks;
	prefs: { columnColors: Record<string, string>; hiddenColumns: Set<string> };
	dragging: boolean;
	cardFingerprints: Map<string, string>;
}

export interface ColumnCallbacks {
	applyColumnColor: (columnEl: HTMLElement, colorName: string | null) => void;
	onColorPickerClick: (anchorEl: HTMLElement, columnEl: HTMLElement, columnValue: string) => void;
	onRemoveColumn: (columnValue: string, columnEl: HTMLElement) => void;
	onToggleColumnHidden: (columnValue: string, hidden: boolean) => void;
}

export function applyColumnColor(columnEl: HTMLElement, colorName: string | null): void {
	if (!colorName) {
		columnEl.style.removeProperty('--obk-column-accent-color');
		columnEl.removeAttribute(DATA_ATTRIBUTES.COLUMN_COLOR);
		return;
	}
	const cssVar = COLOR_PALETTE.find((c) => c.name === colorName)?.cssVar ?? null;
	if (!cssVar) {
		columnEl.style.removeProperty('--obk-column-accent-color');
		columnEl.removeAttribute(DATA_ATTRIBUTES.COLUMN_COLOR);
		return;
	}
	columnEl.style.setProperty('--obk-column-accent-color', cssVar);
	columnEl.setAttribute(DATA_ATTRIBUTES.COLUMN_COLOR, colorName);
}

function createHideButton(doc: Document, value: string, cb: ColumnCallbacks): HTMLElement {
	const btn = doc.createElement('div');
	btn.className = CSS_CLASSES.COLUMN_MENU_BTN;
	btn.setAttribute('aria-label', `Hide column: ${value}`);
	btn.setAttribute('role', 'button');
	btn.setAttribute('tabindex', '-1');
	btn.textContent = '\u2212'; // − minus sign
	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		cb.onToggleColumnHidden(value, true);
	});
	return btn;
}

function createUnhideButton(doc: Document, value: string, cb: ColumnCallbacks): HTMLElement {
	const btn = doc.createElement('div');
	btn.className = CSS_CLASSES.COLUMN_UNHIDE_BTN;
	btn.setAttribute('aria-label', `Show column: ${value}`);
	btn.setAttribute('role', 'button');
	btn.setAttribute('tabindex', '-1');
	btn.textContent = '+'; // + plus sign
	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		cb.onToggleColumnHidden(value, false);
	});
	return btn;
}

export function createRemoveButton(doc: Document, value: string, onRemove: () => void): HTMLElement {
	const btn = doc.createElement('div');
	btn.className = CSS_CLASSES.COLUMN_REMOVE_BTN;
	btn.setAttribute('aria-label', `Remove column: ${value}`);
	btn.setAttribute('role', 'button');
	btn.textContent = '×';
	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		onRemove();
	});
	return btn;
}

export function createColumn(
	value: string,
	entries: BasesEntry[],
	options: { showRemoveButton?: boolean; swimlaneValue?: string | null },
	ctx: ColumnRenderCtx,
	cb: ColumnCallbacks,
): HTMLElement {
	const columnEl = ctx.doc.createElement('div');
	columnEl.className = CSS_CLASSES.COLUMN;
	columnEl.setAttribute(DATA_ATTRIBUTES.COLUMN_VALUE, value);

	const isHidden = ctx.prefs.hiddenColumns.has(value);
	if (isHidden) {
		columnEl.classList.add(CSS_CLASSES.COLUMN_HIDDEN);
		columnEl.setAttribute(DATA_ATTRIBUTES.COLUMN_HIDDEN, 'true');
	}

	const colorName = ctx.prefs.columnColors[value] ?? null;
	cb.applyColumnColor(columnEl, colorName);

	const headerEl = columnEl.createDiv({ cls: CSS_CLASSES.COLUMN_HEADER });

	if (isHidden) {
		headerEl.createSpan({ text: value, cls: CSS_CLASSES.COLUMN_TITLE });
		headerEl.appendChild(createUnhideButton(ctx.doc, value, cb));
	} else {
		const dragHandle = headerEl.createDiv({ cls: CSS_CLASSES.COLUMN_DRAG_HANDLE });
		dragHandle.textContent = '⋮⋮';

		const colorBtn = headerEl.createDiv({ cls: CSS_CLASSES.COLUMN_COLOR_BTN });
		colorBtn.setAttribute('aria-label', `Set color for column: ${value}`);
		colorBtn.setAttribute('role', 'button');
		colorBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			cb.onColorPickerClick(colorBtn, columnEl, value);
		});

		headerEl.createSpan({ text: value, cls: CSS_CLASSES.COLUMN_TITLE });
		headerEl.createSpan({ text: `${entries.length}`, cls: CSS_CLASSES.COLUMN_COUNT });

		if (entries.length === 0 && options.showRemoveButton !== false) {
			headerEl.appendChild(createRemoveButton(ctx.doc, value, () => cb.onRemoveColumn(value, columnEl)));
		}

		headerEl.appendChild(createHideButton(ctx.doc, value, cb));

		const bodyEl = columnEl.createDiv({ cls: CSS_CLASSES.COLUMN_BODY });
		bodyEl.setAttribute(DATA_ATTRIBUTES.SORTABLE_CONTAINER, 'true');

		entries.forEach((entry) => {
			bodyEl.appendChild(createCard(entry, ctx.card, ctx.cardCb));
		});
	}

	return columnEl;
}

export function patchColumnCards(
	columnEl: HTMLElement,
	newEntries: BasesEntry[],
	ctx: ColumnRenderCtx,
	cb: ColumnCallbacks,
): void {
	const body = columnEl.querySelector<HTMLElement>(`.${CSS_CLASSES.COLUMN_BODY}`);
	if (!body) return;

	const countEl = columnEl.querySelector(`.${CSS_CLASSES.COLUMN_COUNT}`);
	if (countEl) countEl.textContent = `${newEntries.length}`;

	const headerEl = columnEl.querySelector<HTMLElement>(`.${CSS_CLASSES.COLUMN_HEADER}`);
	const columnValue = columnEl.getAttribute(DATA_ATTRIBUTES.COLUMN_VALUE);
	const existingRemoveBtn = headerEl?.querySelector(`.${CSS_CLASSES.COLUMN_REMOVE_BTN}`) ?? null;
	const isInSwimlane = !!columnEl.closest(`.${CSS_CLASSES.SWIMLANE}`);
	if (headerEl && newEntries.length === 0 && !existingRemoveBtn && columnValue && !isInSwimlane) {
		// Insert remove button before the hide button
		const hideBtn = headerEl.querySelector(`.${CSS_CLASSES.COLUMN_MENU_BTN}`);
		const removeBtn = createRemoveButton(ctx.doc, columnValue, () => cb.onRemoveColumn(columnValue, columnEl));
		if (hideBtn) headerEl.insertBefore(removeBtn, hideBtn);
		else headerEl.appendChild(removeBtn);
	} else if (newEntries.length > 0 && existingRemoveBtn) {
		existingRemoveBtn.remove();
	}

	const newPaths = new Set(newEntries.map((e) => e.file.path));
	body.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.CARD}`).forEach((card) => {
		const path = card.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH);
		if (path && !newPaths.has(path)) card.remove();
	});

	const existingCards = new Map<string, HTMLElement>();
	body.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.CARD}`).forEach((card) => {
		const path = card.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH);
		if (path) existingCards.set(path, card);
	});
	newEntries.forEach((entry) => {
		const fp = computeCardFingerprint(entry, ctx.card);
		const existing = existingCards.get(entry.file.path);
		if (existing && ctx.cardFingerprints.get(entry.file.path) === fp) {
			return;
		}
		const newCard = createCard(entry, ctx.card, ctx.cardCb);
		ctx.cardFingerprints.set(entry.file.path, fp);
		if (existing) {
			body.replaceChild(newCard, existing);
		} else {
			body.appendChild(newCard);
		}
	});

	if (!ctx.dragging) {
		const pathToCard = new Map<string, Element>();
		body.querySelectorAll(`.${CSS_CLASSES.CARD}`).forEach((card) => {
			const path = card.instanceOf(HTMLElement) ? card.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH) : null;
			if (path) pathToCard.set(path, card);
		});
		newEntries.forEach((entry) => {
			const card = pathToCard.get(entry.file.path);
			if (card) body.appendChild(card);
		});
	}
}
