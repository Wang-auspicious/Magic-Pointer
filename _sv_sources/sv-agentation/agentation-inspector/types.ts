export type VsCodeScheme = 'vscode' | 'vscode-insiders';
export type OutputMode = 'compact' | 'standard' | 'detailed' | 'forensic';
export type ThemeMode = 'dark' | 'light';
export type InspectorNoteKind = 'element' | 'text' | 'group' | 'area';
export type NoteResolutionState = 'resolved' | 'partial' | 'unresolved';
export type ComponentContextMode = 'filtered' | 'smart' | 'all';
export type AgentationKeyAction =
	| 'inspect'
	| 'copy'
	| 'reset'
	| 'open'
	| 'delete'
	| 'cancel'
	| 'submit';
export type AgentationKeyBindingValue = string | null;
export type AgentationKeyBindings = Partial<Record<AgentationKeyAction, AgentationKeyBindingValue>>;
export type ResolvedAgentationKeyBindings = Record<AgentationKeyAction, AgentationKeyBindingValue>;

export type InspectorPosition =
	| 'top-left'
	| 'top-center'
	| 'top-right'
	| 'mid-right'
	| 'mid-left'
	| 'bottom-left'
	| 'bottom-center'
	| 'bottom-right';

export interface AnnotationLifecycleCallbacks {
	onAnnotationAdd?: (annotation: AgentationAnnotationSnapshot) => void;
	onAnnotationUpdate?: (annotation: AgentationAnnotationSnapshot) => void;
	onAnnotationDelete?: (annotation: AgentationAnnotationSnapshot) => void;
	onAnnotationsClear?: (annotations: AgentationAnnotationSnapshot[]) => void;
	onCopy?: (markdown: string, payload: AgentationExportPayload) => void;
}

export interface InspectorProps {
	workspaceRoot?: string | null;
	pageSessionKey?: string | null;
	selector?: string | null;
	vscodeScheme?: VsCodeScheme;
	openSourceOnClick?: boolean;
	deleteAllDelayMs?: number;
	toolbarPosition?: InspectorPosition;
	outputMode?: OutputMode;
	pauseAnimations?: boolean;
	clearOnCopy?: boolean;
	includeComponentContext?: boolean;
	includeComputedStyles?: boolean;
	copyToClipboard?: boolean;
	keyBindings?: AgentationKeyBindings;
	onAnnotationAdd?: AnnotationLifecycleCallbacks['onAnnotationAdd'];
	onAnnotationUpdate?: AnnotationLifecycleCallbacks['onAnnotationUpdate'];
	onAnnotationDelete?: AnnotationLifecycleCallbacks['onAnnotationDelete'];
	onAnnotationsClear?: AnnotationLifecycleCallbacks['onAnnotationsClear'];
	onCopy?: AnnotationLifecycleCallbacks['onCopy'];
}

export interface InspectorRuntimeOptions extends AnnotationLifecycleCallbacks {
	workspaceRoot: string | null;
	pageSessionKey: string | null;
	selector: string | null;
	vscodeScheme: VsCodeScheme;
	openSourceOnClick: boolean;
	deleteAllDelayMs: number;
	toolbarPosition: InspectorPosition;
	outputMode: OutputMode;
	pauseAnimations: boolean;
	clearOnCopy: boolean;
	includeComponentContext: boolean;
	includeComputedStyles: boolean;
	copyToClipboard: boolean;
	keyBindings: ResolvedAgentationKeyBindings;
}

export interface InspectorHoverInfo {
	componentName: string | null;
	tagName: string;
	targetLabel: string;
	filePath: string;
	shortFileName: string;
	lineNumber: number | null;
	columnNumber: number | null;
	left: number;
	top: number;
	width: number;
	height: number;
	cardLeft: number;
	cardTop: number;
	copyText: string;
	vscodeUrl: string | null;
	canCopy: boolean;
	canOpen: boolean;
	interactionHost: HTMLElement | null;
}

export interface ToolbarCoordinates {
	x: number;
	y: number;
}

export interface NotesSettings {
	markerColor: string;
	themeMode: ThemeMode;
	blockPageInteractions: boolean;
	outputMode: OutputMode;
	pauseAnimations: boolean;
	clearOnCopy: boolean;
	includeComponentContext: boolean;
	includeComputedStyles: boolean;
}

export type ToolbarPanel = 'settings' | 'preview';

export interface ToolbarState {
	expanded: boolean;
	dragging: boolean;
	openPanel: ToolbarPanel | null;
	confirmDeleteAll: boolean;
	notesVisible: boolean;
	copyFeedback: boolean;
	position: ToolbarCoordinates;
}

export interface RectBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface AbsoluteRectBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface NoteMarkerFallback {
	xPercent: number;
	yAbsolute: number;
}

export interface NoteSourceInfo {
	componentName: string | null;
	tagName: string;
	filePath: string;
	shortFileName: string;
	lineNumber: number | null;
	columnNumber: number | null;
}

export type ComputedStyleSnapshot = Record<string, string>;

export interface AnnotationViewport {
	width: number;
	height: number;
}

export interface AnnotationBoundingBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface AnnotationPosition {
	x: number;
	y: number;
	xPercent: number;
	yAbsolute: number;
}

export interface AnnotationPageSnapshot {
	title: string;
	pathname: string;
	url: string;
	viewport: AnnotationViewport;
	userAgent: string;
	devicePixelRatio: number;
	timestamp: string;
}

export interface AnnotationComponentContext {
	filtered: string[];
	smart: string[];
	all: string[];
}

export interface AnnotationElementSnapshot {
	selector: string | null;
	fullDomPath: string | null;
	cssClasses: string[];
	components: AnnotationComponentContext;
	boundingBox: AnnotationBoundingBox | null;
	position: AnnotationPosition | null;
	selectedText: string | null;
	nearbyText: string | null;
	accessibility: string | null;
	computedStyles: ComputedStyleSnapshot | null;
}

export interface AnnotationCapture {
	page: AnnotationPageSnapshot;
	element: AnnotationElementSnapshot;
}

export interface ElementNoteAnchor {
	domPath: string;
	relativeX: number;
	relativeY: number;
	viewportX: number;
	viewportY: number;
}

export interface TextSelectionAnchor {
	commonAncestorPath: string;
	selectedText: string;
	contextBefore: string;
	contextAfter: string;
	startOffset: number;
	endOffset: number;
	fallbackMarker: NoteMarkerFallback;
}

export interface GroupSelectionAnchor {
	selectedDomPaths: string[];
	anchorDomPath: string;
	bounds: AbsoluteRectBox;
	fallbackMarker: NoteMarkerFallback;
}

export interface AreaSelectionAnchor {
	bounds: AbsoluteRectBox;
	fallbackMarker: NoteMarkerFallback;
}

export type InspectorNoteAnchor =
	| ElementNoteAnchor
	| TextSelectionAnchor
	| GroupSelectionAnchor
	| AreaSelectionAnchor;

interface InspectorNoteBase extends NoteSourceInfo {
	id: string;
	kind: InspectorNoteKind;
	note: string;
	targetSummary: string;
	targetLabel: string;
	createdAt: string;
	updatedAt: string;
	capture?: AnnotationCapture;
}

export interface ElementInspectorNote extends InspectorNoteBase {
	kind: 'element';
	anchor: ElementNoteAnchor;
}

export interface TextInspectorNote extends InspectorNoteBase {
	kind: 'text';
	anchor: TextSelectionAnchor;
}

export interface GroupInspectorNote extends InspectorNoteBase {
	kind: 'group';
	anchor: GroupSelectionAnchor;
}

export interface AreaInspectorNote extends InspectorNoteBase {
	kind: 'area';
	anchor: AreaSelectionAnchor;
}

export type InspectorNote =
	| ElementInspectorNote
	| TextInspectorNote
	| GroupInspectorNote
	| AreaInspectorNote;

export interface AgentationAnnotationSnapshot {
	id: string;
	kind: InspectorNoteKind;
	comment: string;
	targetSummary: string;
	targetLabel: string;
	elementPath: string | null;
	timestamp: string;
	page: AnnotationPageSnapshot;
	element: AnnotationElementSnapshot;
	source: NoteSourceInfo;
}

export interface AgentationExportPayload {
	title: string;
	outputMode: OutputMode;
	url: string;
	viewport: AnnotationViewport;
	userAgent: string;
	devicePixelRatio: number;
	timestamp: string;
	annotations: AgentationAnnotationSnapshot[];
}

export interface ResolvedNotePosition {
	markerLeft: number;
	markerTop: number;
	bounds: RectBox | null;
	outlineRects: RectBox[];
	highlightRects: RectBox[];
	visibleInViewport: boolean;
	interactionHost: HTMLElement | null;
}

export type RenderedInspectorNote = InspectorNote & {
	resolution: NoteResolutionState;
	position: ResolvedNotePosition | null;
};

export interface NoteComposerState extends NoteSourceInfo {
	noteId: string | null;
	noteKind: InspectorNoteKind;
	initialValue: string;
	targetSummary: string;
	targetLabel: string;
	placeholder: string;
	accentColor: string;
	markerLeft: number;
	markerTop: number;
	panelLeft: number;
	panelTop: number;
	outlineRects: RectBox[];
	highlightRects: RectBox[];
	selectedText: string | null;
	anchor: InspectorNoteAnchor;
	interactionHost: HTMLElement | null;
}

export interface GroupSelectionPreviewState {
	rects: RectBox[];
}

export interface DragSelectionState {
	left: number;
	top: number;
	width: number;
	height: number;
	highlightRects: RectBox[];
}
