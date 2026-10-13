import type { WebFetchProvider } from '../types';

export const builtin: Extract<WebFetchProvider, { hosted: false }> = {
  id: 'builtin',
  name: 'Built-in reader',
  hosted: false,
  requiresApiKey: false,
  resolveCredentials: () => ({}),
  extract: async (url, options) => {
    const { fetchAndExtractUrl } = await import('../builtin-extraction');
    return fetchAndExtractUrl(url, options);
  },
};

export default builtin;
