// Types for the workspace component library (web/index.js). Props mirror the E14 service-layer JSON.
import type { DisplayState, Graph, GraphEdge, Outline, TableModel } from './model.js';
export * as model from './model.js';
export const VERSION: string;

/** Every component: `(container, props) => handle`. `update` merges the given props into the current ones and re-renders. */
export type Handle<P> = { update(props: Partial<P>): void; destroy(): void; readonly props: P };
export type LoadState = 'ready' | 'loading' | 'error' | 'denied' | 'disconnected' | 'empty';
export type LoadError = { code?: string; message?: string; requestId?: string; engines?: string[] };
export type Navigate = (ref: string) => void;

export type GraphViewProps = {
  graph: Graph; table?: TableModel; outline?: Outline; selected?: string | null; view?: 'graph' | 'table' | 'text'; label?: string;
  /** A node was activated (click, Enter or Space). */
  onSelect?: Navigate;
  /** A reference link in the table or text view was activated; falls back to onSelect. */
  onNavigate?: Navigate;
  /** When given, `view` is controlled by the host. */
  onViewChange?: (view: 'graph' | 'table' | 'text') => void;
};
export function GraphView(container: HTMLElement, props: GraphViewProps): Handle<GraphViewProps>;

export type InspectorObject = {
  ref: string; engine: string; engineName?: string; kind: string; title: string; state: DisplayState; engineState: string; stale: boolean; blocked: boolean; staleReasons: string[];
  badges?: { state: DisplayState; label: string; description: string }[];
  sources: { ref: string; engine: string; kind: string; id: string; revision: number | null }[]; dependents: { ref: string; engine: string; kind: string; id: string; revision: number | null }[];
  versions: readonly { revision: number; at: string; actorId: string; summary?: string }[]; permissions: readonly unknown[]; decisions: readonly unknown[];
  history: readonly { at: string; actorId: string; action: string; detail?: unknown }[]; data: unknown; generatedAt?: string;
  annotations?: { id: string; kind: string; body: string; status: string; authorId: string; createdAt: string }[];
};
export type InspectorTab = 'summary' | 'sources' | 'dependents' | 'versions' | 'permissions' | 'decisions' | 'history' | 'raw';
export type InspectorPanelProps = {
  object: InspectorObject | null; state?: LoadState; error?: LoadError; tab?: InspectorTab; headingLevel?: number;
  onNavigate?: Navigate; onTabChange?: (tab: InspectorTab) => void; onRetry?: () => void;
};
export const INSPECTOR_TABS: InspectorTab[];
export function InspectorPanel(container: HTMLElement, props: InspectorPanelProps): Handle<InspectorPanelProps>;
export function jsonView(value: unknown, onNavigate?: Navigate): HTMLElement;

export type StateBadgeProps = { state: DisplayState; label?: string; reasons?: string[]; at?: string; showReasons?: boolean };
export function StateBadge(container: HTMLElement, props: StateBadgeProps): Handle<StateBadgeProps>;
export function badge(state: DisplayState, options?: Omit<StateBadgeProps, 'state'>): HTMLElement;
export function stateIcon(state: DisplayState, size?: number): SVGElement;

export type EmptyStateProps = { title?: string; message?: string; action?: { label: string; onAction: () => void } };
export type ErrorStateProps = { title?: string; message: string; code?: string; requestId?: string; onRetry?: () => void };
export type LoadingStateProps = { label?: string };
export type PermissionDeniedStateProps = { message?: string; capability?: string };
export type DisconnectedStateProps = { engines?: string[]; reason?: string; since?: string; onRetry?: () => void };
export function EmptyState(container: HTMLElement, props?: EmptyStateProps): Handle<EmptyStateProps>;
export function ErrorState(container: HTMLElement, props: ErrorStateProps): Handle<ErrorStateProps>;
export function LoadingState(container: HTMLElement, props?: LoadingStateProps): Handle<LoadingStateProps>;
export function PermissionDeniedState(container: HTMLElement, props?: PermissionDeniedStateProps): Handle<PermissionDeniedStateProps>;
export function DisconnectedState(container: HTMLElement, props?: DisconnectedStateProps): Handle<DisconnectedStateProps>;

export type DataTableColumn<R> = { key: string; label: string; sortable?: boolean; numeric?: boolean; render?: (row: R) => Node | string };
export type DataTableProps<R = Record<string, unknown>> = {
  caption: string; columns: DataTableColumn<R>[]; rows: readonly R[]; rowHeader?: string; emptyText?: string; captionHidden?: boolean;
  sort?: { key: string; dir: 'asc' | 'desc' } | null;
  /** When given, sorting is reported and `sort` is controlled by the host. */
  onSort?: (sort: { key: string; dir: 'asc' | 'desc' }) => void;
};
export function DataTable<R = Record<string, unknown>>(container: HTMLElement, props: DataTableProps<R>): Handle<DataTableProps<R>>;
export type RelationTableProps = { graph?: Graph; table?: TableModel; onNavigate?: Navigate };
export function RelationTable(container: HTMLElement, props: RelationTableProps): Handle<RelationTableProps>;
export type TextOutlineProps = { graph?: Graph; outline?: Outline; onNavigate?: Navigate };
export function TextOutline(container: HTMLElement, props: TextOutlineProps): Handle<TextOutlineProps>;
export function refLink(ref: string, onNavigate?: Navigate, text?: string): HTMLElement;

export type AuditRecordRow = { engine: string; id: string; at: string; actorId: string; actorKind: string; action: string; subject: string; requestId: string; purpose: string; detail?: unknown };
export type AuditFilter = { engine?: string; actor?: string; action?: string; text?: string };
export type AuditTimelineProps = {
  records: readonly AuditRecordRow[];
  engines?: { engine: string; name?: string; status: 'ok' | 'unavailable' | 'forbidden'; reason?: string; count: number; chain: string }[];
  truncated?: boolean; filter?: AuditFilter; height?: number;
  onFilterChange?: (filter: AuditFilter) => void; onNavigate?: Navigate; onExport?: (format: 'csv' | 'json', filter: AuditFilter) => void; onLoadMore?: () => void;
};
export function AuditTimeline(container: HTMLElement, props: AuditTimelineProps): Handle<AuditTimelineProps>;

export type ControlSpecView = { id: string; label: string; capability: string; dangerous: boolean; input: unknown; description?: string; source?: string; allowed?: boolean; deniedReason?: string };
/** Must resolve with the invocation (or any result) and reject with `{ code, message }`; the bar shows whichever happened. */
export type InvokeControl = (ref: string, controlId: string, input: Record<string, unknown>, options: { confirm: boolean }) => Promise<unknown>;
export type ControlBarProps = { ref: string; controls: readonly ControlSpecView[]; onInvoke: InvokeControl; label?: string; compact?: boolean };
export function ControlBar(container: HTMLElement, props: ControlBarProps): Handle<ControlBarProps>;

export type TaskItem = { ref: string; title: string; state: DisplayState; engineState?: string; kind?: string; engine?: string; stale?: boolean; blocked?: boolean; staleReasons?: string[] };
export type TaskBoardProps = { items: readonly TaskItem[]; edges?: readonly GraphEdge[]; controlsByRef?: Record<string, readonly ControlSpecView[]>; selected?: string | null; headingLevel?: number; onSelect?: Navigate; onInvoke?: InvokeControl };
export function TaskBoard(container: HTMLElement, props: TaskBoardProps): Handle<TaskBoardProps>;

export type SearchResultsProps = {
  result: { q: string; total: number; groups: { engine: string; name?: string; status: 'ok' | 'unavailable' | 'forbidden'; reason?: string; hits: { ref: string; kind: string; title: string; snippet: string; state?: string }[] }[] } | null;
  state?: LoadState; error?: LoadError; headingLevel?: number; onNavigate?: Navigate; onRetry?: () => void;
};
export function SearchResults(container: HTMLElement, props: SearchResultsProps): Handle<SearchResultsProps>;
