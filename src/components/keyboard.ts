import { Notice } from 'obsidian';
import { CSS_CLASSES, DATA_ATTRIBUTES, UNCATEGORIZED_LABEL } from '../constants.ts';

// ─── DOM helpers ─────────────────────────────────────────────────────────────

/** All card elements inside a column, in DOM order. */
function getColumnCards(columnEl: HTMLElement): HTMLElement[] {
	return Array.from(columnEl.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.CARD}`));
}

/** All column elements on the board (across swimlanes if present), in DOM order. */
function getBoardColumns(boardEl: HTMLElement): HTMLElement[] {
	return Array.from(boardEl.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.COLUMN}`));
}

/** Return the column that directly contains `cardEl`. */
function getParentColumn(cardEl: HTMLElement): HTMLElement | null {
	return cardEl.closest<HTMLElement>(`.${CSS_CLASSES.COLUMN}`) ?? null;
}

/** Column display name: prefer the title span text, fall back to data attribute. */
function getColumnTitle(columnEl: HTMLElement): string {
	return (
		columnEl.querySelector<HTMLElement>(`.${CSS_CLASSES.COLUMN_TITLE}`)?.textContent?.trim() ??
		columnEl.getAttribute(DATA_ATTRIBUTES.COLUMN_VALUE) ??
		'column'
	);
}

/** Focus a card and scroll it into view. */
function focusCard(cardEl: HTMLElement): void {
	cardEl.focus({ preventScroll: true });
	cardEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ─── Navigation ───────────────────────────────────────────────────────────────

/**
 * Move keyboard focus to the card above or below within the same column.
 * Returns true if handled.
 */
export function navigateVertical(cardEl: HTMLElement, direction: 'up' | 'down'): boolean {
	const columnEl = getParentColumn(cardEl);
	if (!columnEl) return false;

	const cards = getColumnCards(columnEl);
	const idx = cards.indexOf(cardEl);
	if (idx === -1) return false;

	const next = direction === 'up' ? cards[idx - 1] : cards[idx + 1];
	if (!next) return false;

	focusCard(next);
	return true;
}

/**
 * Move keyboard focus to the same-index card in the nearest non-empty column
 * in the given direction, skipping over empty columns.
 * Falls back to the last card if the target column has fewer cards.
 * Returns true if handled.
 */
export function navigateHorizontal(cardEl: HTMLElement, boardEl: HTMLElement, direction: 'left' | 'right'): boolean {
	const columnEl = getParentColumn(cardEl);
	if (!columnEl) return false;

	const columns = getBoardColumns(boardEl);
	const colIdx = columns.indexOf(columnEl);
	if (colIdx === -1) return false;

	const step = direction === 'left' ? -1 : 1;
	let targetColumn: HTMLElement | null = null;
	let i = colIdx + step;
	while (i >= 0 && i < columns.length) {
		const cards = getColumnCards(columns[i]);
		if (cards.length > 0) {
			targetColumn = columns[i];
			break;
		}
		i += step;
	}
	if (!targetColumn) return false;

	const targetCards = getColumnCards(targetColumn);
	const currentIdx = getColumnCards(columnEl).indexOf(cardEl);
	focusCard(targetCards[Math.min(currentIdx, targetCards.length - 1)]);
	return true;
}

// ─── Card move ────────────────────────────────────────────────────────────────

export interface KeyboardMoveCallbacks {
	moveCardToColumn: (entryPath: string, newColumnValue: string) => Promise<void>;
	reorderCardInColumn: (
		entryPath: string,
		columnValue: string,
		swimlaneValue: string | null,
		direction: 'up' | 'down',
	) => void;
	deleteCard: (entryPath: string, focusPath: string | null) => Promise<void>;
	openQuickAddForColumn: (columnValue: string, swimlaneValue: string | null) => void;
	openCardInPopout: (entryPath: string) => void;
}

/**
 * Move the focused card up or down within its column (Cmd/Ctrl + Up/Down).
 * Swaps it with the adjacent card and persists the new order.
 * Returns true if handled.
 */
export function moveCardVertical(cardEl: HTMLElement, direction: 'up' | 'down', cb: KeyboardMoveCallbacks): boolean {
	const columnEl = getParentColumn(cardEl);
	if (!columnEl) return false;

	const cards = getColumnCards(columnEl);
	const idx = cards.indexOf(cardEl);
	if (idx === -1) return false;

	const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
	if (targetIdx < 0 || targetIdx >= cards.length) return false;

	const entryPath = cardEl.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH);
	if (!entryPath) return false;

	const columnValue = columnEl.getAttribute(DATA_ATTRIBUTES.COLUMN_VALUE);
	if (!columnValue) return false;

	const swimlaneEl = columnEl.closest<HTMLElement>(`[${DATA_ATTRIBUTES.SWIMLANE_VALUE}]`);
	const swimlaneValue = swimlaneEl?.getAttribute(DATA_ATTRIBUTES.SWIMLANE_VALUE) ?? null;

	cb.reorderCardInColumn(entryPath, columnValue, swimlaneValue, direction);
	return true;
}

/**
 * Move the focused card into the adjacent column (Cmd/Ctrl + Arrow).
 * Shows a Notice on success.  Returns true if the move was initiated.
 */
export function moveCardHorizontal(
	cardEl: HTMLElement,
	boardEl: HTMLElement,
	direction: 'left' | 'right',
	cb: KeyboardMoveCallbacks,
): boolean {
	const columnEl = getParentColumn(cardEl);
	if (!columnEl) return false;

	const columns = getBoardColumns(boardEl);
	const colIdx = columns.indexOf(columnEl);
	if (colIdx === -1) return false;

	const targetColumn = columns[direction === 'left' ? colIdx - 1 : colIdx + 1];
	if (!targetColumn) return false;

	const entryPath = cardEl.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH);
	if (!entryPath) return false;

	const newColumnValue = targetColumn.getAttribute(DATA_ATTRIBUTES.COLUMN_VALUE);
	if (!newColumnValue) return false;

	const targetTitle = newColumnValue === UNCATEGORIZED_LABEL ? 'Uncategorized' : getColumnTitle(targetColumn);

	void cb.moveCardToColumn(entryPath, newColumnValue).then(() => {
		new Notice(`Moved to "${targetTitle}"`);
	});

	return true;
}

/**
 * Trash the focused card (Ctrl+Delete).
 * Moves focus to the next card in the column, or the previous if it was last.
 */
export function deleteCard(cardEl: HTMLElement, cb: KeyboardMoveCallbacks): boolean {
	const columnEl = getParentColumn(cardEl);
	if (!columnEl) return false;

	const entryPath = cardEl.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH);
	if (!entryPath) return false;

	// Determine which card to focus after deletion.
	const cards = getColumnCards(columnEl);
	const idx = cards.indexOf(cardEl);
	const nextFocus = cards[idx + 1] ?? cards[idx - 1] ?? null;
	const nextFocusPath = nextFocus?.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH) ?? null;

	void cb.deleteCard(entryPath, nextFocusPath);
	return true;
}

// ─── Board-level keydown handler ──────────────────────────────────────────────

/**
 * Handle a keydown event bubbled up to the board container.
 *
 * Key bindings:
 *   ArrowUp / ArrowDown         → focus previous / next card in the same column
 *   ArrowLeft / ArrowRight      → focus same-index card in the adjacent column
 *   Cmd/Ctrl + ArrowLeft/Right  → move the card itself to the adjacent column
 */
export function handleBoardKeydown(e: KeyboardEvent, boardEl: HTMLElement, cb: KeyboardMoveCallbacks): void {
	const isMod = e.metaKey || e.ctrlKey;
	// Resolve the event target — must be an Element to support `.closest`.
	if (!(e.target instanceof Element)) return;
	const target = e.target;
	const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

	// Enter — start inline title edit on the focused card (not while already editing).
	if (e.key === 'Enter' && !isInput && !isMod) {
		const cardEl = target.closest<HTMLElement>(`.${CSS_CLASSES.CARD}`);
		if (cardEl) {
			e.preventDefault();
			cardEl.dispatchEvent(new Event('obk:start-edit'));
		}
		return;
	}

	// Ctrl/Cmd+e — open focused card in a new tab.
	if (e.key === 'e' && isMod) {
		const cardEl = target.closest<HTMLElement>(`.${CSS_CLASSES.CARD}`);
		if (cardEl) {
			const entryPath = cardEl.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH);
			if (entryPath) {
				e.preventDefault();
				cb.openCardInPopout(entryPath);
			}
		}
		return;
	}

	// Ctrl+Delete / Ctrl+Backspace — trash the focused card.
	if ((e.key === 'Delete' || e.key === 'Backspace') && isMod) {
		if (isInput) return;
		const cardEl = target.closest<HTMLElement>(`.${CSS_CLASSES.CARD}`);
		if (!cardEl) return;
		e.preventDefault();
		deleteCard(cardEl, cb);
		return;
	}

	// Ctrl+A — open quick-add for the focused card's column (or the first column).
	if (e.key === 'a' && isMod) {
		// Let the browser handle select-all when focus is inside an input.
		if (isInput) return;
		const cardEl = target.closest<HTMLElement>(`.${CSS_CLASSES.CARD}`);
		const columnEl = cardEl ? getParentColumn(cardEl) : boardEl.querySelector<HTMLElement>(`.${CSS_CLASSES.COLUMN}`);
		if (!columnEl) return;
		const columnValue = columnEl.getAttribute(DATA_ATTRIBUTES.COLUMN_VALUE);
		if (!columnValue) return;
		const swimlaneEl = columnEl.closest<HTMLElement>(`[${DATA_ATTRIBUTES.SWIMLANE_VALUE}]`);
		const swimlaneValue = swimlaneEl?.getAttribute(DATA_ATTRIBUTES.SWIMLANE_VALUE) ?? null;
		e.preventDefault();
		cb.openQuickAddForColumn(columnValue, swimlaneValue);
		return;
	}

	if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;

	// Arrow key navigation — only when a card is focused (not an input).
	if (isInput) return;
	const cardEl = target.closest<HTMLElement>(`.${CSS_CLASSES.CARD}`);
	if (!cardEl) return;

	// Prevent the scroll containers (column body, board) from scrolling on arrow keys.
	e.preventDefault();

	if (e.key === 'ArrowUp') {
		if (isMod) {
			moveCardVertical(cardEl, 'up', cb);
		} else {
			navigateVertical(cardEl, 'up');
		}
	} else if (e.key === 'ArrowDown') {
		if (isMod) {
			moveCardVertical(cardEl, 'down', cb);
		} else {
			navigateVertical(cardEl, 'down');
		}
	} else if (e.key === 'ArrowLeft') {
		if (isMod) {
			moveCardHorizontal(cardEl, boardEl, 'left', cb);
		} else {
			navigateHorizontal(cardEl, boardEl, 'left');
		}
	} else if (e.key === 'ArrowRight') {
		if (isMod) {
			moveCardHorizontal(cardEl, boardEl, 'right', cb);
		} else {
			navigateHorizontal(cardEl, boardEl, 'right');
		}
	}
}
