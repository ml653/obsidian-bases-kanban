import type { App, BasesPropertyId } from 'obsidian';
import { Notice, parsePropertyId, setIcon } from 'obsidian';
import { QuickAddModal } from '../quickAddModal.ts';
import { CSS_CLASSES, UNCATEGORIZED_LABEL } from '../constants.ts';

export interface QuickAddCtx {
	app: App;
	doc: Document;
	prefsPropertyId: BasesPropertyId | null;
	prefsSwimlanePropertyId: BasesPropertyId | null;
	quickAddFolder: string | null;
}

export interface QuickAddCallbacks {
	createFileForView: (path: string, setFrontmatter: (fm: Record<string, unknown>) => void) => Promise<void>;
	/** previousPaths: snapshot of vault markdown paths taken before createFileForView. */
	moveFileToFolder: (previousPaths: Set<string>, baseFileName: string, targetFolder: string) => Promise<void>;
	/** Return current vault markdown file paths for snapshotting. */
	getMarkdownFilePaths: () => Set<string>;
}

function sanitizeBaseFileName(title: string): string {
	return title
		.trim()
		.replace(/\.md$/i, '')
		.replace(/[\\/:*?"<>|]/g, '-')
		.replace(/\s+/g, ' ')
		.replace(/[.\s]+$/g, '')
		.trim();
}

function todayDateFolder(): { yyyy: string; mm: string; dd: string } {
	const d = new Date();
	return {
		yyyy: String(d.getFullYear()),
		mm: String(d.getMonth() + 1).padStart(2, '0'),
		dd: String(d.getDate()).padStart(2, '0'),
	};
}

/**
 * Build the dated subfolder path: baseFolder/YYYY/MM/DD
 */
export function buildDateFolder(baseFolder: string): string {
	const { yyyy, mm, dd } = todayDateFolder();
	return `${baseFolder}/${yyyy}/${mm}/${dd}`;
}

/**
 * Build a unique filename (no extension) for the card.
 * Uses title as-is; on collision appends (2), (3), …
 */
export function buildUniqueFileName(title: string, targetFolder: string, existingPaths: Set<string>): string {
	const candidate = (n: number) => (n <= 1 ? title : `${title} (${n})`);
	let n = 1;
	while (existingPaths.has(`${targetFolder}/${candidate(n)}.md`)) n++;
	return candidate(n);
}

function getWritableFrontmatterPropertyName(propertyId: BasesPropertyId | null): string | null {
	if (!propertyId) return null;
	const parsed = parsePropertyId(propertyId);
	if (parsed.type !== 'note') return null;
	return parsed.name || null;
}

export function closeNativeNewItemPopover(doc: Document): void {
	const closePopovers = () => {
		const popovers = Array.from(doc.querySelectorAll<HTMLElement>('.bases-new-item-popover'));
		if (popovers.length === 0) return;
		doc.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		doc.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		popovers.forEach((popover) => {
			popover.remove();
		});
	};

	closePopovers();
	window.requestAnimationFrame(closePopovers);
	for (const delay of [50, 250, 1000]) {
		window.setTimeout(closePopovers, delay);
	}
}

export async function createQuickAddCard(
	title: string,
	columnValue: string,
	swimlaneValue: string | null,
	ctx: QuickAddCtx,
	cb: QuickAddCallbacks,
): Promise<void> {
	const baseFileName = sanitizeBaseFileName(title);
	if (!baseFileName) {
		new Notice('Enter a card title.');
		return;
	}

	const columnPropertyName = getWritableFrontmatterPropertyName(ctx.prefsPropertyId);
	if (!columnPropertyName) {
		new Notice('Quick add needs a writable note property for columns.');
		return;
	}

	const swimlanePropertyName = swimlaneValue ? getWritableFrontmatterPropertyName(ctx.prefsSwimlanePropertyId) : null;
	if (swimlaneValue && !swimlanePropertyName) {
		new Notice('Quick add needs a writable note property for swimlanes.');
		return;
	}

	const baseFolder = ctx.quickAddFolder;
	if (!baseFolder) {
		new Notice('Quick add requires a folder to be configured.');
		return;
	}
	if (!ctx.app?.vault.getFolderByPath(baseFolder)) {
		new Notice(`Quick add folder not found: ${baseFolder}`);
		return;
	}

	// Ensure YYYY/MM/DD subfolder exists.
	const targetFolder = buildDateFolder(baseFolder);
	if (!ctx.app.vault.getFolderByPath(targetFolder)) {
		try {
			await ctx.app.vault.createFolder(targetFolder);
		} catch {
			// May already exist if created concurrently — continue.
		}
	}

	const setFrontmatter = (frontmatter: Record<string, unknown>): void => {
		if (columnValue === UNCATEGORIZED_LABEL) {
			delete frontmatter[columnPropertyName];
		} else {
			frontmatter[columnPropertyName] = columnValue;
		}

		if (!swimlaneValue || !swimlanePropertyName) return;
		if (swimlaneValue === UNCATEGORIZED_LABEL) {
			delete frontmatter[swimlanePropertyName];
		} else {
			frontmatter[swimlanePropertyName] = swimlaneValue;
		}
	};

	try {
		const previousPaths = cb.getMarkdownFilePaths();
		const uniqueFileName = buildUniqueFileName(baseFileName, targetFolder, previousPaths);
		await cb.createFileForView(uniqueFileName, setFrontmatter);
		await cb.moveFileToFolder(previousPaths, uniqueFileName, targetFolder);
		closeNativeNewItemPopover(ctx.doc);
	} catch (error) {
		console.error('Error creating kanban card:', error);
		new Notice('Could not create card.');
	}
}

export function createAddButton(
	columnValue: string,
	swimlaneValue: string | null,
	ctx: QuickAddCtx,
	cb: QuickAddCallbacks,
): HTMLElement {
	const btn = ctx.doc.createElement('div');
	btn.className = CSS_CLASSES.COLUMN_ADD_BTN;
	btn.setAttribute(
		'aria-label',
		swimlaneValue ? `Add card to column: ${columnValue} in lane: ${swimlaneValue}` : `Add card to column: ${columnValue}`,
	);
	btn.setAttribute('role', 'button');
	btn.setAttribute('tabindex', '-1');
	setIcon(btn, 'plus');

	const open = () => {
		if (!ctx.app) return;
		new QuickAddModal(ctx.app, {
			columnValue,
			swimlaneValue,
			onSubmit: (title) => createQuickAddCard(title, columnValue, swimlaneValue, ctx, cb),
		}).open();
	};

	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		open();
	});
	btn.addEventListener('keydown', (e) => {
		if (e.key !== 'Enter' && e.key !== ' ') return;
		e.preventDefault();
		e.stopPropagation();
		open();
	});
	return btn;
}
