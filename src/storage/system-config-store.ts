import { query } from './db.js';
import { type SystemConfig, DEFAULT_SYSTEM_CONFIG } from '../domain/system-config.js';

export const systemConfigStore = {
  async getConfig(): Promise<SystemConfig> {
    const result = await query<{ config: any }>('SELECT config FROM system_config WHERE id = $1', ['global']);
    const stored = result.rows[0]?.config || {};
    return {
      ...DEFAULT_SYSTEM_CONFIG,
      ...stored,
    };
  },

  async updateConfig(input: Partial<SystemConfig>): Promise<SystemConfig> {
    const current = await this.getConfig();
    const next = {
      ...current,
      ...input,
    };

    await query(
      'UPDATE system_config SET config = $1::jsonb, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(next), 'global']
    );

    return next;
  }
};
