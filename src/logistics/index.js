import { config } from '../config.js';
import { GROUPS } from './kinds.js';

/*
 * Logistics in the ERP is the logistics app itself (web/lgapp.js), since
 * 30 Oct 2026. What the console needs to know about it: whether it is served
 * here, where its vault page is, and the app's tabs (GROUPS, in the app's own
 * order) so a link of ours can name one.
 */
export function catalog() {
  return {
    app_url: config.logistics.appUrl ? `${config.logistics.appUrl}/watch-vault` : '',
    app_embedded: Boolean(config.logistics.appUrl),
    groups: GROUPS,
  };
}
