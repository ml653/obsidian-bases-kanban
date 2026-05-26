import type { App, BasesPropertyId } from 'obsidian';
import { Notice, parsePropertyId } from 'obsidian';
import { UNCATEGORIZED_LABEL } from '../constants.ts';

export interface QuickAddCtx {
	app: App;
	doc: Document;
	prefsPropertyId: BasesPropertyId | null;
	prefsSwimlanePropertyId: BasesPropertyId | null;
	quickAddFolder: string | null;
}

export interface QuickAddCallbacks {
	createFileForView: (path: string, setFrontmatter: (fm: Record<string, unknown>) => void) => Promise<void>;
	/** previousPaths: snapshot of vault markdown paths taken before createFileForView. Returns final file path, or null if not found. */
	moveFileToFolder: (previousPaths: Set<string>, baseFileName: string, targetFolder: string) => Promise<string | null>;
	/** Return current vault markdown file paths for snapshotting. */
	getMarkdownFilePaths: () => Set<string>;
	/** Called after the card file is created and placed; receives the final vault path. */
	onCardCreated: (filePath: string, columnValue: string, swimlaneValue: string | null) => void;
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

function randomSuffix(len = 4): string {
	const chars = 'abcdefghijklmnopqrstuvwxyz';
	let out = '';
	for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
	return out;
}

/**
 * Build a unique datetime-stamped filename stem: YYYY-MM-DD_HH-MM_xxxx
 * Dots are avoided in the stem (except the final .md extension) so Obsidian
 * does not treat the time/suffix portion as a file extension and mangle the name.
 * The four-character random suffix makes collisions practically impossible,
 * but we still check and regenerate if one occurs.
 */
export function buildUniqueFileName(targetFolder: string, existingPaths: Set<string>): string {
	const d = new Date();
	const yyyy = String(d.getFullYear());
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	const hh = String(d.getHours()).padStart(2, '0');
	const min = String(d.getMinutes()).padStart(2, '0');
	const base = `${yyyy}-${mm}-${dd}_${hh}-${min}`;
	let candidate: string;
	do {
		candidate = `${base}_${randomSuffix()}`;
	} while (existingPaths.has(`${targetFolder}/${candidate}.md`));
	return candidate;
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

	const setFrontmatter = (frontmatter: Record<string, unknown>): void => {
		// Store the file title and the datetime stamp as the filename property.
		frontmatter['filename'] = baseFileName;

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
		const uniqueFileName = buildUniqueFileName(baseFolder, previousPaths);
		await cb.createFileForView(uniqueFileName, setFrontmatter);
		const finalPath = await cb.moveFileToFolder(previousPaths, uniqueFileName, baseFolder);
		closeNativeNewItemPopover(ctx.doc);
		if (finalPath) cb.onCardCreated(finalPath, columnValue, swimlaneValue);
	} catch (error) {
		console.error('Error creating kanban card:', error);
		new Notice('Could not create card.');
	}
}
