import type { BasesEntry, BasesPropertyId, HoverPopover, QueryController, ViewOption } from 'obsidian';
import { BasesView, Keymap, Notice, Platform, normalizePath, parsePropertyId } from 'obsidian';
import {
	createCard as createCardEl,
	computeCardFingerprint,
	type CardRenderCtx,
	type CardCallbacks,
} from './components/card.ts';
import {
	createQuickAddCard as createQuickAddCardEl,
	closeNativeNewItemPopover as closeNativeNewItemPopoverEl,
	type QuickAddCtx,
	type QuickAddCallbacks,
} from './components/quickAdd.ts';
import {
	applyColumnColor as applyColumnColorEl,
	createColumn as createColumnEl,
	patchColumnCards as patchColumnCardsEl,
	type ColumnRenderCtx,
	type ColumnCallbacks,
} from './components/column.ts';
import {
	buildSwimlaneElement as buildSwimlaneElementEl,
	updateSwimlaneToggle as updateSwimlaneToggleEl,
	sortSwimlaneValues,
	getOrderedSwimlaneValues as getOrderedSwimlaneValuesEl,
	type RowRenderCtx,
	type RowCallbacks,
} from './components/row.ts';
import { handleBoardKeydown } from './components/keyboard.ts';
import { QuickAddModal } from './quickAddModal.ts';
import { ConfirmModal } from './confirmModal.ts';
import type { TFile } from 'obsidian';
import Sortable from 'sortablejs';
import {
	COLOR_PALETTE,
	CSS_CLASSES,
	DATA_ATTRIBUTES,
	DEBOUNCE_DELAY,
	EMPTY_STATE_MESSAGES,
	HOVER_LINK_SOURCE_ID,
	SORTABLE_CONFIG,
	SORTABLE_GROUP,
	SORTED_CARD_ORDER_NOTICE,
	SWIMLANE_KEY_SEPARATOR,
	UNCATEGORIZED_LABEL,
} from './constants.ts';
import type { DebouncedFn } from './utils/debounce.ts';
import { debounce } from './utils/debounce.ts';
import { ensureGroupExists, normalizePropertyValue } from './utils/grouping.ts';
import {
	type CardMoveContext,
	type CardOrders,
	moveCardToColumn as moveCardToColumnImpl,
	moveToFront,
	normalizeList,
	removePath,
	reorderCardInColumn as reorderCardInColumnImpl,
	swapPath,
} from './utils/cardOrder.ts';

export interface LegacyData {
	columnOrders: Record<string, string[]>;
	columnColors: Record<string, Record<string, string>>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
	return isRecord(value) && !Array.isArray(value) && Object.values(value).every(isStringArray);
}

export function isColumnOrders(value: unknown): value is Record<string, string[]> {
	return isStringArrayRecord(value);
}

export function isColumnColors(value: unknown): value is Record<string, Record<string, string>> {
	return (
		isRecord(value) &&
		Object.values(value).every((v) => isRecord(v) && Object.values(v).every((c) => typeof c === 'string'))
	);
}

export function isCardOrders(value: unknown): value is Record<string, Record<string, string[]>> {
	return (
		isRecord(value) &&
		!Array.isArray(value) &&
		Object.values(value).every((v) => isRecord(v) && !Array.isArray(v) && Object.values(v).every(isStringArray))
	);
}

export function isCollapsedLanes(value: unknown): value is Record<string, string[]> {
	return isStringArrayRecord(value);
}

export class KanbanView extends BasesView {
	type = 'kanban-view';
	hoverPopover: HoverPopover | null = null;

	scrollEl: HTMLElement;
	containerEl: HTMLElement;
	private legacyData: LegacyData | null;
	private groupByPropertyId: BasesPropertyId | null = null;
	private swimlaneByPropertyId: BasesPropertyId | null = null;
	private cardTitlePropertyId: BasesPropertyId | null = null;
	private imagePropertyId: BasesPropertyId | null = null;
	private _columnSortables: Map<string, Sortable> = new Map();
	private _entryMap: Map<string, BasesEntry> = new Map();
	private swimlaneSortable: Sortable | null = null;
	private swimlaneColumnSortables: Map<string | null, Sortable> = new Map();
	private _debouncedRender: DebouncedFn<() => void>;
	private activeColorPicker: HTMLElement | null = null;

	/**
	 * In-memory display preferences — the single source of truth during a session.
	 *
	 * Loaded from config once when groupByPropertyId changes. Renders read from
	 * here exclusively and never call config.set(). Only explicit user actions
	 * (drag-drop, column remove, color change) update _prefs and then call
	 * _persistPrefs() to write back to config.
	 *
	 * This breaks the config.set() → onDataUpdated() feedback loop that caused
	 * state thrashing on every render cycle.
	 */
	private _lastOrderKey: string = '';
	private _lastWrapValue: boolean | null = null;
	private _lastCardTitlePropertyId: BasesPropertyId | null | undefined = undefined;
	private _lastImagePropertyId: BasesPropertyId | null | undefined = undefined;
	private _lastImageFit: string | undefined = undefined;
	private _lastImageAspectRatio: number | undefined = undefined;
	private _lastSwimlanePropertyId: BasesPropertyId | null | undefined = undefined;

	private _cardFingerprints: Map<string, string> = new Map();
	private _deferredSortableListeners: Map<string, { el: HTMLElement; handler: () => void }> = new Map();

	private _prefs: {
		columnOrder: string[];
		swimlaneOrder: string[];
		cardOrders: Record<string, string[]>;
		columnColors: Record<string, string>;
		collapsedLanes: Set<string>;
		hiddenColumns: Set<string>;
	} = {
		columnOrder: [],
		swimlaneOrder: [],
		cardOrders: {},
		columnColors: {}, // columnValue → colorName
		collapsedLanes: new Set(),
		hiddenColumns: new Set(),
	};
	private _prefsPropertyId: BasesPropertyId | null = null;
	private _prefsSwimlanePropertyId: BasesPropertyId | null = null;

	/**
	 * True while a card or column drag is in flight. When set, patchColumnCards
	 * skips DOM reordering so Sortable's live drag preview is not disturbed by
	 * re-renders triggered during the drag.
	 */
	private _dragging = false;
	private _activeCardPath: string | null = null;
	private _keyboardFocusPath: string | null = null;
	/** Path of a newly-created card that needs focus. Immune to onFocusCard overwrites. */
	private _pendingCreatedFocusPath: string | null = null;
	/** Path of a newly-created card to scroll into view without focusing (mobile). */
	private _pendingCreatedScrollPath: string | null = null;
	/** Guards the one-time cross-column/orphan cleanup; reset whenever prefs reload. */
	private _didInitialCardOrderCleanup = false;
	/**
	 * Signature of the data + display options reflected in the current DOM.
	 * render() skips all DOM work when the freshly-computed signature matches,
	 * so purely-visual state that is applied directly to the DOM (e.g. swimlane
	 * collapse) does not cause a board rebuild when its config.set() persistence
	 * triggers one or more onDataUpdated() renders. Collapse state is
	 * deliberately excluded from the signature.
	 */
	private _lastRenderSignature: string | null = null;

	constructor(controller: QueryController, scrollEl: HTMLElement, legacyData: LegacyData | null = null) {
		super(controller);
		this.scrollEl = scrollEl;
		this.containerEl = scrollEl.createDiv({ cls: CSS_CLASSES.VIEW_CONTAINER });
		this.legacyData = legacyData;

		// Delegated handler for internal links rendered inside property values.
		// Obsidian's global click handler only covers MarkdownView/TextFileView
		// containers; BasesView does not inherit that, so we wire it up explicitly.
		this.containerEl.on('click', 'a.internal-link', (evt, linkEl) => {
			evt.preventDefault();
			const href = linkEl.getAttribute('data-href') || linkEl.getAttribute('href');
			if (href && this.app) {
				const cardEl = linkEl.closest(`[${DATA_ATTRIBUTES.ENTRY_PATH}]`);
				const sourcePath = cardEl.instanceOf(HTMLElement) ? (cardEl.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH) ?? '') : '';
				void this.app.workspace.openLinkText(href, sourcePath, Keymap.isModEvent(evt));
			}
		});

		// Middle-click on internal links inside cards opens the linked note in a
		// background tab — same convention as middle-clicking the card itself.
		this.containerEl.on('auxclick', 'a.internal-link', (evt, linkEl) => {
			if (!evt.instanceOf(MouseEvent) || evt.button !== 1) return;
			evt.preventDefault();
			const href = linkEl.getAttribute('data-href') || linkEl.getAttribute('href');
			if (!href || !this.app) return;
			const cardEl = linkEl.closest(`[${DATA_ATTRIBUTES.ENTRY_PATH}]`);
			const sourcePath = cardEl.instanceOf(HTMLElement) ? (cardEl.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH) ?? '') : '';
			const file = this.app.metadataCache.getFirstLinkpathDest(href, sourcePath);
			if (file) this.openInBackgroundTab(file);
		});

		this.containerEl.on('mouseover', 'a.internal-link', (evt, linkEl) => {
			if (!evt.instanceOf(MouseEvent)) return;
			const href = linkEl.getAttribute('data-href') || linkEl.getAttribute('href');
			if (!href) return;
			const cardEl = linkEl.closest(`[${DATA_ATTRIBUTES.ENTRY_PATH}]`);
			const sourcePath = cardEl.instanceOf(HTMLElement) ? (cardEl.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH) ?? '') : '';
			this.triggerHoverPreview(href, sourcePath, evt, linkEl);
		});

		// Keyboard navigation: arrow keys between cards, Cmd/Ctrl+arrow to move cards.
		this.containerEl.addEventListener('keydown', (e) => {
			const boardEl = this.containerEl.querySelector<HTMLElement>(`.${CSS_CLASSES.BOARD}`);
			if (!boardEl) return;
			handleBoardKeydown(e, boardEl, {
				moveCardToColumn: (path, col) => this.moveCardToColumn(path, col),
				reorderCardInColumn: (path, col, lane, dir) => this.reorderCardInColumn(path, col, lane, dir),
				deleteCard: (path, focusPath) => this.deleteCard(path, focusPath),
				openQuickAddForColumn: (col, lane) => this.openQuickAddForColumn(col, lane),
				openCardInPopout: (path) => this.openCardInPopout(path),
			});
		});

		this._debouncedRender = debounce(() => {
			try {
				this.loadConfig();
				this.render();
			} catch (error) {
				console.error('KanbanView error:', error);
			}
		}, DEBOUNCE_DELAY);

		// Persist card-order maintenance on explicit vault events (never during
		// render). Rename swaps the old path for the new in place so the card
		// keeps its slot; delete drops the path from every column's saved order.
		if (typeof this.app?.vault?.on === 'function' && typeof this.registerEvent === 'function') {
			this.registerEvent(
				this.app.vault.on('rename', (file, oldPath) => {
					if (!this._prefsPropertyId) return;
					if (swapPath(this._prefs.cardOrders, oldPath, file.path)) {
						this._persistPrefs();
					}
				}),
			);
			this.registerEvent(
				this.app.vault.on('delete', (file) => {
					if (!this._prefsPropertyId) return;
					if (removePath(this._prefs.cardOrders, file.path)) {
						this._persistPrefs();
					}
				}),
			);
		}
	}

	onDataUpdated(): void {
		this._debouncedRender();
	}

	private loadConfig(): void {
		this.groupByPropertyId = this.config.getAsPropertyId('groupByProperty');
		this.swimlaneByPropertyId = this.config.getAsPropertyId('swimlaneByProperty');
		this.cardTitlePropertyId = this.config.getAsPropertyId('cardTitleProperty');
		this.imagePropertyId = this.config.getAsPropertyId('imageProperty');
	}

	private triggerHoverPreview(linktext: string, sourcePath: string, event: MouseEvent, targetEl: HTMLElement): void {
		this.app?.workspace.trigger('hover-link', {
			event,
			source: HOVER_LINK_SOURCE_ID,
			hoverParent: this,
			targetEl,
			linktext,
			sourcePath,
		});
	}

	/**
	 * Composite key used by `_prefs.cardOrders` to disambiguate card order across
	 * swimlanes. When swimlanes are inactive, returns the bare column value so
	 * existing flat-mode persistence continues to round-trip unchanged.
	 */
	private cardOrderKey(swimlaneValue: string | null, columnValue: string): string {
		return swimlaneValue === null ? columnValue : `${swimlaneValue}${SWIMLANE_KEY_SEPARATOR}${columnValue}`;
	}

	private swimlanePrefsKey(groupPropertyId: BasesPropertyId, swimlanePropertyId: BasesPropertyId): string {
		return `${groupPropertyId}${SWIMLANE_KEY_SEPARATOR}${swimlanePropertyId}`;
	}

	/**
	 * Load display preferences from config for the given propertyId.
	 * Called once when groupByPropertyId changes; subsequent renders reuse _prefs.
	 */
	private _loadPrefs(propertyId: BasesPropertyId, swimlanePropertyId: BasesPropertyId | null): void {
		this._prefsPropertyId = propertyId;
		this._prefsSwimlanePropertyId = swimlanePropertyId;
		// New prefs scope → run the one-time cleanup again on the next render.
		this._didInitialCardOrderCleanup = false;
		const swimlaneScopedKey = swimlanePropertyId ? this.swimlanePrefsKey(propertyId, swimlanePropertyId) : null;

		// Column order — with legacy migration
		const rawOrders = this.config?.get('columnOrders');
		const allOrders = isColumnOrders(rawOrders) ? rawOrders : {};
		let columnOrder = allOrders[propertyId] ?? null;
		const legacyOrder = this.legacyData?.columnOrders[propertyId] ?? null;
		if (!columnOrder && legacyOrder) {
			columnOrder = legacyOrder;
			this.config?.set('columnOrders', {
				...allOrders,
				[propertyId]: legacyOrder,
			});
		}
		this._prefs.columnOrder = columnOrder ? [...columnOrder] : [];

		// Card orders
		const rawCardOrders = this.config?.get('cardOrders');
		const allCardOrders = isCardOrders(rawCardOrders) ? rawCardOrders : {};
		const savedCardOrders = allCardOrders[swimlaneScopedKey ?? propertyId] ?? {};
		this._prefs.cardOrders = Object.fromEntries(Object.entries(savedCardOrders).map(([k, v]) => [k, [...v]]));

		// Column colors — with legacy migration
		const rawColors = this.config?.get('columnColors');
		const allColors = isColumnColors(rawColors) ? rawColors : {};
		let columnColors = allColors[propertyId] ?? null;
		const legacyColors = this.legacyData?.columnColors[propertyId];
		if (!columnColors && legacyColors && Object.keys(legacyColors).length > 0) {
			columnColors = legacyColors;
			this.config?.set('columnColors', {
				...allColors,
				[propertyId]: legacyColors,
			});
		}
		this._prefs.columnColors = columnColors ? { ...columnColors } : {};

		// Collapsed swimlanes — scoped by group+swimlane property; default = none
		// collapsed (lanes start fully expanded so all cards are visible).
		const rawCollapsed = this.config?.get('collapsedLanes');
		const allCollapsed = isCollapsedLanes(rawCollapsed) ? rawCollapsed : {};
		this._prefs.collapsedLanes = new Set(swimlaneScopedKey ? (allCollapsed[swimlaneScopedKey] ?? []) : []);

		// Swimlane order — scoped by group+swimlane property. Same shape as
		// columnOrders (Record<key, string[]>) so isColumnOrders is the appropriate guard.
		const rawSwimlaneOrders = this.config?.get('swimlaneOrders');
		const allSwimlaneOrders = isColumnOrders(rawSwimlaneOrders) ? rawSwimlaneOrders : {};
		this._prefs.swimlaneOrder =
			swimlaneScopedKey && allSwimlaneOrders[swimlaneScopedKey] ? [...allSwimlaneOrders[swimlaneScopedKey]] : [];

		// Hidden columns — scoped by groupByPropertyId.
		const rawHidden = this.config?.get('hiddenColumns');
		const allHidden = isColumnOrders(rawHidden) ? rawHidden : {};
		this._prefs.hiddenColumns = new Set(allHidden[propertyId] ?? []);
	}

	/**
	 * Write _prefs back to config. Called only on user actions (drag-drop,
	 * column remove, color change) — never during renders.
	 *
	 * Change guards skip config.set() when the value hasn't changed, preventing
	 * spurious onDataUpdated() triggers.
	 */
	private _persistConfigKey<T>(
		key: string,
		guard: (v: unknown) => v is Record<string, T>,
		newValue: T,
		storageKey: string | null = this._prefsPropertyId,
	): void {
		if (!storageKey) return;
		const raw = this.config?.get(key);
		const all: Record<string, T> = guard(raw) ? raw : {};
		if (JSON.stringify(all[storageKey]) !== JSON.stringify(newValue)) {
			// Deep-clone so the stored config never shares references with
			// `_prefs`. Otherwise later in-place mutations of `_prefs.cardOrders`
			// (e.g. an in-column reorder) would also mutate the value held by the
			// config, defeating the change guard above on the next persist and
			// silently dropping the write.
			const next: Record<string, T> = { ...all, [storageKey]: newValue };
			this.config?.set(key, JSON.parse(JSON.stringify(next)));
		}
	}

	private _persistPrefs(): void {
		if (!this._prefsPropertyId) return;
		const swimlaneScopedKey = this._prefsSwimlanePropertyId
			? this.swimlanePrefsKey(this._prefsPropertyId, this._prefsSwimlanePropertyId)
			: null;

		// Normalize before every write: dedupe each column list so a path can
		// never appear twice (collision cleanup).
		const normalizedCardOrders: CardOrders = {};
		for (const [key, list] of Object.entries(this._prefs.cardOrders)) {
			normalizedCardOrders[key] = normalizeList(list);
		}
		this._prefs.cardOrders = normalizedCardOrders;

		this._persistConfigKey('columnOrders', isColumnOrders, this._prefs.columnOrder, this._prefsPropertyId);
		this._persistConfigKey(
			'cardOrders',
			isCardOrders,
			this._prefs.cardOrders,
			swimlaneScopedKey ?? this._prefsPropertyId,
		);
		this._persistConfigKey('columnColors', isColumnColors, this._prefs.columnColors, this._prefsPropertyId);
		this._persistConfigKey('hiddenColumns', isColumnOrders, Array.from(this._prefs.hiddenColumns), this._prefsPropertyId);

		if (swimlaneScopedKey) {
			this._persistConfigKey('swimlaneOrders', isColumnOrders, this._prefs.swimlaneOrder, swimlaneScopedKey);
			this._persistConfigKey(
				'collapsedLanes',
				isCollapsedLanes,
				Array.from(this._prefs.collapsedLanes),
				swimlaneScopedKey,
			);
		}
	}

	/**
	 * @param force When true, always reconcile the DOM, bypassing the render
	 *   signature short-circuit. Imperative callers (drag snap-back, hide/unhide,
	 *   error recovery) that mutate the DOM directly must force, since the data
	 *   model — and therefore the signature — may be unchanged. The reactive
	 *   debounced render leaves this false so config.set()-triggered renders that
	 *   change nothing (e.g. swimlane collapse) are skipped.
	 */
	private render(force = false): void {
		try {
			const entries = this.data?.data || [];
			const availablePropertyIds = this.allProperties || [];

			if (!this.groupByPropertyId && availablePropertyIds.length === 0) {
				this.fullReset();
				this.containerEl.createDiv({
					text: EMPTY_STATE_MESSAGES.NO_PROPERTIES,
					cls: CSS_CLASSES.EMPTY_STATE,
				});
				return;
			}
			if (!this.groupByPropertyId) {
				this.groupByPropertyId = availablePropertyIds[0];
			}
			// If groupByPropertyId is set but is no longer in availablePropertyIds
			// (e.g. all notes with that property were removed), keep the configured
			// value so the board renders from persisted prefs rather than switching
			// to an unrelated property.

			// Swimlane on the same axis as the column group is meaningless — every
			// lane would contain a single populated column. Treat as unset.
			const swimlanePropertyId =
				this.swimlaneByPropertyId && this.swimlaneByPropertyId !== this.groupByPropertyId
					? this.swimlaneByPropertyId
					: null;

			// Reload prefs when either grouping axis changes.
			const groupChanged = this.groupByPropertyId !== this._prefsPropertyId;
			if (groupChanged || swimlanePropertyId !== this._prefsSwimlanePropertyId) {
				this._loadPrefs(this.groupByPropertyId, swimlanePropertyId);
			}

			const hasNoEntries = entries.length === 0;
			const hasNoSavedColumns = this._prefs.columnOrder.length === 0;
			if (hasNoEntries && hasNoSavedColumns) {
				this.fullReset();
				this.containerEl.createDiv({
					text: EMPTY_STATE_MESSAGES.NO_ENTRIES,
					cls: CSS_CLASSES.EMPTY_STATE,
				});
				return;
			}
			// hasNoEntries && !hasNoSavedColumns: board has saved columns — render them as empty so the user can see and manage them.

			// Build path→entry lookup map for O(1) access in handleCardDrop
			this._entryMap = new Map(entries.map((e: BasesEntry) => [e.file.path, e]));

			// Group entries — 2D when swimlanes are active, 1D otherwise. The
			// column-axis preference logic (order, colors, new-value detection)
			// runs against the union of columns across all lanes, so a single
			// canonical column ordering is shared by every lane.
			const groupedByLane = swimlanePropertyId
				? this.groupEntriesBySwimlaneAndColumn(entries, swimlanePropertyId, this.groupByPropertyId)
				: null;
			const groupedEntries = groupedByLane
				? this.flattenLanes(groupedByLane)
				: this.groupEntriesByProperty(entries, this.groupByPropertyId);
			const sortActive = this.hasActiveSort();

			// Apply manual card order only when the Base itself is not sorted.
			// When sorting is active, Bases has already ordered `entries`.
			//
			// Ordering is applied here as a PURE read: render never mutates
			// `_prefs.cardOrders` and never persists. applyCardOrder lays cards out
			// in the saved order and prepends any not-yet-ordered cards (sorted by
			// filename) for display only. Persistence happens exclusively on
			// explicit events (quick-add, keyboard move/reorder, drag, rename,
			// delete), which keeps render free of config.set() and avoids both the
			// feedback loop and the stale-data race during async frontmatter writes.
			//
			// A one-time cleanup right after load (no in-flight writes, so race
			// free) drops orphans and resolves cross-column duplicates.
			if (!sortActive) {
				if (!this._didInitialCardOrderCleanup) {
					this._cleanupCardOrders(groupedByLane, groupedEntries);
					this._didInitialCardOrderCleanup = true;
				}
				if (groupedByLane) {
					groupedByLane.forEach((columns, laneValue) => {
						columns.forEach((cellEntries, columnValue) => {
							const key = this.cardOrderKey(laneValue, columnValue);
							columns.set(columnValue, this.applyCardOrder(cellEntries, this._prefs.cardOrders[key] ?? []));
						});
					});
				} else {
					groupedEntries.forEach((columnEntries, value) => {
						const key = this.cardOrderKey(null, value);
						groupedEntries.set(value, this.applyCardOrder(columnEntries, this._prefs.cardOrders[key] ?? []));
					});
				}
			}

			// Merge any newly-seen column values into prefs and persist eagerly.
			// This is the only place render() calls _persistPrefs(), and only when
			// new columns appear — not on every render pass.
			const liveValues = Array.from(groupedEntries.keys());
			const liveValueSet = new Set(liveValues);
			let shouldPersistColumnOrder = false;
			if (this._prefs.columnOrder.includes(UNCATEGORIZED_LABEL) && !liveValueSet.has(UNCATEGORIZED_LABEL)) {
				this._prefs.columnOrder = this._prefs.columnOrder.filter((value) => value !== UNCATEGORIZED_LABEL);
				shouldPersistColumnOrder = true;
			}
			const newValues = liveValues.filter((v) => !this._prefs.columnOrder.includes(v));
			if (newValues.length > 0) {
				const isInitialOrder = this._prefs.columnOrder.length === 0;
				// No prior order — sort alphabetically as the initial ordering
				this._prefs.columnOrder = isInitialOrder ? [...newValues].sort() : [...this._prefs.columnOrder, ...newValues];
				shouldPersistColumnOrder = true;
			}
			if (shouldPersistColumnOrder) {
				this._persistPrefs();
			}

			const orderedValues = this.getOrderedColumnValues(liveValues);

			const currentOrderKey = JSON.stringify(this.config?.getOrder() ?? []);
			const orderChanged = currentOrderKey !== this._lastOrderKey;
			this._lastOrderKey = currentOrderKey;

			const currentWrapValue = this.config?.get('wrapPropertyValues') === true;
			const wrapChanged = currentWrapValue !== this._lastWrapValue;
			this._lastWrapValue = currentWrapValue;

			const currentCardTitlePropertyId = this.cardTitlePropertyId;
			const cardTitleChanged = currentCardTitlePropertyId !== this._lastCardTitlePropertyId;
			this._lastCardTitlePropertyId = currentCardTitlePropertyId;

			const currentImagePropertyId = this.imagePropertyId;
			const imagePropertyChanged = currentImagePropertyId !== this._lastImagePropertyId;
			this._lastImagePropertyId = currentImagePropertyId;

			const currentImageFit = this.config?.get('imageFit') === 'contain' ? 'contain' : 'cover';
			const imageFitChanged = currentImageFit !== this._lastImageFit;
			this._lastImageFit = currentImageFit;

			const rawRatio = Number(this.config?.get('imageAspectRatio'));
			const currentImageAspectRatio = Number.isFinite(rawRatio) && rawRatio > 0 ? rawRatio : 0.5;
			const imageAspectRatioChanged = currentImageAspectRatio !== this._lastImageAspectRatio;
			this._lastImageAspectRatio = currentImageAspectRatio;

			const currentSwimlanePropertyId = swimlanePropertyId;
			const swimlanePropertyChanged = currentSwimlanePropertyId !== this._lastSwimlanePropertyId;
			this._lastSwimlanePropertyId = currentSwimlanePropertyId;

			const existingBoard = this.containerEl.querySelector<HTMLElement>(`.${CSS_CLASSES.BOARD}`);
			const optionsChanged =
				orderChanged ||
				wrapChanged ||
				cardTitleChanged ||
				imagePropertyChanged ||
				imageFitChanged ||
				imageAspectRatioChanged ||
				swimlanePropertyChanged;

			const lanes = new Map<string | null, Map<string, BasesEntry[]>>();
			if (groupedByLane) {
				groupedByLane.forEach((v, k) => lanes.set(k, v));
			} else {
				lanes.set(null, groupedEntries);
			}
			const hasSwimlanes = groupedByLane !== null;
			const existingIsSwimlane = existingBoard?.classList.contains(CSS_CLASSES.BOARD_WITH_SWIMLANES) ?? false;
			const modeChanged = hasSwimlanes !== existingIsSwimlane;

			// Skip all DOM work when nothing the board renders has actually
			// changed. Purely-visual state applied directly to the DOM (swimlane
			// collapse) is excluded from the signature, so the render(s) that its
			// config.set() persistence triggers become no-ops instead of rebuilding
			// every card and resetting scroll positions.
			const optionsSignature = JSON.stringify([
				currentOrderKey,
				currentWrapValue,
				currentCardTitlePropertyId,
				currentImagePropertyId,
				currentImageFit,
				currentImageAspectRatio,
				currentSwimlanePropertyId,
				hasSwimlanes,
			]);
			const renderSignature = this._computeRenderSignature(orderedValues, lanes, hasSwimlanes, optionsSignature);
			if (!force && existingBoard && !modeChanged && !groupChanged && renderSignature === this._lastRenderSignature) {
				return;
			}
			this._lastRenderSignature = renderSignature;

			if (!existingBoard || modeChanged || groupChanged || optionsChanged) {
				this.fullRebuild(orderedValues, lanes, hasSwimlanes);
			} else {
				this.patchBoard(orderedValues, lanes, hasSwimlanes);
			}
			this.reapplyActiveCard();
		} catch (error) {
			console.error('KanbanView error:', error);
		}
	}

	private destroySortables(): void {
		this._columnSortables.forEach((s) => s.destroy());
		this._columnSortables.clear();
		if (this.swimlaneSortable) {
			this.swimlaneSortable.destroy();
			this.swimlaneSortable = null;
		}
		this.swimlaneColumnSortables.forEach((s) => s.destroy());
		this.swimlaneColumnSortables.clear();
		this._deferredSortableListeners.forEach(({ el, handler }) => {
			el.removeEventListener('pointerdown', handler);
		});
		this._deferredSortableListeners.clear();
	}

	private fullReset(): void {
		this.containerEl.empty();
		this.destroySortables();
		this._entryMap.clear();
		this._cardFingerprints.clear();
		// The board DOM is gone; force the next render() to rebuild.
		this._lastRenderSignature = null;
	}

	private fullRebuild(
		orderedColumnValues: string[],
		lanes: Map<string | null, Map<string, BasesEntry[]>>,
		hasSwimlanes: boolean,
	): void {
		this.containerEl.empty();
		this.containerEl.classList.toggle(CSS_CLASSES.VIEW_CONTAINER_WITH_SWIMLANES, hasSwimlanes);
		this.destroySortables();
		const boardEl = this.containerEl.createDiv({
			cls: hasSwimlanes ? `${CSS_CLASSES.BOARD} ${CSS_CLASSES.BOARD_WITH_SWIMLANES}` : CSS_CLASSES.BOARD,
		});

		if (hasSwimlanes) {
			const liveLaneValues = [...lanes.keys()].filter((k): k is string => k !== null);
			// Merge any newly-seen lane values into prefs once, on first observation.
			// Mirrors the column-order init in render() — alphabetical for the
			// initial save, append for subsequent additions. Persisted eagerly so
			// the order survives a reload even before the user reorders manually.
			const newLaneValues = liveLaneValues.filter((v) => !this._prefs.swimlaneOrder.includes(v));
			if (newLaneValues.length > 0) {
				const isInitialOrder = this._prefs.swimlaneOrder.length === 0;
				if (isInitialOrder) {
					this._prefs.swimlaneOrder = this._sortSwimlaneValues(newLaneValues);
				} else {
					this._prefs.swimlaneOrder = [...this._prefs.swimlaneOrder, ...newLaneValues];
				}
				this._persistPrefs();
			}

			const orderedLanes = this.getOrderedSwimlaneValues(liveLaneValues);
			orderedLanes.forEach((laneValue) => {
				const laneEntries = lanes.get(laneValue) ?? new Map<string, BasesEntry[]>();
				const laneEl = this._buildSwimlaneElement(laneValue, laneEntries, orderedColumnValues);
				boardEl.appendChild(laneEl);
				const bodyEl = laneEl.querySelector<HTMLElement>(`.${CSS_CLASSES.SWIMLANE_BODY}`);
				if (bodyEl) this.swimlaneColumnSortables.set(laneValue, this._createColumnSortable(bodyEl));
			});

			this.initializeSwimlaneSortable(boardEl);
		} else {
			const colEntries = lanes.get(null) ?? new Map<string, BasesEntry[]>();
			orderedColumnValues.forEach((colValue) => {
				const colEl = this.createColumn(colValue, colEntries.get(colValue) ?? []);
				boardEl.appendChild(colEl);
				const cardBody = colEl.querySelector<HTMLElement>(
					`.${CSS_CLASSES.COLUMN_BODY}[${DATA_ATTRIBUTES.SORTABLE_CONTAINER}]`,
				);
				if (cardBody) this.attachCardSortable(cardBody, this.cardOrderKey(null, colValue));
			});
			this.swimlaneColumnSortables.set(null, this._createColumnSortable(boardEl));
		}
	}

	private _buildRowCtx(): RowRenderCtx {
		return {
			...this._buildColumnCtx(),
			collapsedLanes: this._prefs.collapsedLanes,
		};
	}

	private _buildRowCallbacks(): RowCallbacks {
		return {
			...this._buildColumnCallbacks(),
			onToggleCollapsed: (laneVal, laneEl, toggleBtn) => this.toggleSwimlaneCollapsed(laneVal, laneEl, toggleBtn),
			attachCardSortable: (body, key) => this.attachCardSortable(body, key),
			cardOrderKey: (laneVal, colVal) => this.cardOrderKey(laneVal, colVal),
		};
	}

	private _buildSwimlaneElement(
		laneValue: string,
		laneEntries: Map<string, BasesEntry[]>,
		orderedColumnValues: string[],
	): HTMLElement {
		return buildSwimlaneElementEl(
			laneValue,
			laneEntries,
			orderedColumnValues,
			this._buildRowCtx(),
			this._buildRowCallbacks(),
		);
	}

	private _createColumnSortable(containerEl: HTMLElement): Sortable {
		return new Sortable(containerEl, {
			animation: SORTABLE_CONFIG.ANIMATION_DURATION,
			handle: `.${CSS_CLASSES.COLUMN_DRAG_HANDLE}`,
			draggable: `.${CSS_CLASSES.COLUMN}`,
			ghostClass: CSS_CLASSES.COLUMN_GHOST,
			dragClass: CSS_CLASSES.COLUMN_DRAGGING,
			onStart: () => {
				this._dragging = true;
			},
			onEnd: (evt: Sortable.SortableEvent) => {
				this._dragging = false;
				try {
					this.handleSwimlaneColumnDrop(evt);
				} catch (error) {
					console.error('KanbanView: error handling column drop', error);
				}
			},
		});
	}

	private initializeSwimlaneSortable(boardEl: HTMLElement): void {
		if (this.swimlaneSortable) {
			this.swimlaneSortable.destroy();
			this.swimlaneSortable = null;
		}

		this.swimlaneSortable = new Sortable(boardEl, {
			animation: SORTABLE_CONFIG.ANIMATION_DURATION,
			handle: `.${CSS_CLASSES.SWIMLANE_DRAG_HANDLE}`,
			draggable: `.${CSS_CLASSES.SWIMLANE}`,
			ghostClass: CSS_CLASSES.SWIMLANE_GHOST,
			dragClass: CSS_CLASSES.SWIMLANE_DRAGGING,
			onStart: () => {
				this._dragging = true;
			},
			onEnd: () => {
				this._dragging = false;
				this.handleSwimlaneDrop(boardEl);
			},
		});
	}

	private handleSwimlaneDrop(boardEl: HTMLElement): void {
		const lanes = boardEl.querySelectorAll(`.${CSS_CLASSES.SWIMLANE}`);
		const order = Array.from(lanes)
			.map((lane) => lane.getAttribute(DATA_ATTRIBUTES.SWIMLANE_VALUE))
			.filter((v): v is string => v !== null);
		this._prefs.swimlaneOrder = order;
		this._persistPrefs();
	}

	private handleSwimlaneColumnDrop(evt: Sortable.SortableEvent): void {
		if (!this._prefsPropertyId || !evt.to.instanceOf(HTMLElement)) return;

		const order = Array.from(evt.to.children)
			.filter(
				(child): child is HTMLElement => child.instanceOf(HTMLElement) && child.classList.contains(CSS_CLASSES.COLUMN),
			)
			.map((col) => col.getAttribute(DATA_ATTRIBUTES.COLUMN_VALUE))
			.filter((v): v is string => v !== null);

		if (order.length === 0) return;

		this._prefs.columnOrder = order;
		this._persistPrefs();
		this.render(true);
	}

	private patchBoard(
		orderedColumnValues: string[],
		lanes: Map<string | null, Map<string, BasesEntry[]>>,
		hasSwimlanes: boolean,
	): void {
		const boardEl = this.containerEl.querySelector<HTMLElement>(`.${CSS_CLASSES.BOARD}`);
		if (!boardEl) {
			console.error('KanbanView: patchBoard called but board element not found; skipping patch');
			return;
		}

		// Card rebuilds and DOM re-parenting can clamp scrollTop. Capture up-front
		// keyed by cardOrderKey(laneValue, colValue) and restore after layout settles.
		const scrollPositions = new Map<string, number>();
		boardEl.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.COLUMN_BODY}`).forEach((body) => {
			const colEl = body.closest<HTMLElement>(`.${CSS_CLASSES.COLUMN}`);
			const colVal = colEl?.getAttribute(DATA_ATTRIBUTES.COLUMN_VALUE);
			const laneEl = body.closest<HTMLElement>(`.${CSS_CLASSES.SWIMLANE}`);
			const laneVal = laneEl?.getAttribute(DATA_ATTRIBUTES.SWIMLANE_VALUE) ?? null;
			if (colVal) scrollPositions.set(this.cardOrderKey(laneVal, colVal), body.scrollTop);
		});

		// Re-appending columns into a swimlane body resets its horizontal scroll,
		// which is jarring (the lane jumps back to the left). Capture scrollLeft
		// per lane and restore it alongside the column scrollTop.
		const laneScrollLeft = new Map<string, number>();
		boardEl.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.SWIMLANE_BODY}`).forEach((body) => {
			const laneEl = body.closest<HTMLElement>(`.${CSS_CLASSES.SWIMLANE}`);
			const laneVal = laneEl?.getAttribute(DATA_ATTRIBUTES.SWIMLANE_VALUE);
			if (laneVal !== null && laneVal !== undefined) laneScrollLeft.set(laneVal, body.scrollLeft);
		});

		if (hasSwimlanes) {
			const liveLaneValues = [...lanes.keys()].filter((k): k is string => k !== null);
			// Merge any newly-seen lane values into prefs.
			const newLaneValues = liveLaneValues.filter((v) => !this._prefs.swimlaneOrder.includes(v));
			if (newLaneValues.length > 0) {
				const isInitialOrder = this._prefs.swimlaneOrder.length === 0;
				if (isInitialOrder) {
					this._prefs.swimlaneOrder = this._sortSwimlaneValues(newLaneValues);
				} else {
					this._prefs.swimlaneOrder = [...this._prefs.swimlaneOrder, ...newLaneValues];
				}
				this._persistPrefs();
			}

			const orderedLanes = this.getOrderedSwimlaneValues(liveLaneValues);
			const newLaneSet = new Set(orderedLanes);

			// Index existing lanes
			const existingLanes = new Map<string, HTMLElement>();
			boardEl.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.SWIMLANE}`).forEach((laneEl) => {
				const val = laneEl.getAttribute(DATA_ATTRIBUTES.SWIMLANE_VALUE);
				if (val !== null) existingLanes.set(val, laneEl);
			});

			// Remove lanes not in new set
			existingLanes.forEach((laneEl, laneValue) => {
				if (!newLaneSet.has(laneValue)) {
					const colSortable = this.swimlaneColumnSortables.get(laneValue);
					if (colSortable) {
						colSortable.destroy();
						this.swimlaneColumnSortables.delete(laneValue);
					}
					orderedColumnValues.forEach((colVal) => {
						const key = this.cardOrderKey(laneValue, colVal);
						const s = this._columnSortables.get(key);
						if (s) {
							s.destroy();
							this._columnSortables.delete(key);
						}
					});
					laneEl.remove();
					existingLanes.delete(laneValue);
				}
			});

			// Patch or create lanes
			orderedLanes.forEach((laneValue) => {
				const laneEntries = lanes.get(laneValue) ?? new Map<string, BasesEntry[]>();
				if (!existingLanes.has(laneValue)) {
					const laneEl = this._buildSwimlaneElement(laneValue, laneEntries, orderedColumnValues);
					boardEl.appendChild(laneEl);
					existingLanes.set(laneValue, laneEl);
					const bodyEl = laneEl.querySelector<HTMLElement>(`.${CSS_CLASSES.SWIMLANE_BODY}`);
					if (bodyEl) {
						this.swimlaneColumnSortables.set(laneValue, this._createColumnSortable(bodyEl));
					} else {
						console.error('KanbanView: swimlane body element not found; column sorting will be broken', laneValue);
					}
				} else {
					const laneEl = existingLanes.get(laneValue);
					if (laneEl) {
						// Update lane count
						const countEl = laneEl.querySelector(`.${CSS_CLASSES.SWIMLANE_COUNT}`);
						if (countEl) {
							const count = orderedColumnValues.reduce((sum, col) => sum + (laneEntries.get(col)?.length ?? 0), 0);
							countEl.textContent = `${count}`;
						}
						// Patch columns within lane body
						const bodyEl = laneEl.querySelector<HTMLElement>(`.${CSS_CLASSES.SWIMLANE_BODY}`);
						if (bodyEl) this._patchColumns(bodyEl, orderedColumnValues, laneEntries, laneValue);
					}
				}
			});

			// Re-order lanes in the DOM
			orderedLanes.forEach((laneValue) => {
				const laneEl = existingLanes.get(laneValue);
				if (laneEl) boardEl.appendChild(laneEl);
			});

			if (!this.swimlaneSortable) this.initializeSwimlaneSortable(boardEl);
		} else {
			// Null lane: columns are direct children of boardEl
			const colEntries = lanes.get(null) ?? new Map<string, BasesEntry[]>();
			this._patchColumns(boardEl, orderedColumnValues, colEntries, null);
		}

		// Restore lane horizontal scroll synchronously so the board doesn't visibly
		// jump to the left for a frame before the deferred restore below. Widths are
		// stable here, so scrollLeft is not clamped the way scrollTop can be.
		boardEl.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.SWIMLANE_BODY}`).forEach((body) => {
			const laneEl = body.closest<HTMLElement>(`.${CSS_CLASSES.SWIMLANE}`);
			const laneVal = laneEl?.getAttribute(DATA_ATTRIBUTES.SWIMLANE_VALUE);
			if (laneVal !== null && laneVal !== undefined) {
				const left = laneScrollLeft.get(laneVal);
				if (left !== undefined) body.scrollLeft = left;
			}
		});

		// Defer scroll restoration to the next frame so layout has finalized.
		// Synchronous scrollTop assignment can be clamped when a transient layout
		// pass reports a smaller scrollHeight (e.g. image-backed cards not yet laid out).
		window.requestAnimationFrame(() => {
			try {
				boardEl.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.COLUMN_BODY}`).forEach((body) => {
					const colEl = body.closest<HTMLElement>(`.${CSS_CLASSES.COLUMN}`);
					const colVal = colEl?.getAttribute(DATA_ATTRIBUTES.COLUMN_VALUE);
					const laneEl = body.closest<HTMLElement>(`.${CSS_CLASSES.SWIMLANE}`);
					const laneVal = laneEl?.getAttribute(DATA_ATTRIBUTES.SWIMLANE_VALUE) ?? null;
					if (colVal) {
						const top = scrollPositions.get(this.cardOrderKey(laneVal, colVal));
						if (top !== undefined) body.scrollTop = top;
					}
				});
				boardEl.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.SWIMLANE_BODY}`).forEach((body) => {
					const laneEl = body.closest<HTMLElement>(`.${CSS_CLASSES.SWIMLANE}`);
					const laneVal = laneEl?.getAttribute(DATA_ATTRIBUTES.SWIMLANE_VALUE);
					if (laneVal !== null && laneVal !== undefined) {
						const left = laneScrollLeft.get(laneVal);
						if (left !== undefined) body.scrollLeft = left;
					}
				});
			} catch (error) {
				console.error('KanbanView: error restoring scroll positions', error);
			}
		});
	}

	private _patchColumns(
		containerEl: HTMLElement,
		orderedColumnValues: string[],
		groupedEntries: Map<string, BasesEntry[]>,
		laneValue: string | null,
	): void {
		// Index existing columns
		const existingColumns = new Map<string, HTMLElement>();
		containerEl.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.COLUMN}`).forEach((col) => {
			const val = col.getAttribute(DATA_ATTRIBUTES.COLUMN_VALUE);
			if (val !== null) existingColumns.set(val, col);
		});

		const newColSet = new Set(orderedColumnValues);

		// Remove columns not in the new ordered set
		existingColumns.forEach((colEl, colValue) => {
			if (!newColSet.has(colValue)) {
				const key = this.cardOrderKey(laneValue, colValue);
				const s = this._columnSortables.get(key);
				if (s) {
					s.destroy();
					this._columnSortables.delete(key);
				}
				colEl.remove();
				existingColumns.delete(colValue);
			}
		});

		// Add new columns or patch existing
		orderedColumnValues.forEach((colValue) => {
			const entries = groupedEntries.get(colValue) ?? [];
			const existingEl = existingColumns.get(colValue);

			// Hidden state is a pure class toggle applied in place by
			// toggleColumnHidden, so an existing column's DOM never needs rebuilding
			// to reflect a collapse — we only create columns that don't exist yet.
			const shouldBeHidden = this._prefs.hiddenColumns.has(colValue);

			if (!existingEl) {
				const options = laneValue !== null ? { showRemoveButton: false as const, swimlaneValue: laneValue } : {};
				const colEl = this.createColumn(colValue, entries, options);
				containerEl.appendChild(colEl);
				existingColumns.set(colValue, colEl);
				const cardBody = colEl.querySelector<HTMLElement>(
					`.${CSS_CLASSES.COLUMN_BODY}[${DATA_ATTRIBUTES.SORTABLE_CONTAINER}]`,
				);
				if (cardBody) {
					const key = this.cardOrderKey(laneValue, colValue);
					// Collapsed columns must be drop targets immediately so cards
					// can be dragged into them; they have no visible body to
					// pointerdown on. Visible columns defer attachment until first
					// interaction as a performance optimization.
					if (shouldBeHidden) {
						this.attachCardSortable(cardBody, key);
					} else {
						const attachOnce = () => {
							this.attachCardSortable(cardBody, key);
							this._deferredSortableListeners.delete(key);
							cardBody.removeEventListener('pointerdown', attachOnce);
						};
						cardBody.addEventListener('pointerdown', attachOnce);
						this._deferredSortableListeners.set(key, {
							el: cardBody,
							handler: attachOnce,
						});
					}
				}
			} else {
				this.patchColumnCards(existingEl, entries);
			}
		});

		// Re-order columns in the DOM to match orderedColumnValues
		orderedColumnValues.forEach((colValue) => {
			const colEl = existingColumns.get(colValue);
			if (colEl) containerEl.appendChild(colEl);
		});
	}

	private _computeCardFingerprint(entry: BasesEntry): string {
		return computeCardFingerprint(entry, this._buildCardCtx());
	}

	/**
	 * Build a string that captures everything the board DOM reflects: display
	 * options, column/lane order, per-cell card identity+content and colors.
	 * Collapse state (swimlane collapse and column hide) is intentionally omitted
	 * because it is applied directly to the DOM as a class toggle, so a
	 * collapse-only change yields an identical signature and render() skips the
	 * rebuild.
	 */
	private _computeRenderSignature(
		orderedColumnValues: string[],
		lanes: Map<string | null, Map<string, BasesEntry[]>>,
		hasSwimlanes: boolean,
		optionsSignature: string,
	): string {
		const cardCtx = this._buildCardCtx();
		const parts: string[] = [optionsSignature];
		parts.push(`cols:${orderedColumnValues.join('\x1f')}`);
		parts.push(`colors:${JSON.stringify(this._prefs.columnColors)}`);

		const laneKeys = hasSwimlanes
			? this.getOrderedSwimlaneValues([...lanes.keys()].filter((k): k is string => k !== null))
			: [null];
		for (const laneKey of laneKeys) {
			parts.push(`lane:${laneKey ?? ''}`);
			const columns = lanes.get(laneKey) ?? new Map<string, BasesEntry[]>();
			for (const colValue of orderedColumnValues) {
				parts.push(`col:${colValue}`);
				for (const entry of columns.get(colValue) ?? []) {
					parts.push(`${entry.file.path}=${computeCardFingerprint(entry, cardCtx)}`);
				}
			}
		}
		return parts.join('\n');
	}

	private patchColumnCards(columnEl: HTMLElement, newEntries: BasesEntry[]): void {
		patchColumnCardsEl(columnEl, newEntries, this._buildColumnCtx(), this._buildColumnCallbacks());
	}

	private groupEntriesByProperty(entries: BasesEntry[], propertyId: BasesPropertyId): Map<string, BasesEntry[]> {
		const grouped = new Map<string, BasesEntry[]>();

		entries.forEach((entry) => {
			try {
				const propValue = entry.getValue(propertyId);
				const value = normalizePropertyValue(propValue);
				const group = ensureGroupExists(grouped, value);
				group.push(entry);
			} catch (error) {
				console.warn('Error processing entry:', entry.file.path, error);
				const uncategorizedGroup = ensureGroupExists(grouped, UNCATEGORIZED_LABEL);
				uncategorizedGroup.push(entry);
			}
		});

		return grouped;
	}

	/**
	 * Two-axis bucketing: swimlane → column → entries. Entries that fail to read
	 * either property fall through to UNCATEGORIZED_LABEL on the offending axis.
	 */
	private groupEntriesBySwimlaneAndColumn(
		entries: BasesEntry[],
		swimlanePropertyId: BasesPropertyId,
		columnPropertyId: BasesPropertyId,
	): Map<string, Map<string, BasesEntry[]>> {
		const grouped = new Map<string, Map<string, BasesEntry[]>>();

		const ensureLane = (laneKey: string): Map<string, BasesEntry[]> => {
			const existing = grouped.get(laneKey);
			if (existing) return existing;
			const lane = new Map<string, BasesEntry[]>();
			grouped.set(laneKey, lane);
			return lane;
		};

		entries.forEach((entry) => {
			let laneKey = UNCATEGORIZED_LABEL;
			let columnKey = UNCATEGORIZED_LABEL;
			try {
				laneKey = normalizePropertyValue(entry.getValue(swimlanePropertyId));
			} catch (error) {
				console.warn('Error reading swimlane property for entry:', entry.file.path, error);
			}
			try {
				columnKey = normalizePropertyValue(entry.getValue(columnPropertyId));
			} catch (error) {
				console.warn('Error reading column property for entry:', entry.file.path, error);
			}
			const lane = ensureLane(laneKey);
			ensureGroupExists(lane, columnKey).push(entry);
		});

		return grouped;
	}

	private toggleSwimlaneCollapsed(laneValue: string, laneEl: HTMLElement, toggleBtn: HTMLElement): void {
		const willCollapse = !this._prefs.collapsedLanes.has(laneValue);
		if (willCollapse) this._prefs.collapsedLanes.add(laneValue);
		else this._prefs.collapsedLanes.delete(laneValue);
		laneEl.classList.toggle(CSS_CLASSES.SWIMLANE_COLLAPSED, willCollapse);
		updateSwimlaneToggleEl(toggleBtn, willCollapse);
		// The collapse is already reflected in the DOM above. Persisting only
		// writes collapsedLanes to config; any render that config.set() triggers
		// is a no-op because collapse state is excluded from the render signature.
		this._persistPrefs();
	}

	private _sortSwimlaneValues(values: string[]): string[] {
		return sortSwimlaneValues(values);
	}

	private getOrderedSwimlaneValues(liveValues: string[]): string[] {
		return getOrderedSwimlaneValuesEl(liveValues, this._prefs.swimlaneOrder);
	}

	/**
	 * Flatten a lane→column→entries map into the column→entries shape the
	 * single-axis render path expects, preserving union of column values across
	 * all lanes so empty cells still render as empty bodies.
	 */
	private flattenLanes(byLane: Map<string, Map<string, BasesEntry[]>>): Map<string, BasesEntry[]> {
		const flat = new Map<string, BasesEntry[]>();
		byLane.forEach((columns) => {
			columns.forEach((entries, columnValue) => {
				const existing = flat.get(columnValue);
				if (existing) existing.push(...entries);
				else flat.set(columnValue, [...entries]);
			});
		});
		return flat;
	}

	private _buildColumnCtx(): ColumnRenderCtx {
		return {
			doc: this.containerEl.doc,
			card: this._buildCardCtx(),
			cardCb: this._buildCardCallbacks(),
			prefs: { columnColors: this._prefs.columnColors, hiddenColumns: this._prefs.hiddenColumns },
			dragging: this._dragging,
			cardFingerprints: this._cardFingerprints,
		};
	}

	private _buildColumnCallbacks(): ColumnCallbacks {
		return {
			applyColumnColor: (el, name) => this.applyColumnColor(el, name),
			onColorPickerClick: (anchor, col, val) => this.openColorPicker(anchor, col, val),
			onRemoveColumn: (val, el) => this.removeColumn(val, el),
			onToggleColumnHidden: (val, hidden) => this.toggleColumnHidden(val, hidden),
			onQuickAdd: (col, lane) => this.openQuickAddForColumn(col, lane),
		};
	}

	private createColumn(
		value: string,
		entries: BasesEntry[],
		options: { showRemoveButton?: boolean; swimlaneValue?: string | null } = {},
	): HTMLElement {
		return createColumnEl(value, entries, options, this._buildColumnCtx(), this._buildColumnCallbacks());
	}

	private _buildCardCtx(): CardRenderCtx {
		return {
			app: this.app,
			doc: this.containerEl.doc,
			groupByPropertyId: this.groupByPropertyId,
			cardTitlePropertyId: this.cardTitlePropertyId,
			imagePropertyId: this.imagePropertyId,
			imageFit: this._lastImageFit ?? 'cover',
			imageAspectRatio: this._lastImageAspectRatio ?? 0.5,
			wrapValues: this._lastWrapValue ?? false,
			order: this.config?.getOrder() ?? [],
			getDisplayName: (id) => this.config?.getDisplayName(id) ?? id,
		};
	}

	private _buildCardCallbacks(): CardCallbacks {
		return {
			onHoverPreview: (lt, sp, e, el) => this.triggerHoverPreview(lt, sp, e, el),
			onSetActiveCard: (path) => this.setActiveCard(path),
			onOpenInBackgroundTab: (file) => this.openInBackgroundTab(file),
			onFocusCard: (path) => {
				this._keyboardFocusPath = path;
			},
			onUpdateFilenameProperty: (file, newTitle) => this.updateFilenameProperty(file, newTitle),
			onDeleteCard: (file) => this.confirmDeleteCard(file),
			onBeginInlineEdit: (editingEl) => this._fitBoardToKeyboard(editingEl),
		};
	}

	/**
	 * Update the `filename` frontmatter property with a new human-readable title.
	 * The actual file name (datetime stamp) is left unchanged.
	 */
	private async updateFilenameProperty(file: TFile, newTitle: string): Promise<void> {
		if (!this.app?.fileManager) return;
		try {
			await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				frontmatter['filename'] = newTitle;
			});
		} catch (error) {
			console.error('Error updating filename property:', error);
			new Notice('Could not update card title.');
		}
	}

	private createCard(entry: BasesEntry): HTMLElement {
		return createCardEl(entry, this._buildCardCtx(), this._buildCardCallbacks());
	}

	/**
	 * Prompt for confirmation, then move the card's underlying note to the
	 * configured trash location.
	 */
	private confirmDeleteCard(file: TFile): void {
		if (!this.app) return;
		const title = file.basename;
		new ConfirmModal(this.app, {
			title: 'Delete card',
			message: `Delete "${title}"? The note will be moved to trash.`,
			confirmText: 'Delete',
			warning: true,
			onConfirm: () => this.deleteCard(file.path, null),
		}).open();
	}

	private applyColumnColor(columnEl: HTMLElement, colorName: string | null): void {
		applyColumnColorEl(columnEl, colorName);
	}

	private openColorPicker(anchorEl: HTMLElement, columnEl: HTMLElement, columnValue: string): void {
		this.activeColorPicker?.remove();
		this.activeColorPicker = null;

		const popover = anchorEl.doc.createElement('div');
		popover.className = CSS_CLASSES.COLUMN_COLOR_POPOVER;

		const currentColor = columnEl.getAttribute(DATA_ATTRIBUTES.COLUMN_COLOR);

		const noneSwatch = anchorEl.doc.createElement('div');
		noneSwatch.className = `${CSS_CLASSES.COLUMN_COLOR_SWATCH} ${CSS_CLASSES.COLUMN_COLOR_NONE}`;
		if (!currentColor) noneSwatch.classList.add(CSS_CLASSES.COLUMN_COLOR_SWATCH_ACTIVE);
		noneSwatch.title = 'No color';
		noneSwatch.addEventListener('click', () => {
			this.applyColumnColor(columnEl, null);
			delete this._prefs.columnColors[columnValue];
			this._persistPrefs();
			popover.remove();
			this.activeColorPicker = null;
		});
		popover.appendChild(noneSwatch);

		for (const color of COLOR_PALETTE) {
			const swatch = anchorEl.doc.createElement('div');
			swatch.className = CSS_CLASSES.COLUMN_COLOR_SWATCH;
			swatch.style.background = color.cssVar;
			swatch.title = color.name;
			if (currentColor === color.name) swatch.classList.add(CSS_CLASSES.COLUMN_COLOR_SWATCH_ACTIVE);
			swatch.addEventListener('click', () => {
				this.applyColumnColor(columnEl, color.name);
				this._prefs.columnColors[columnValue] = color.name;
				this._persistPrefs();
				popover.remove();
				this.activeColorPicker = null;
			});
			popover.appendChild(swatch);
		}

		const rect = anchorEl.getBoundingClientRect();
		popover.style.top = `${rect.bottom + 4}px`;
		popover.style.left = `${rect.left}px`;
		anchorEl.doc.body.appendChild(popover);
		this.activeColorPicker = popover;

		const dismiss = (e: MouseEvent) => {
			if (e.target instanceof Node && !popover.contains(e.target) && e.target !== anchorEl) {
				popover.remove();
				this.activeColorPicker = null;
				anchorEl.doc.removeEventListener('click', dismiss);
			}
		};
		anchorEl.doc.addEventListener('click', dismiss);
	}

	private getQuickAddFolder(): string | null {
		const raw = this.config?.get('quickAddFolder');
		if (typeof raw !== 'string') return null;
		const trimmed = raw.trim();
		if (!trimmed) return null;
		return normalizePath(trimmed);
	}

	private _buildQuickAddCtx(): QuickAddCtx {
		return {
			app: this.app,
			doc: this.containerEl.doc,
			prefsPropertyId: this._prefsPropertyId,
			prefsSwimlanePropertyId: this._prefsSwimlanePropertyId,
			quickAddFolder: this.getQuickAddFolder(),
		};
	}

	private _buildQuickAddCallbacks(): QuickAddCallbacks {
		return {
			createFileForView: (path, setFm) => this._createFileForViewKeepingFocus(path, setFm),
			getMarkdownFilePaths: () => new Set(this.app?.vault.getMarkdownFiles().map((f) => f.path) ?? []),
			moveFileToFolder: (prev, baseFileName, targetFolder) =>
				this._moveCreatedFileToFolder(prev, baseFileName, targetFolder),
			onCardCreated: (filePath, columnValue, swimlaneValue) => this._onCardCreated(filePath, columnValue, swimlaneValue),
		};
	}

	/**
	 * Wrap BasesView.createFileForView so quick-add never navigates away from
	 * the board.
	 *
	 * On mobile Obsidian opens the freshly created note full-screen, pushing
	 * the kanban view off-screen. We capture the kanban's leaf beforehand and
	 * re-reveal it once creation settles. The note open can happen a frame or
	 * two after our await resolves, so we restore aggressively over a few
	 * delays to win that race without a visible flash.
	 */
	private async _createFileForViewKeepingFocus(
		path: string,
		setFm: (frontmatter: Record<string, unknown>) => void,
	): Promise<void> {
		const workspace = this.app?.workspace;
		// Desktop keeps the existing behavior — the board stays put there.
		if (!workspace || !Platform.isMobile) {
			await this.createFileForView(path, setFm);
			return;
		}

		const kanbanLeaf = workspace.getMostRecentLeaf();
		await this.createFileForView(path, setFm);

		if (!kanbanLeaf) return;
		const restore = () => {
			const active = workspace.getMostRecentLeaf();
			if (active === kanbanLeaf) return;
			workspace.setActiveLeaf(kanbanLeaf, { focus: false });
			void workspace.revealLeaf(kanbanLeaf);
		};
		restore();
		for (const delay of [0, 50, 150, 400]) {
			window.setTimeout(restore, delay);
		}
	}

	/**
	 * Called after a quick-add card has been created and placed in the vault.
	 * Prepends it to the front of its column's saved order (removing it from any
	 * other column first, so it can't be duplicated) and persists — an explicit
	 * ordering event. Then schedules focus/scroll once its element appears.
	 */
	private _onCardCreated(filePath: string, columnValue: string, swimlaneValue: string | null): void {
		if (this._prefsPropertyId) {
			moveToFront(this._prefs.cardOrders, this.cardOrderKey(swimlaneValue, columnValue), filePath);
			this._persistPrefs();
		}
		// On mobile, focusing the freshly created card causes Obsidian to open
		// the note (or bring up the soft keyboard via the inline editor). The
		// user asked that adding a task not open it, so we only scroll it into
		// view without stealing focus. On desktop we keep the focus behavior so
		// keyboard users can immediately act on the new card.
		if (Platform.isMobile) {
			this._pendingCreatedScrollPath = filePath;
			this._pendingCreatedFocusPath = null;
			return;
		}
		// Use a dedicated field immune to onFocusCard overwrites so Obsidian's
		// modal-close focus restoration can't steal the target.
		this._pendingCreatedFocusPath = filePath;
	}

	/**
	 * Snapshot vault markdown files BEFORE calling createFileForView, then call
	 * this to find and move the newly created file into targetFolder.
	 * Using a pre/post diff avoids relying on basename matching (which breaks
	 * when Bases deduplicates the name, e.g. "Card 1.md").
	 */
	private async _moveCreatedFileToFolder(
		previousPaths: Set<string>,
		baseFileName: string,
		targetFolder: string,
	): Promise<string | null> {
		if (!this.app?.vault || !this.app?.fileManager) return null;

		const folder = this.app.vault.getFolderByPath(targetFolder);
		if (!folder) {
			new Notice(`Quick add folder not found: ${targetFolder}`);
			return null;
		}

		// createFileForView may resolve before the file is flushed to the vault
		// index. Poll until the new file appears (up to ~2 s in 50 ms steps).
		// Match by path diff (any new path not in the pre-snapshot) to avoid
		// relying on basename, which breaks when the filename contains multiple
		// dots (Obsidian treats everything after the first dot as the extension).
		const findCreated = () => this.app?.vault.getMarkdownFiles().find((f) => !previousPaths.has(f.path)) ?? null;

		let created = findCreated();
		if (!created) {
			await new Promise<void>((resolve) => {
				const INTERVAL = 50;
				const MAX_ATTEMPTS = 40; // 2 s total
				let attempts = 0;
				const poll = () => {
					created = findCreated();
					if (created || ++attempts >= MAX_ATTEMPTS) {
						resolve();
					} else {
						window.setTimeout(poll, INTERVAL);
					}
				};
				window.setTimeout(poll, INTERVAL);
			});
		}

		if (!created) return null;

		// Already in the right place — move not needed, return current path.
		if (created.parent?.path === targetFolder) return created.path;

		const destPath = normalizePath(`${targetFolder}/${created.name}`);
		await this.app.fileManager.renameFile(created, destPath);
		return destPath;
	}

	private async createQuickAddCard(title: string, columnValue: string, swimlaneValue: string | null): Promise<void> {
		return createQuickAddCardEl(
			title,
			columnValue,
			swimlaneValue,
			this._buildQuickAddCtx(),
			this._buildQuickAddCallbacks(),
		);
	}

	private closeNativeNewItemPopover(): void {
		closeNativeNewItemPopoverEl(this.containerEl.doc);
	}

	private detachColumn(value: string, colEl: HTMLElement): void {
		const sortable = this._columnSortables.get(value);
		if (sortable) {
			sortable.destroy();
			this._columnSortables.delete(value);
		}
		colEl.remove();
	}

	private removeColumn(value: string, columnEl: HTMLElement): void {
		if (!this._prefsPropertyId) return;
		this._prefs.columnOrder = this._prefs.columnOrder.filter((v) => v !== value);
		this._persistPrefs();
		this.detachColumn(value, columnEl);
	}

	private toggleColumnHidden(value: string, hidden: boolean): void {
		if (hidden) {
			this._prefs.hiddenColumns.add(value);
		} else {
			this._prefs.hiddenColumns.delete(value);
		}

		// Apply the collapse directly to the DOM, in place, for every column with
		// this value (there is one per swimlane). The DOM is identical in both
		// states — only the `.obk-column--hidden` class differs — so this never
		// rebuilds the board and the horizontal scroll position is preserved.
		// Mirrors toggleSwimlaneCollapsed; hidden state is excluded from the
		// render signature so the config.set() persistence below is a no-op render.
		const board = this.containerEl.querySelector(`.${CSS_CLASSES.BOARD}`);
		board?.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.COLUMN}`).forEach((colEl) => {
			if (colEl.getAttribute(DATA_ATTRIBUTES.COLUMN_VALUE) !== value) return;
			colEl.classList.toggle(CSS_CLASSES.COLUMN_HIDDEN, hidden);
			if (hidden) {
				colEl.setAttribute(DATA_ATTRIBUTES.COLUMN_HIDDEN, 'true');
				// A collapsed body is non-interactive, so it can never receive the
				// pointerdown that lazily attaches a visible column's sortable. Attach
				// now so the strip is a drop target immediately.
				this.ensureColumnSortable(colEl, value);
			} else {
				colEl.removeAttribute(DATA_ATTRIBUTES.COLUMN_HIDDEN);
			}
		});

		this._persistPrefs();
	}

	/**
	 * Attach the card sortable for a column immediately if it isn't already
	 * attached, flushing any pending deferred-attach listener first.
	 */
	private ensureColumnSortable(colEl: HTMLElement, value: string): void {
		const laneEl = colEl.closest<HTMLElement>(`.${CSS_CLASSES.SWIMLANE}`);
		const laneValue = laneEl?.getAttribute(DATA_ATTRIBUTES.SWIMLANE_VALUE) ?? null;
		const key = this.cardOrderKey(laneValue, value);
		if (this._columnSortables.has(key)) return;
		const deferred = this._deferredSortableListeners.get(key);
		if (deferred) {
			deferred.el.removeEventListener('pointerdown', deferred.handler);
			this._deferredSortableListeners.delete(key);
		}
		const body = colEl.querySelector<HTMLElement>(`.${CSS_CLASSES.COLUMN_BODY}[${DATA_ATTRIBUTES.SORTABLE_CONTAINER}]`);
		if (body) this.attachCardSortable(body, key);
	}

	private attachCardSortable(body: HTMLElement, value: string): void {
		const sortable = new Sortable(body, {
			group: SORTABLE_GROUP,

			animation: SORTABLE_CONFIG.ANIMATION_DURATION,

			// require a press-and-hold before drag begins on touch so that
			// swiping to scroll a column isn't mistaken for a card drag
			delay: SORTABLE_CONFIG.TOUCH_DELAY,
			delayOnTouchOnly: true,
			touchStartThreshold: SORTABLE_CONFIG.TOUCH_START_THRESHOLD,

			// Keep same-column sorting enabled so Sortable can report whether the
			// user actually tried to move a card. Sorted boards snap back in
			// handleCardDrop after optionally showing an action-specific notice.
			sort: true,

			dragClass: CSS_CLASSES.CARD_DRAGGING,
			ghostClass: CSS_CLASSES.CARD_GHOST,
			chosenClass: CSS_CLASSES.CARD_CHOSEN,
			onStart: (evt: Sortable.SortableEvent) => {
				this._dragging = true;
				this.containerEl.querySelector(`.${CSS_CLASSES.BOARD}`)?.classList.add(CSS_CLASSES.BOARD_CARD_DRAGGING);
				if (evt.item.instanceOf(HTMLElement)) evt.item.classList.remove(CSS_CLASSES.CARD_HOVER);
			},
			onEnd: (evt: Sortable.SortableEvent) => {
				this._dragging = false;
				this.containerEl.querySelector(`.${CSS_CLASSES.BOARD}`)?.classList.remove(CSS_CLASSES.BOARD_CARD_DRAGGING);
				this.setActiveCard(null);
				void this.handleCardDrop(evt);
			},
		});
		this._columnSortables.set(value, sortable);
	}

	/**
	 * Capture the post-drag card order from the DOM into `_prefs.cardOrders`.
	 *
	 * This is the only place that reads order from the DOM, and it exists because
	 * Sortable applies a drag *purely to the DOM*: a same-column reorder changes
	 * nothing in `this.data.data`, and a cross-column drop's exact landing
	 * position is likewise DOM-only. The reconcile step (which rebuilds from the
	 * data/query order) therefore cannot see a drag and would revert it.
	 *
	 * Walks every column body, recording each card's entry path in DOM order,
	 * skipping Sortable's transient drag clone (the `seen` set). Stale keys and
	 * cross-column uniqueness are also handled here, but the next render's
	 * reconcile + normalize would enforce both anyway — capturing drag intent is
	 * the irreplaceable job.
	 */
	private rebuildCardOrdersFromDOM(): void {
		const boardEl = this.containerEl.querySelector<HTMLElement>(`.${CSS_CLASSES.BOARD}`);
		if (!boardEl) {
			console.warn('rebuildCardOrdersFromDOM: board element not found');
			return;
		}

		const seen = new Set<string>();
		const rebuilt: Record<string, string[]> = {};

		boardEl.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.COLUMN_BODY}`).forEach((body) => {
			const colEl = body.closest<HTMLElement>(`.${CSS_CLASSES.COLUMN}`);
			const colVal = colEl?.getAttribute(DATA_ATTRIBUTES.COLUMN_VALUE);
			if (!colVal) return;
			const laneEl = body.closest<HTMLElement>(`.${CSS_CLASSES.SWIMLANE}`);
			const laneVal = laneEl?.getAttribute(DATA_ATTRIBUTES.SWIMLANE_VALUE) ?? null;
			const key = this.cardOrderKey(laneVal, colVal);

			const paths: string[] = [];
			body.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.CARD}`).forEach((card) => {
				const path = card.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH);
				// Skip Sortable's drag clone/placeholder and any path already
				// claimed by an earlier cell so each path is recorded exactly once.
				if (!path || seen.has(path)) return;
				seen.add(path);
				paths.push(path);
			});
			rebuilt[key] = paths;
		});

		this._prefs.cardOrders = rebuilt;
	}

	private async handleCardDrop(evt: Sortable.SortableEvent): Promise<void> {
		if (!evt.item.instanceOf(HTMLElement)) {
			console.warn('Card element is not an HTMLElement:', evt.item);
			return;
		}

		const cardEl = evt.item;
		const entryPath = cardEl.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH);

		if (!entryPath) {
			console.warn('No entry path found on card');
			return;
		}

		const columnSelector = `.${CSS_CLASSES.COLUMN}`;
		const oldColumnEl = evt.from.closest(columnSelector);
		const newColumnEl = evt.to.closest(columnSelector);

		if (!newColumnEl || !newColumnEl.instanceOf(HTMLElement)) {
			console.warn('Could not find new column element');
			return;
		}

		const oldColumnValue = oldColumnEl?.instanceOf(HTMLElement)
			? oldColumnEl.getAttribute(DATA_ATTRIBUTES.COLUMN_VALUE)
			: null;
		const newColumnValue = newColumnEl.getAttribute(DATA_ATTRIBUTES.COLUMN_VALUE);

		if (!newColumnValue) {
			console.warn('No column value found');
			return;
		}

		if (!this._prefsPropertyId) {
			console.warn('No group by property ID set');
			return;
		}

		// Resolve swimlane axis (if active) from the dragged card's surrounding lanes
		const swimlaneSelector = `.${CSS_CLASSES.SWIMLANE}`;
		const oldLaneEl = evt.from.closest(swimlaneSelector);
		const newLaneEl = evt.to.closest(swimlaneSelector);
		const swimlaneActive = newLaneEl?.instanceOf(HTMLElement) ?? false;
		const oldLaneValue = oldLaneEl?.instanceOf(HTMLElement)
			? oldLaneEl.getAttribute(DATA_ATTRIBUTES.SWIMLANE_VALUE)
			: null;
		const newLaneValue = swimlaneActive ? newLaneEl.getAttribute(DATA_ATTRIBUTES.SWIMLANE_VALUE) : null;

		const newKey = this.cardOrderKey(newLaneValue, newColumnValue);
		const sortActive = this.hasActiveSort();

		// eslint-disable-next-line obsidianmd/rule-custom-message -- temporary debug logging
		console.log('[obk] handleCardDrop (drag complete)', {
			cardFilename: this._entryMap.get(entryPath)?.file.basename ?? entryPath,
			attributeFilename: cardEl.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH) ?? entryPath,
			columnBefore: oldColumnValue,
			columnAfter: newColumnValue,
			laneBefore: oldLaneValue,
			laneAfter: newLaneValue,
			indexBefore: evt.oldIndex,
			indexAfter: evt.newIndex,
			sortActive,
		});

		// Same cell reorder
		if (oldLaneValue === newLaneValue && oldColumnValue === newColumnValue) {
			if (sortActive) {
				if (this.didSortableIndexChange(evt)) {
					new Notice(SORTED_CARD_ORDER_NOTICE, 4000);
				}
				this.render(true);
				return;
			}
			// Rebuild every column's order from the authoritative DOM so stale or
			// duplicated entries can't accumulate.
			this.rebuildCardOrdersFromDOM();
			this._persistPrefs();
			return;
		}

		// Cross-cell drop
		if (!sortActive) {
			// Rebuild every column's order from the authoritative DOM. This
			// captures both the source and destination columns (and every other
			// column) in one pass, and guarantees no path appears in more than one
			// column's order — eliminating the duplication seen with per-key updates.
			this.rebuildCardOrdersFromDOM();
			// Collapsed (hidden) destination columns render their cards with
			// display:none, so Sortable can't position the drop — it lands at the
			// end of the DOM. Force the dropped card to the top instead.
			if (newColumnEl.classList.contains(CSS_CLASSES.COLUMN_HIDDEN)) {
				const existing = this._prefs.cardOrders[newKey] ?? [];
				this._prefs.cardOrders[newKey] = [entryPath, ...existing.filter((p) => p !== entryPath)];
			}
			this._persistPrefs();
		}

		const entry = this._entryMap.get(entryPath);
		if (!entry) {
			console.warn('Entry not found for path:', entryPath);
			return;
		}

		if (!this.app?.fileManager) {
			console.warn('File manager not available');
			return;
		}

		try {
			const columnValueToSet = newColumnValue === UNCATEGORIZED_LABEL ? '' : newColumnValue;
			const columnPropertyName = parsePropertyId(this._prefsPropertyId).name;

			const swimlanePropertyId = swimlaneActive ? this._prefsSwimlanePropertyId : null;
			const swimlaneCrossed =
				swimlaneActive && swimlanePropertyId !== null && newLaneValue !== null && oldLaneValue !== newLaneValue;
			const swimlanePropertyName = swimlaneCrossed ? parsePropertyId(swimlanePropertyId).name : null;
			const swimlaneValueToSet = swimlaneCrossed && newLaneValue !== UNCATEGORIZED_LABEL ? newLaneValue : '';

			await this.app.fileManager.processFrontMatter(entry.file, (frontmatter: Record<string, unknown>) => {
				if (columnValueToSet === '') {
					delete frontmatter[columnPropertyName];
				} else {
					frontmatter[columnPropertyName] = columnValueToSet;
				}
				if (swimlanePropertyName) {
					if (swimlaneValueToSet === '') {
						delete frontmatter[swimlanePropertyName];
					} else {
						frontmatter[swimlanePropertyName] = swimlaneValueToSet;
					}
				}
			});
		} catch (error) {
			console.error('Error updating entry property:', error);
			this.render(true);
		}
	}

	/**
	 * Dependencies the extracted card-move functions in cardOrder.ts need.
	 * Built fresh per call so it always reflects current view state.
	 */
	private _cardMoveContext(): CardMoveContext {
		return {
			app: this.app,
			prefsPropertyId: this._prefsPropertyId,
			cardOrders: this._prefs.cardOrders,
			entryMap: this._entryMap,
			cardOrderKey: (swimlaneValue, columnValue) => this.cardOrderKey(swimlaneValue, columnValue),
			findCardEl: (path) => this.findCardEl(path),
			persistPrefs: () => this._persistPrefs(),
			setKeyboardFocusPath: (path) => {
				this._keyboardFocusPath = path;
			},
			rerender: () => this.render(true),
		};
	}

	/**
	 * Move a card to a different column (Cmd/Ctrl + Left/Right). Delegates to
	 * cardOrder.ts; see moveCardToColumn there.
	 */
	private moveCardToColumn(entryPath: string, newColumnValue: string): Promise<void> {
		return moveCardToColumnImpl(this._cardMoveContext(), entryPath, newColumnValue);
	}

	/**
	 * Reorder a card within its column (Cmd/Ctrl + Up/Down). Delegates to
	 * cardOrder.ts; see reorderCardInColumn there.
	 */
	private reorderCardInColumn(
		entryPath: string,
		columnValue: string,
		swimlaneValue: string | null,
		direction: 'up' | 'down',
	): void {
		reorderCardInColumnImpl(this._cardMoveContext(), entryPath, columnValue, swimlaneValue, direction);
	}

	/** Trash the card file (Ctrl+Delete). Moves focus to focusPath after deletion. */
	private async deleteCard(entryPath: string, focusPath: string | null): Promise<void> {
		if (!this.app?.fileManager) return;
		const entry = this._entryMap.get(entryPath);
		if (!entry) return;

		const title = entry.file.basename;
		this._keyboardFocusPath = focusPath;

		try {
			await this.app.fileManager.trashFile(entry.file);
			new Notice(`Deleted "${title}"`);
		} catch (error) {
			console.error('Error deleting card:', error);
			new Notice('Could not delete card.');
		}
	}

	/**
	 * Open the quick-add modal for a given column (Ctrl+A).
	 * Opens the modal directly with full ctx/callbacks.
	 */
	private openQuickAddForColumn(columnValue: string, swimlaneValue: string | null): void {
		if (!this.app) return;
		const ctx = this._buildQuickAddCtx();
		const cb = this._buildQuickAddCallbacks();
		// On mobile the on-screen keyboard shrinks the leaf's visible height,
		// which would otherwise reflow the percentage-height board and resize
		// every column. Pin the container to its current pixel height for the
		// lifetime of the modal so the columns stay put, and restore on close.
		const unlockHeight = this._lockBoardHeightForModal();
		new QuickAddModal(this.app, {
			columnValue,
			swimlaneValue,
			onSubmit: (title) => createQuickAddCardEl(title, columnValue, swimlaneValue, ctx, cb),
			onClose: () => unlockHeight(),
		}).open();
	}

	/**
	 * Freeze the board at its current (pre-keyboard) pixel height so the soft
	 * keyboard's viewport resize doesn't reflow the columns or leave a black gap.
	 *
	 * Obsidian's mobile WebView resizes the leaf when the on-screen keyboard
	 * opens; with a percentage-height board that reflows every column, and the
	 * shrinking parent leaves an empty band above the keyboard. We snapshot the
	 * height before the keyboard appears, pin both the leaf scroll element and
	 * our container to it, and keep re-asserting that height on every
	 * visualViewport resize for the lifetime of the modal. The keyboard then
	 * simply overlays the bottom of the (unchanged) board. Restores on close.
	 *
	 * No-op off mobile.
	 */
	private _lockBoardHeightForModal(): () => void {
		if (!Platform.isMobile) return () => {};
		const container = this.containerEl;
		const scrollEl = this.scrollEl;
		const height = Math.round(scrollEl.getBoundingClientRect().height || container.getBoundingClientRect().height);
		if (height <= 0) return () => {};

		const px = `${height}px`;
		const saved: Array<{ el: HTMLElement; height: string; maxHeight: string; minHeight: string }> = [];
		const pin = (el: HTMLElement) => {
			saved.push({ el, height: el.style.height, maxHeight: el.style.maxHeight, minHeight: el.style.minHeight });
			el.style.height = px;
			el.style.maxHeight = px;
			el.style.minHeight = px;
		};
		// Pin our container, the leaf scroll element, and the leaf-content
		// ancestor so neither the reflow nor a black gap can appear when the
		// WebView shrinks for the keyboard.
		const pinned: HTMLElement[] = [container, scrollEl];
		const leafContent = scrollEl.closest<HTMLElement>('.workspace-leaf-content, .view-content');
		if (leafContent && !pinned.includes(leafContent)) pinned.push(leafContent);
		pinned.forEach(pin);

		// Re-assert after layout settles (the keyboard can resize a frame or two
		// later) and on every visualViewport change while the modal is open.
		const reassert = () => {
			for (const el of pinned) {
				el.style.height = px;
				el.style.maxHeight = px;
				el.style.minHeight = px;
			}
		};
		const vv = window.visualViewport;
		vv?.addEventListener('resize', reassert);
		vv?.addEventListener('scroll', reassert);
		const timers = [0, 50, 150, 300, 600].map((d) => window.setTimeout(reassert, d));

		let restored = false;
		return () => {
			if (restored) return;
			restored = true;
			vv?.removeEventListener('resize', reassert);
			vv?.removeEventListener('scroll', reassert);
			timers.forEach((t) => window.clearTimeout(t));
			for (const s of saved) {
				s.el.style.height = s.height;
				s.el.style.maxHeight = s.maxHeight;
				s.el.style.minHeight = s.minHeight;
			}
		};
	}

	/**
	 * Fit the board into the space above the on-screen keyboard while inline
	 * editing a card, then keep the edited field scrolled into view.
	 *
	 * Unlike `_lockBoardHeightForModal` (which freezes the board at full height so
	 * a floating modal can overlay it), inline editing happens *inside* the board,
	 * so the board must shrink to the visible region — otherwise the edited card
	 * can sit behind the keyboard with no way to scroll to it. We size our
	 * container, the leaf scroll element, and the leaf-content ancestor so their
	 * bottoms meet the top of the keyboard (the visualViewport bottom), re-fitting
	 * on every visualViewport change, and scroll the edited field into view.
	 * Restores the original styles when editing ends.
	 *
	 * No-op off mobile.
	 *
	 * @param focusEl The element to keep visible above the keyboard.
	 */
	private _fitBoardToKeyboard(focusEl: HTMLElement): () => void {
		const vv = window.visualViewport;
		if (!Platform.isMobile || !vv) return () => {};

		const container = this.containerEl;
		const scrollEl = this.scrollEl;
		const targets: HTMLElement[] = [container, scrollEl];
		const leafContent = scrollEl.closest<HTMLElement>('.workspace-leaf-content, .view-content');
		if (leafContent && !targets.includes(leafContent)) targets.push(leafContent);

		const saved = targets.map((el) => ({
			el,
			height: el.style.height,
			maxHeight: el.style.maxHeight,
			minHeight: el.style.minHeight,
		}));

		// Shrink the columns (halved, for now) so the board fits the reduced
		// space above the keyboard instead of overflowing behind it.
		container.classList.add(CSS_CLASSES.VIEW_CONTAINER_EDITING);

		const fit = () => {
			// The visible region spans [vv.offsetTop, vv.offsetTop + vv.height].
			// Size each element so its bottom meets the keyboard top.
			const visibleBottom = (vv.offsetTop ?? 0) + vv.height;
			// Read all tops before writing any heights so a height change doesn't
			// perturb the next element's measurement mid-loop.
			const tops = targets.map((el) => el.getBoundingClientRect().top);
			targets.forEach((el, i) => {
				const avail = Math.round(visibleBottom - tops[i]);
				if (avail <= 0) return;
				const px = `${avail}px`;
				el.style.height = px;
				el.style.maxHeight = px;
				el.style.minHeight = px;
			});
			focusEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		};

		vv.addEventListener('resize', fit);
		vv.addEventListener('scroll', fit);
		// The keyboard animates open over a few frames; re-fit as it settles.
		const timers = [0, 50, 150, 300, 600].map((d) => window.setTimeout(fit, d));

		let restored = false;
		return () => {
			if (restored) return;
			restored = true;
			container.classList.remove(CSS_CLASSES.VIEW_CONTAINER_EDITING);
			vv.removeEventListener('resize', fit);
			vv.removeEventListener('scroll', fit);
			timers.forEach((t) => window.clearTimeout(t));
			for (const s of saved) {
				s.el.style.height = s.height;
				s.el.style.maxHeight = s.maxHeight;
				s.el.style.minHeight = s.minHeight;
			}
		};
	}

	private findCardEl(path: string): HTMLElement | null {
		return (
			Array.from(this.containerEl.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.CARD}`)).find(
				(el) => el.getAttribute(DATA_ATTRIBUTES.ENTRY_PATH) === path,
			) ?? null
		);
	}

	/**
	 * Open a file in a new background tab, keeping the kanban as the active leaf.
	 *
	 * Obsidian's getLeaf('tab') makes the new tab the visible one in its group,
	 * so we capture the kanban's leaf, kick off openFile (fire-and-forget), and
	 * switch the active leaf back synchronously — before the browser repaints —
	 * so the new tab is never visible to the user. { focus: false } avoids an
	 * extra focus-driven scroll-into-view; the kanban still becomes the active
	 * (visible) leaf.
	 *
	 * During the leaf swap a transient layout pass clamps column scrollTop on
	 * image-backed cards (their <img> hasn't decoded, so scrollHeight briefly
	 * shrinks). We capture column scroll positions and restore them aggressively —
	 * synchronously plus over several animation frames — so no paint shows the
	 * clamped state.
	 */
	private openInBackgroundTab(file: TFile): void {
		if (!this.app?.workspace) return;

		const scrollPositions: Array<[HTMLElement, number]> = [];
		this.containerEl.querySelectorAll<HTMLElement>(`.${CSS_CLASSES.COLUMN_BODY}`).forEach((body) => {
			if (body.scrollTop > 0) scrollPositions.push([body, body.scrollTop]);
		});

		const previousLeaf = this.app.workspace.getMostRecentLeaf();
		const newLeaf = this.app.workspace.getLeaf('tab');
		void newLeaf.openFile(file, { active: false });
		if (previousLeaf && previousLeaf !== newLeaf) {
			this.app.workspace.setActiveLeaf(previousLeaf, { focus: false });
		}

		if (scrollPositions.length === 0) return;
		const restore = () => {
			scrollPositions.forEach(([body, top]) => {
				if (body.scrollTop !== top) body.scrollTop = top;
			});
		};
		restore();
		let frames = 4;
		const tick = () => {
			restore();
			if (--frames > 0) window.requestAnimationFrame(tick);
		};
		window.requestAnimationFrame(tick);
	}

	private openCardInPopout(entryPath: string): void {
		if (!this.app?.workspace) return;
		void this.app.workspace.openLinkText(entryPath, '', 'tab');
	}

	private setActiveCard(path: string | null): void {
		if (this._activeCardPath) {
			this.findCardEl(this._activeCardPath)?.classList.remove(CSS_CLASSES.CARD_ACTIVE);
		}
		this._activeCardPath = path;
		if (path) {
			this.findCardEl(path)?.classList.add(CSS_CLASSES.CARD_ACTIVE);
		}
	}

	private reapplyActiveCard(): void {
		if (this._activeCardPath) {
			this.findCardEl(this._activeCardPath)?.classList.add(CSS_CLASSES.CARD_ACTIVE);
		}

		// Pending creation focus takes priority — it must survive modal close
		// focus restoration and multiple render cycles until the card appears.
		if (this._pendingCreatedFocusPath) {
			const path = this._pendingCreatedFocusPath;
			const cardEl = this.findCardEl(path);
			if (cardEl) {
				window.requestAnimationFrame(() => {
					cardEl.focus({ preventScroll: false });
					cardEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
					if (this._pendingCreatedFocusPath === path) {
						this._pendingCreatedFocusPath = null;
					}
				});
			}
			// Don't clear if not found yet — next render will retry.
			return;
		}

		// Mobile: bring the new card into view without focusing it, so adding a
		// task never opens the note or triggers the inline editor.
		if (this._pendingCreatedScrollPath) {
			const path = this._pendingCreatedScrollPath;
			const cardEl = this.findCardEl(path);
			if (cardEl) {
				window.requestAnimationFrame(() => {
					cardEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
					if (this._pendingCreatedScrollPath === path) {
						this._pendingCreatedScrollPath = null;
					}
				});
			}
			// Don't clear if not found yet — next render will retry.
			return;
		}

		if (this._keyboardFocusPath) {
			const path = this._keyboardFocusPath;
			const cardEl = this.findCardEl(path);
			if (cardEl) {
				window.requestAnimationFrame(() => {
					cardEl.focus({ preventScroll: false });
					if (this._keyboardFocusPath === path) {
						this._keyboardFocusPath = null;
					}
				});
			}
		}
	}

	private didSortableIndexChange(evt: Sortable.SortableEvent): boolean {
		if (evt.oldDraggableIndex !== undefined || evt.newDraggableIndex !== undefined) {
			return evt.oldDraggableIndex !== evt.newDraggableIndex;
		}
		if (evt.oldIndex !== undefined || evt.newIndex !== undefined) {
			return evt.oldIndex !== evt.newIndex;
		}
		return false;
	}

	private hasActiveSort(): boolean {
		const sortConfig = this.config?.getSort();
		if (Array.isArray(sortConfig)) return sortConfig.length > 0;
		if (!sortConfig || typeof sortConfig !== 'object') return Boolean(sortConfig);
		return Object.keys(sortConfig).length > 0;
	}

	private getOrderedColumnValues(liveValues: string[]): string[] {
		if (!this._prefs.columnOrder.length) return liveValues.sort();
		// Include all saved columns (even empty ones); append any new live values.
		const newValues = liveValues.filter((v) => !this._prefs.columnOrder.includes(v));
		return [...this._prefs.columnOrder, ...newValues];
	}

	/**
	 * One-time, race-free cleanup run on the first render after prefs are
	 * loaded. Using the live grouping as the source of truth it: drops orphan
	 * paths (files the Base no longer pulls), removes a path from any column it
	 * is NOT actually live in, and dedupes — so a file can never remain listed
	 * in two columns at once. Persists once if anything changed.
	 *
	 * This is NOT run on every render: render is a pure read. The cleanup is safe
	 * to persist here because it only runs immediately after load, before any
	 * in-flight frontmatter write could make the live grouping stale.
	 */
	private _cleanupCardOrders(
		groupedByLane: Map<string, Map<string, BasesEntry[]>> | null,
		groupedEntries: Map<string, BasesEntry[]>,
	): void {
		// path -> the single cardOrderKey it is actually live in
		const liveKeyOf = new Map<string, string>();
		const record = (key: string, entries: BasesEntry[]): void => {
			entries.forEach((e) => liveKeyOf.set(e.file.path, key));
		};
		if (groupedByLane) {
			groupedByLane.forEach((columns, laneValue) => {
				columns.forEach((entries, columnValue) => record(this.cardOrderKey(laneValue, columnValue), entries));
			});
		} else {
			groupedEntries.forEach((entries, columnValue) => record(this.cardOrderKey(null, columnValue), entries));
		}

		let changed = false;
		const seen = new Set<string>();
		const cleaned: CardOrders = {};
		for (const [key, list] of Object.entries(this._prefs.cardOrders)) {
			const kept: string[] = [];
			for (const path of list) {
				// Keep only paths that are live in THIS column and not already
				// claimed by an earlier column (cross-column dedupe + orphan prune).
				if (liveKeyOf.get(path) === key && !seen.has(path)) {
					seen.add(path);
					kept.push(path);
				} else {
					changed = true;
				}
			}
			cleaned[key] = kept;
		}

		if (changed) {
			this._prefs.cardOrders = cleaned;
			this._persistPrefs();
		}
	}

	/**
	 * Lay entries out for display in the saved order.
	 *
	 * Cards present in `savedOrder` keep that order; cards not yet in it (newly
	 * created, externally added, or just moved into this column) are sorted by
	 * filename and prepended to the front. When `savedOrder` is empty this is a
	 * pure filename sort — the initial seed. This is a read-only display
	 * transform: it does not mutate `_prefs.cardOrders` or persist.
	 */
	private applyCardOrder(entries: BasesEntry[], savedOrder: string[]): BasesEntry[] {
		const entryMap = new Map(entries.map((e) => [e.file.path, e]));
		const ordered = savedOrder.map((p) => entryMap.get(p)).filter((e): e is BasesEntry => e !== undefined);
		const savedSet = new Set(savedOrder);
		const fresh = entries
			.filter((e) => !savedSet.has(e.file.path))
			.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
		return [...fresh, ...ordered];
	}

	onClose(): void {
		this._debouncedRender.cancel();
		this.destroySortables();
		this.activeColorPicker?.remove();
		this.activeColorPicker = null;
	}

	/**
	 * Column state (order and colors) is persisted using BasesViewConfig.set/get
	 * (https://docs.obsidian.md/Reference/TypeScript+API/BasesViewConfig#Methods)
	 * rather than Plugin.saveData/loadData
	 * (https://docs.obsidian.md/Plugins/User+interface/Settings).
	 *
	 * Why: Plugin.saveData writes a single plugin-wide plugin.data.json, so all
	 * bases shared the same column state keyed only by property ID. Using the
	 * BasesViewConfig API instead means each .base file carries its own state —
	 * deleting and re-adding the plugin no longer wipes configuration, and two bases
	 * that group by the same property can have independent column orders and colors.
	 *
	 * Migration: versions prior to 0.3.0 wrote to plugin.data.json. The
	 * legacyData parameter passed from main.ts holds that data. On the first
	 * render after upgrade, the legacy value is written into the base config via
	 * set() and subsequent renders use _prefs which is already populated — so
	 * this migration path is exercised at most once per base.
	 *
	 * plugin.data.json is intentionally left in place after migration rather than
	 * deleted: removing it would be destructive if something went wrong mid-upgrade,
	 * and the file simply becomes stale once each base has migrated its own state.
	 */

	static getViewOptions(this: void): ViewOption[] {
		return [
			{
				displayName: 'Group by',
				type: 'property',
				key: 'groupByProperty',
				filter: (prop: string) => !prop.startsWith('file.'),
				placeholder: 'Select property',
			},
			{
				displayName: 'Swimlane by',
				type: 'property',
				key: 'swimlaneByProperty',
				filter: (prop: string) => !prop.startsWith('file.'),
				placeholder: 'Optional: horizontal grouping',
			},
			{
				displayName: 'Add card to column folder',
				type: 'folder',
				key: 'quickAddFolder',
				placeholder: 'Required for + button',
			},
			{
				displayName: 'Card title property',
				type: 'property',
				key: 'cardTitleProperty',
				placeholder: 'Default: file name',
			},
			{
				displayName: 'Image property',
				type: 'property',
				key: 'imageProperty',
				placeholder: 'Optional: image link property',
			},
			{
				displayName: 'Image fit',
				type: 'dropdown',
				key: 'imageFit',
				default: 'cover',
				options: { cover: 'Cover', contain: 'Contain' },
			},
			{
				displayName: 'Image aspect ratio',
				type: 'slider',
				key: 'imageAspectRatio',
				default: 0.5,
				min: 0.25,
				max: 2.5,
				step: 0.05,
			},
			{
				displayName: 'Wrap property values',
				type: 'toggle',
				key: 'wrapPropertyValues',
			},
		];
	}
}
