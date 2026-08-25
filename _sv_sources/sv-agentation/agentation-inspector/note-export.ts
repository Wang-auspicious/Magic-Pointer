import type {
	AgentationAnnotationSnapshot,
	AgentationExportPayload,
	AnnotationCapture,
	InspectorNote,
	NotesSettings,
	OutputMode
} from '../types';
import { NO_SOURCE_VALUE } from './shared/constants';
import {
	buildAnnotationSnapshot,
	captureAnnotationContext,
	filterAnnotationSnapshotForMode
} from './note-capture';

const quoteValue = (value: string) => `"${value.replace(/\s+/g, ' ').trim()}"`;
const codeValue = (value: string) => `\`${value.replace(/\s+/g, ' ').trim()}\``;

const formatSourceLocation = (snapshot: AgentationAnnotationSnapshot) => {
	if (!snapshot.source.shortFileName || snapshot.source.shortFileName === NO_SOURCE_VALUE) {
		return 'Source unavailable';
	}

	if (snapshot.source.lineNumber === null || snapshot.source.columnNumber === null) {
		return snapshot.source.shortFileName;
	}

	return `${snapshot.source.shortFileName}:${snapshot.source.lineNumber}:${snapshot.source.columnNumber}`;
};

const formatCompactSourceLocation = (snapshot: AgentationAnnotationSnapshot) => {
	if (!snapshot.source.filePath || snapshot.source.filePath === NO_SOURCE_VALUE) {
		return 'Source unavailable';
	}

	if (snapshot.source.lineNumber === null) {
		return snapshot.source.filePath;
	}

	if (snapshot.source.columnNumber === null) {
		return `${snapshot.source.filePath}:${snapshot.source.lineNumber}`;
	}

	return `${snapshot.source.filePath}:${snapshot.source.lineNumber}:${snapshot.source.columnNumber}`;
};

const formatFullSource = (snapshot: AgentationAnnotationSnapshot) => {
	if (!snapshot.source.filePath || snapshot.source.filePath === NO_SOURCE_VALUE) {
		return 'Source unavailable';
	}

	return `${snapshot.source.filePath}:${snapshot.source.lineNumber ?? '?'}:${snapshot.source.columnNumber ?? '?'}`;
};

const formatClasses = (snapshot: AgentationAnnotationSnapshot) =>
	snapshot.element.cssClasses.length > 0
		? snapshot.element.cssClasses.map((className) => `.${className}`).join(', ')
		: '';

const formatStandardClasses = (snapshot: AgentationAnnotationSnapshot) =>
	snapshot.element.cssClasses.length > 0 ? codeValue(snapshot.element.cssClasses.join(' ')) : '';

const formatDetailedClasses = (snapshot: AgentationAnnotationSnapshot) =>
	snapshot.element.cssClasses.length > 0
		? snapshot.element.cssClasses.map((className) => codeValue(`.${className}`)).join(', ')
		: '';

const formatComponents = (snapshot: AgentationAnnotationSnapshot) => {
	const values =
		snapshot.element.components.all.length > 0
			? snapshot.element.components.all
			: snapshot.element.components.smart.length > 0
				? snapshot.element.components.smart
				: snapshot.element.components.filtered;

	return values.length > 0 ? values.map((value) => `<${value}>`).join(' ') : '';
};

const formatBoundingBox = (snapshot: AgentationAnnotationSnapshot) => {
	const bounds = snapshot.element.boundingBox;
	if (!bounds) return '';
	return `x:${bounds.x}, y:${bounds.y}, ${bounds.width}x${bounds.height}px`;
};

const formatComputedStyles = (snapshot: AgentationAnnotationSnapshot) => {
	const styles = snapshot.element.computedStyles;
	if (!styles) return '';

	const preferredOrder = [
		'background-color',
		'font-size',
		'font-weight',
		'padding',
		'border-radius',
		'color',
		'display',
		'box-shadow'
	];
	const labels: Record<string, string> = {
		'background-color': 'bg',
		'font-size': 'font',
		'font-weight': 'weight',
		padding: 'padding',
		'border-radius': 'radius',
		color: 'color',
		display: 'display',
		'box-shadow': 'shadow'
	};

	return preferredOrder
		.filter((key) => styles[key])
		.map((key) => `${labels[key] ?? key}: ${styles[key]}`)
		.join(', ');
};

const formatCompactMarkdown = (payload: AgentationExportPayload) => [
	`## Feedback: ${payload.title}`,
	'',
	...payload.annotations.flatMap((snapshot, index) => {
		const source = formatCompactSourceLocation(snapshot);
		const target = snapshot.element.cssClasses[0]
			? `.${snapshot.element.cssClasses[0]}`
			: snapshot.targetLabel;
		const textReference =
			snapshot.kind === 'text' && snapshot.element.selectedText
				? ` (re: ${quoteValue(snapshot.element.selectedText)})`
				: '';
		const header =
			source === 'Source unavailable'
				? `${index + 1}. **${target}**: ${snapshot.comment}${textReference}`
				: `${index + 1}. **${target}** (${source}): ${snapshot.comment}${textReference}`;
		return [header, index < payload.annotations.length - 1 ? '' : ''];
	})
]
	.join('\n');

const formatStandardMarkdown = (payload: AgentationExportPayload) => [
	`## Page Feedback: ${payload.title}`,
	`**Viewport:** ${payload.viewport.width}x${payload.viewport.height}`,
	'',
	...payload.annotations.flatMap((snapshot, index) => {
		const lines = [
			`### ${index + 1}. ${snapshot.targetLabel}`,
			`**Location:** ${codeValue(snapshot.element.selector ?? snapshot.targetSummary)}`,
			`**Source:** ${formatFullSource(snapshot)}`
		];
		const classes = formatStandardClasses(snapshot);
		if (classes && snapshot.kind !== 'text') {
			lines.push(`**Classes:** ${classes}`);
		}
		const components = formatComponents(snapshot);
		if (components) {
			lines.push(`**Components:** ${codeValue(components)}`);
		}
		if (snapshot.kind !== 'text' && snapshot.element.position && snapshot.element.boundingBox) {
			lines.push(
				`**Position:** ${snapshot.element.boundingBox.x}, ${snapshot.element.boundingBox.y} (${snapshot.element.boundingBox.width}x${snapshot.element.boundingBox.height})`
			);
		}
		if (snapshot.element.selectedText) {
			lines.push(`**Selected:** ${quoteValue(snapshot.element.selectedText)}`);
		}
		lines.push(`**Feedback:** ${snapshot.comment}`);

		if (index < payload.annotations.length - 1) {
			lines.push('');
		}
		return lines;
	})
].join('\n');

const formatDetailedMarkdown = (payload: AgentationExportPayload) => [
	`## Page Feedback: ${payload.title}`,
	`**Viewport:** ${payload.viewport.width}x${payload.viewport.height}`,
	`**URL:** ${payload.url}`,
	`**User Agent:** ${payload.userAgent}`,
	'',
	'---',
	'',
	...payload.annotations.flatMap((snapshot, index) => {
		const lines = [`### ${index + 1}. ${snapshot.targetLabel}`, ''];
		if (snapshot.element.selector) {
			lines.push(`**Selector:** ${codeValue(snapshot.element.selector)}`);
		}
		lines.push(`**Source:** ${formatFullSource(snapshot)}`);
		const classes = formatDetailedClasses(snapshot);
		if (classes) {
			lines.push(`**Classes:** ${classes}`);
		}
		const components = formatComponents(snapshot);
		if (components) {
			lines.push(`**Components:** ${codeValue(components)}`);
		}
		const bounds = formatBoundingBox(snapshot);
		if (bounds && snapshot.kind !== 'text') {
			lines.push(`**Bounding box:** ${bounds}`);
		}
		if (snapshot.element.selectedText) {
			lines.push(`**Selected text:** ${quoteValue(snapshot.element.selectedText)}`);
		}
		if (snapshot.element.nearbyText) {
			lines.push(`**Nearby text:** ${quoteValue(snapshot.element.nearbyText)}`);
		}
		lines.push('', `**Issue:** ${snapshot.comment}`, '');
		if (index < payload.annotations.length - 1) {
			lines.push('---', '');
		}
		return lines;
	}),
	'---',
	'',
	'**Search tips:** Use the class names, Components, or selectors above to find these elements. Try `grep -r "SubmitButton"` or `grep -r "className.*submit-btn"`.'
].join('\n');

const formatForensicMarkdown = (payload: AgentationExportPayload) => [
	`## Page Feedback: ${payload.title}`,
	'',
	'**Environment:**',
	`- Viewport: ${payload.viewport.width}x${payload.viewport.height}`,
	`- URL: ${payload.url}`,
	`- User Agent: ${payload.userAgent}`,
	`- Timestamp: ${payload.timestamp}`,
	`- Device Pixel Ratio: ${payload.devicePixelRatio}`,
	'',
	'---',
	'',
	...payload.annotations.flatMap((snapshot, index) => {
		const lines = [`### ${index + 1}. ${snapshot.targetLabel}`, ''];
		if (snapshot.element.fullDomPath) {
			lines.push(`**Full DOM Path:** ${codeValue(snapshot.element.fullDomPath)}`);
		}
		lines.push(`**Source:** ${formatFullSource(snapshot)}`);
		const components = formatComponents(snapshot);
		if (components) {
			lines.push(`**Components:** ${codeValue(components)}`);
		}
		lines.push('');
		const classes = snapshot.element.cssClasses.join(', ');
		if (classes) {
			lines.push(`**CSS Classes:** ${codeValue(classes)}`);
		}
		if (snapshot.element.selectedText) {
			lines.push(`**Selected text:** ${quoteValue(snapshot.element.selectedText)}`);
		}
		if (snapshot.element.position && snapshot.element.boundingBox) {
			lines.push('**Position:**');
			lines.push(
				`- Bounding box: x:${snapshot.element.boundingBox.x}, y:${snapshot.element.boundingBox.y}`
			);
			lines.push(
				`- Dimensions: ${snapshot.element.boundingBox.width}x${snapshot.element.boundingBox.height}px`
			);
			lines.push(
				`- Annotation at: ${snapshot.element.position.xPercent}% from left, ${snapshot.element.position.yAbsolute}px from top`
			);
		}
		const computedStyles = formatComputedStyles(snapshot);
		if (computedStyles) {
			lines.push(`**Computed Styles:** ${computedStyles}`);
		}
		if (snapshot.element.accessibility) {
			lines.push(`**Accessibility:** ${snapshot.element.accessibility}`);
		}
		lines.push('', `**Issue:** ${snapshot.comment}`, '');
		if (index < payload.annotations.length - 1) {
			lines.push('---', '');
		}
		return lines;
	})
].join('\n');

const formatters: Record<OutputMode, (payload: AgentationExportPayload) => string> = {
	compact: formatCompactMarkdown,
	standard: formatStandardMarkdown,
	detailed: formatDetailedMarkdown,
	forensic: formatForensicMarkdown
};

export const buildExportPayload = async (
	notes: InspectorNote[],
	settings: Pick<
		NotesSettings,
		'outputMode' | 'includeComponentContext' | 'includeComputedStyles'
	>
): Promise<AgentationExportPayload> => {
	const captures = await Promise.all(
		notes.map(async (note) => note.capture ?? (await captureAnnotationContext(note, note.updatedAt)))
	);
	const snapshots = notes.map((note, index) =>
		filterAnnotationSnapshotForMode(buildAnnotationSnapshot(note, captures[index] as AnnotationCapture), {
			outputMode: settings.outputMode,
			includeComponentContext: settings.includeComponentContext,
			includeComputedStyles: settings.includeComputedStyles
		})
	);
	const page = captures[0]?.page ?? {
		title: typeof window === 'undefined' ? '/' : window.location.pathname || '/',
		pathname: typeof window === 'undefined' ? '/' : window.location.pathname || '/',
		url: typeof window === 'undefined' ? '' : window.location.href,
		viewport: {
			width: typeof window === 'undefined' ? 0 : window.innerWidth,
			height: typeof window === 'undefined' ? 0 : window.innerHeight
		},
		userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
		devicePixelRatio: typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
		timestamp: new Date().toISOString()
	};

	return {
		title: page.title,
		outputMode: settings.outputMode,
		url: page.url,
		viewport: page.viewport,
		userAgent: page.userAgent,
		devicePixelRatio: page.devicePixelRatio,
		timestamp: page.timestamp,
		annotations: snapshots
	};
};

export const formatExportPayloadAsMarkdown = (payload: AgentationExportPayload) => {
	if (payload.annotations.length === 0) {
		return '## Feedback\n\nNo feedback added yet.';
	}

	return formatters[payload.outputMode](payload);
};

export const formatNotesAsMarkdown = async (
	notes: InspectorNote[],
	settings: Pick<
		NotesSettings,
		'outputMode' | 'includeComponentContext' | 'includeComputedStyles'
	>
) => {
	const payload = await buildExportPayload(notes, settings);
	return {
		payload,
		markdown: formatExportPayloadAsMarkdown(payload)
	};
};
