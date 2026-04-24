export interface SystemConfig {
  defaultVideoModel: 'sora-2' | 'veo-3-1' | 'grok-imagine';
  grokMode: 'fun' | 'normal' | 'spicy';
  grokResolution: '480p' | '720p' | '1080p';
  grokDuration: number;
  useReferenceDuration: boolean;
  grokStyle: 'cinematic' | 'vlog';
}

export const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
  defaultVideoModel: 'veo-3-1',
  grokMode: 'normal',
  grokResolution: '720p',
  grokDuration: 10,
  useReferenceDuration: false,
  grokStyle: 'vlog',
};
