// Workspace component library (E14). Plain ES modules, no dependencies, no build step.
// Every component is `(container, props) => { update(props), destroy() }` and renders only the data it is given.
export { GraphView } from './graph-view.js';
export { InspectorPanel, INSPECTOR_TABS, jsonView } from './inspector.js';
export { StateBadge, EmptyState, ErrorState, LoadingState, PermissionDeniedState, DisconnectedState, badge, stateIcon } from './states.js';
export { DataTable, RelationTable, TextOutline, refLink } from './tables.js';
export { AuditTimeline } from './timeline.js';
export { ControlBar } from './controls.js';
export { TaskBoard, SearchResults } from './board.js';
export * as model from './model.js';
export const VERSION = '1.0.0';
