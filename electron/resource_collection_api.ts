import type {
  CollectedResource,
  ResourceCollection,
} from './resource_collection_contract';
import type {XSourceState} from './resource_x_source';
import type {ResourcePreview} from './resource_preview';

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
}
export type ResourceAction =
  | 'list'
  | 'add'
  | 'edit'
  | 'process'
  | 'deliver'
  | 'preview'
  | 'open-original'
  | 'browser-open'
  | 'capture'
  | 'x-connect'
  | 'x-configure'
  | 'x-sync';
export interface ResourceRequest {
  material?: 'original' | 'paper';
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
