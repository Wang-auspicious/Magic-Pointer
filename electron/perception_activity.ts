import type {PerceptionProgress} from './runtime/perception_broker';

export interface PerceptionActivity {
  token: string;
  state: 'reading' | 'ready' | 'failed';
  providers: PerceptionProgress[];
  error?: string;
}

export function updatePerceptionActivity(
  activity: PerceptionActivity,
  token: string,
  progress: PerceptionProgress,
): PerceptionActivity {
  if (activity.token !== token || activity.state !== 'reading') {
    return activity;
  }
  const providers = activity.providers.filter(item => item.provider !== progress.provider);
  return {...activity, providers: [...providers, progress]};
}
