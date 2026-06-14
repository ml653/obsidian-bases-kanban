/**
 * Helpers for maintaining per-column card order.
 *
 * The persisted shape is `Record<cardOrderKey, string[]>` where each value is
 * an ordered, de-duplicated list of file paths. The list helpers keep the lists
 * unique and prune deleted/renamed files. The card-move functions
 * (`moveCardToColumn`, `reorderCardInColumn`) own the only two ways — outside
 * drag-and-drop — that a card changes column or position; they take an injected
 * context so all DOM/app/prefs access stays the view's responsibility while the
 * ordering logic lives here. All of these run only from explicit ordering
 * events (never from render, which treats the saved order as read-only).
 */

import type { App, BasesEntry, BasesPropertyId } from 'obsidian';
import { parsePropertyId } from 'obsidian';
import { CSS_CLASSES, DATA_ATTRIBUTES, UNCATEGORIZED_LABEL } from '../constants.ts';

export type CardOrders = Record<string, string[]>;

/** Remove duplicate paths, preserving the first occurrence of each. */
export function normalizeList(paths: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const path of paths) {
		if (seen.has(path)) continue;
		seen.add(path);
		out.push(path);
	}
	return out;
}

/**
 * Swap every occurrence of `oldPath` for `newPath` in place (file rename),
 * preserving the card's position. Returns true if anything changed.
 */
export function swapPath(orders: CardOrders, oldPath: string, newPath: string): boolean {
	let changed = false;
	for (const key of Object.keys(orders)) {
		const list = orders[key];
		const idx = list.indexOf(oldPath);
		if (idx !== -1) {
			list[idx] = newPath;
			changed = true;
		}
	}
	return changed;
}

/**
 * Remove every occurrence of `path` from all column lists (file delete).
 * Returns true if anything changed.
 */
export function removePath(orders: CardOrders, path: string): boolean {
	let changed = false;
	for (const key of Object.keys(orders)) {
		const list = orders[key];
		const idx = list.indexOf(path);
		if (idx !== -1) {
			list.splice(idx, 1);
			changed = true;
		}
	}
	return changed;
}

/**
 * Move `path` to the front of the column identified by `key`, guaranteeing
 * global uniqueness: the path is first removed from every column (including the
 * destination) so it can never end up listed in two columns at once. Used by
 * the create and keyboard-move events.
 */
export function moveToFront(orders: CardOrders, key: string, path: string): void {
	removePath(orders, path);
	orders[key] = [path, ...(orders[key] ?? [])];
}

/**
 * Find which column a path is currently listed in and at what index.
 * Returns `{ column: null, index: -1 }` when the path is not present anywhere.
 * Used only for diagnostic before/after logging.
 */
function locatePath(orders: CardOrders, path: string): { column: string | null; index: number } {
	for (const [column, list] of Object.entries(orders)) {
		const index = list.indexOf(path);
		if (index !== -1) return { column, index };
	}
	return { column: null, index: -1 };
}

/**
 * Everything the card-move functions need from the view. Keeping DOM/app/prefs
 * access behind this seam lets the move logic live here without `cardOrder.ts`
 * depending on the KanbanView class.
 */
export interface CardMoveContext {
	app: App | undefined;
	/** Active group-by property id, or null when none is selected. */
	prefsPropertyId: BasesPropertyId | null;
	/** The live `_prefs.cardOrders` object (mutated in place). */
	cardOrders: CardOrders;
	/** Path → live BasesEntry lookup. */
	entryMap: Map<string, BasesEntry>;
	/** Build the storage key for a (swimlane, column) cell. */
	cardOrderKey: (swimlaneValue: string | null, columnValue: string) => string;
	/** Locate a card element in the DOM by entry path. */
	findCardEl: (path: string) => HTMLElement | null;
	/** Normalize + write `cardOrders` (and the rest of prefs) to the .base. */
	persistPrefs: () => void;
	/** Remember which card to refocus after the write-triggered re-render. */
	setKeyboardFocusPath: (path: string | null) => void;
	/** Force a re-render (used to roll the board back on write failure). */
	rerender: () => void;
}

/**
 * Move a card to a different column by updating its group-by frontmatter
 * property. Used by keyboard navigation (Cmd/Ctrl + Left/Right).
 *
 * Writes the filesystem twice: the destination order to the .base (via
 * persistPrefs) and the note's frontmatter (the group property).
 */
export async function moveCardToColumn(ctx: CardMoveContext, entryPath: string, newColumnValue: string): Promise<void> {
	if (!ctx.prefsPropertyId || !ctx.app?.fileManager) return;
	const entry = ctx.entryMap.get(entryPath);
	if (!entry) return;

	// Capture before-state for diagnostics.
	const cardEl = ctx.findCardEl(entryPath);
	const before = locatePath(ctx.cardOrders, entryPath);

	// Preserve focus on this card after the re-render triggered by the write.
	ctx.setKeyboardFocusPath(entryPath);

	// Prepend to the destination column's saved order (removing it from its old
	// column first, so it never ends up listed in two columns) and persist now —
	// an explicit ordering event, not a render-time write.
	const newKey = ctx.cardOrderKey(null, newColumnValue);
	moveToFront(ctx.cardOrders, newKey, entryPath);
	const after = locatePath(ctx.cardOrders, entryPath);

	// eslint-disable-next-line obsidianmd/rule-custom-message -- temporary debug logging
	console.log('[obk] moveCardToColumn', {
		cardFilename: entry.file.basename,
		attributeFilename: cardEl?.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH) ?? entryPath,
		columnBefore: before.column,
		columnAfter: after.column,
		indexBefore: before.index,
		indexAfter: after.index,
	});

	ctx.persistPrefs();

	const columnPropertyName = parsePropertyId(ctx.prefsPropertyId).name;
	const columnValueToSet = newColumnValue === UNCATEGORIZED_LABEL ? '' : newColumnValue;

	try {
		await ctx.app.fileManager.processFrontMatter(entry.file, (frontmatter: Record<string, unknown>) => {
			if (columnValueToSet === '') {
				delete frontmatter[columnPropertyName];
			} else {
				frontmatter[columnPropertyName] = columnValueToSet;
			}
		});
	} catch (error) {
		console.error('Error moving card via keyboard:', error);
		ctx.rerender();
	}
}

/**
 * Reorder a card up or down within its column via keyboard (Cmd/Ctrl+Up/Down).
 * Updates the DOM immediately and persists the new card order to the .base.
 */
export function reorderCardInColumn(
	ctx: CardMoveContext,
	entryPath: string,
	columnValue: string,
	swimlaneValue: string | null,
	direction: 'up' | 'down',
): void {
	const cardEl = ctx.findCardEl(entryPath);
	if (!cardEl) return;

	const columnEl = cardEl.closest<HTMLElement>(`.${CSS_CLASSES.COLUMN}`);
	if (!columnEl) return;

	const body = columnEl.querySelector<HTMLElement>(`.${CSS_CLASSES.COLUMN_BODY}`);
	if (!body) return;

	const cards = Array.from(body.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.CARD}`));
	const idx = cards.indexOf(cardEl);
	if (idx === -1) return;

	const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
	if (targetIdx < 0 || targetIdx >= cards.length) return;

	const sibling = cards[targetIdx];

	// Swap in DOM
	if (direction === 'up') {
		body.insertBefore(cardEl, sibling);
	} else {
		body.insertBefore(cardEl, sibling.nextSibling);
	}

	// Persist the new order
	ctx.setKeyboardFocusPath(entryPath);
	const newOrder = Array.from(body.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.CARD}`))
		.map((c) => c.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH))
		.filter((p): p is string => p !== null);

	// eslint-disable-next-line obsidianmd/rule-custom-message -- temporary debug logging
	console.log('[obk] reorderCardInColumn', {
		cardFilename: ctx.entryMap.get(entryPath)?.file.basename ?? entryPath,
		attributeFilename: cardEl.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH) ?? entryPath,
		columnBefore: columnValue,
		columnAfter: columnValue,
		indexBefore: idx,
		indexAfter: newOrder.indexOf(entryPath),
	});

	ctx.cardOrders[ctx.cardOrderKey(swimlaneValue, columnValue)] = newOrder;
	ctx.persistPrefs();

	// Re-focus immediately since we moved the DOM node (focus stays on the element)
	cardEl.focus({ preventScroll: true });
	cardEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
