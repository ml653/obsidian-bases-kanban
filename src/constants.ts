/**
 * Constants used throughout the Kanban view
 */

/** Label used for entries without a property value */
export const UNCATEGORIZED_LABEL = 'Uncategorized';

/**
 * Frontmatter property used to store the human-readable card title.
 * Files are named with a datetime stamp; this property holds the original title.
 * It is suppressed from the property list on cards (shown as the title instead).
 */
export const FILENAME_PROPERTY = 'note.filename' as const satisfies `note.${string}`;

/** Source id registered with Obsidian's Page Preview core plugin */
export const HOVER_LINK_SOURCE_ID = 'kanban-bases-view';

/** Color palette for column accents, using Obsidian design system variables */
export const COLOR_PALETTE = [
	{ name: 'red', cssVar: 'var(--color-red)' },
	{ name: 'orange', cssVar: 'var(--color-orange)' },
	{ name: 'yellow', cssVar: 'var(--color-yellow)' },
	{ name: 'green', cssVar: 'var(--color-green)' },
	{ name: 'cyan', cssVar: 'var(--color-cyan)' },
	{ name: 'blue', cssVar: 'var(--color-blue)' },
	{ name: 'purple', cssVar: 'var(--color-purple)' },
	{ name: 'pink', cssVar: 'var(--color-pink)' },
] as const;

export type ColorName = (typeof COLOR_PALETTE)[number]['name'];

/** Sortable.js group name for kanban columns */
export const SORTABLE_GROUP = 'obk-columns';

/** Notice shown when Base sorting prevents manual card ordering */
export const SORTED_CARD_ORDER_NOTICE = '⚠️ Sort is active. Clear it to manually reorder cards within a column.';

/** Data attribute names */
export const DATA_ATTRIBUTES = {
	COLUMN_VALUE: 'data-column-value',
	ENTRY_PATH: 'data-entry-path',
	SORTABLE_CONTAINER: 'data-sortable-container',
	COLUMN_POSITION: 'data-column-position',
	COLUMN_COLOR: 'data-column-color',
	SWIMLANE_VALUE: 'data-swimlane-value',
	COLUMN_HIDDEN: 'data-column-hidden',
} as const;

/**
 * Separator used to build composite cardOrders keys when swimlanes are active.
 * Unit Separator (U+001F) is unlikely to occur inside a property value.
 */
export const SWIMLANE_KEY_SEPARATOR = '\u001F';

/** CSS class names */
export const CSS_CLASSES = {
	// Container
	VIEW_CONTAINER: 'obk-view-container',
	VIEW_CONTAINER_WITH_SWIMLANES: 'obk-view-container--with-swimlanes',
	BOARD: 'obk-board',
	BOARD_WITH_SWIMLANES: 'obk-board--with-swimlanes',
	BOARD_CARD_DRAGGING: 'obk-board--card-dragging',

	// Swimlane (horizontal grouping band)
	SWIMLANE: 'obk-swimlane',
	SWIMLANE_COLLAPSED: 'obk-swimlane--collapsed',
	SWIMLANE_HEADER: 'obk-swimlane-header',
	SWIMLANE_TITLE: 'obk-swimlane-title',
	SWIMLANE_COUNT: 'obk-swimlane-count',
	SWIMLANE_BODY: 'obk-swimlane-body',
	SWIMLANE_TOGGLE: 'obk-swimlane-toggle',
	SWIMLANE_DRAG_HANDLE: 'obk-swimlane-drag-handle',
	SWIMLANE_DRAGGING: 'obk-swimlane-dragging',
	SWIMLANE_GHOST: 'obk-swimlane-ghost',

	// Property selector (for future or framework-driven UI)
	PROPERTY_SELECTOR: 'obk-property-selector',
	PROPERTY_LABEL: 'obk-property-label',
	PROPERTY_SELECT: 'obk-property-select',

	// Column
	COLUMN: 'obk-column',
	COLUMN_HEADER: 'obk-column-header',
	COLUMN_TITLE: 'obk-column-title',
	COLUMN_COUNT: 'obk-column-count',
	COLUMN_BODY: 'obk-column-body',
	COLUMN_DRAG_HANDLE: 'obk-column-drag-handle',
	COLUMN_DRAGGING: 'obk-column-dragging',
	COLUMN_GHOST: 'obk-column-ghost',
	// Card
	CARD: 'obk-card',
	CARD_TITLE: 'obk-card-title',
	CARD_PREVIEW: 'obk-card-preview',
	CARD_COVER: 'obk-card-cover',
	CARD_COVER_FIT_COVER: 'obk-card-cover--fit-cover',
	CARD_COVER_FIT_CONTAIN: 'obk-card-cover--fit-contain',
	CARD_ACTIVE: 'obk-card--active',
	CARD_HOVER: 'obk-card--hover',
	CARD_MENU_BTN: 'obk-card-menu-btn',
	CARD_TITLE_INPUT: 'obk-card-title-input',
	CARD_EDITING: 'obk-card--editing',
	// Mobile inline-edit toolbar (rides above the on-screen keyboard).
	CARD_EDIT_TOOLBAR: 'obk-card-edit-toolbar',
	CARD_EDIT_TOOLBAR_BTN: 'obk-card-edit-toolbar-btn',
	CARD_DRAGGING: 'obk-card-dragging',
	CARD_GHOST: 'obk-card-ghost',
	CARD_CHOSEN: 'obk-card-chosen',
	CARD_PROPERTY: 'obk-card-property',
	CARD_PROPERTY_WRAP: 'obk-card-property-wrap',
	CARD_PROPERTY_LABEL: 'obk-card-property-label',
	CARD_PROPERTY_VALUE: 'obk-card-property-value',

	// Empty state
	EMPTY_STATE: 'obk-empty-state',

	// Sortable placeholder (fallback / shared ghost style)
	SORTABLE_GHOST: 'obk-sortable-ghost',

	// Column remove button (shown only when column is empty)
	COLUMN_REMOVE_BTN: 'obk-column-remove-btn',

	// Column hide/unhide controls
	COLUMN_MENU_BTN: 'obk-column-menu-btn',
	COLUMN_HIDDEN: 'obk-column--hidden',
	COLUMN_UNHIDE_BTN: 'obk-column-unhide-btn',

	// Column add-card button
	COLUMN_ADD_BTN: 'obk-column-add-btn',

	// Quick add modal
	QUICK_ADD_MODAL: 'obk-quick-add-modal',
	QUICK_ADD_FORM: 'obk-quick-add-form',
	QUICK_ADD_FIELD: 'obk-quick-add-field',
	QUICK_ADD_INPUT: 'obk-quick-add-input',
	QUICK_ADD_ACTIONS: 'obk-quick-add-actions',
	QUICK_ADD_DESTINATION: 'obk-quick-add-destination',
	QUICK_ADD_DESTINATION_LABEL: 'obk-quick-add-destination-label',
	QUICK_ADD_DESTINATION_PILL: 'obk-quick-add-destination-pill',
	QUICK_ADD_DESTINATION_SEP: 'obk-quick-add-destination-sep',

	// Color picker
	COLUMN_COLOR_BTN: 'obk-column-color-btn',
	COLUMN_COLOR_POPOVER: 'obk-column-color-popover',
	COLUMN_COLOR_SWATCH: 'obk-column-color-swatch',
	COLUMN_COLOR_SWATCH_ACTIVE: 'obk-column-color-swatch--active',
	COLUMN_COLOR_NONE: 'obk-column-color-none',
} as const;

/** Sortable.js configuration constants */
export const SORTABLE_CONFIG = {
	ANIMATION_DURATION: 150,
	TOUCH_DELAY: 150,
	TOUCH_START_THRESHOLD: 4,
} as const;

/** Debounce delay in ms for onDataUpdated renders */
export const DEBOUNCE_DELAY = 50;

/** Empty state messages */
export const EMPTY_STATE_MESSAGES = {
	NO_ENTRIES: 'No entries found. Add some notes to your base.',
	NO_PROPERTIES: 'No properties found in entries.',
} as const;
