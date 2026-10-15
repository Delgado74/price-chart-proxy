import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				// Extra bindings only for the tests: the tasak instance backing CUP.
				miniflare: {
					bindings: { TASAK_URL: 'https://tasak.example.org' },
				},
			},
		},
	},
});
