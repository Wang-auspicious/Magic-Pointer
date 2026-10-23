import type {
  CollectedResource,
  ResourceCollection,
  ProjectInboxEntry,
  HandoffReceipt,
  HandoffState,
} from './resource_collection_contract';
import type {XSourceState} from './resource_x_source';
import type {ResourcePreview} from './resource_preview';
import type {ResourcePost} from './resource_post';
import type {HistoryJob, HistoryList} from './resource_browser_history';

export interface ResourceResponse {
  ok: boolean;
  error?: string;
  items?: Array<CollectedResource & {previewUrl?: string}>;
  entry?: CollectedResource;
  projects?: Array<{id: string; name: string; root: string}>;
  source?: XSourceState;
  url?: string;
  title?: string;
  preview?: ResourcePreview;
  handoffs?: ProjectInboxEntry[];
  handoffReceipts?: HandoffReceipt[];
  post?: ResourcePost;
  histories?: Array<Omit<HistoryJob, 'seen'>>;
  browser?: {
    url: string;
    title: string;
    canGoBack: boolean;
    canGoForward: boolean;
    loading: boolean;
  };
}
export type ResourceAction =
  | 'list'
  | 'search'
  | 'add'
  | 'add-batch'
  | 'edit'
  | 'process'
  | 'deliver'
  | 'project-inbox'
  | 'handoff-state'
  | 'preview'
  | 'open-original'
  | 'browser-open'
  | 'capture'
  | 'capture-source'
  | 'read-post'
  | 'browser-command'
  | 'browser-state'
  | 'history-start'
  | 'history-pause'
  | 'x-connect'
  | 'x-configure'
  | 'x-sync';
export type CollectionBrowserCommand =
  'back' | 'forward' | 'reload' | 'stop' | 'resize' | 'hide';
export interface ResourceRequest {
  sourceAccount?: string;
  historyList?: HistoryList;
  restore?: boolean;
  command?: CollectionBrowserCommand;
  material?: 'original' | 'paper' | 'handoff';
  handoffState?: HandoffState;
  snoozedUntil?: number;
  id?: string;
  text?: string;
  url?: string;
  title?: string;
  note?: string;
  projectId?: string;
  patch?: Partial<ResourceCollection>;
  revision?: number;
  bounds?: {x: number; y: number; width: number; height: number};
  token?: string;
  enabled?: boolean;
  likes?: boolean;
  bookmarks?: boolean;
  organize?: boolean;
  rules?: string;
}
export interface ResourceCollectionApi {
  request(
    action: ResourceAction,
    input?: ResourceRequest,
  ): Promise<ResourceResponse>;
}
