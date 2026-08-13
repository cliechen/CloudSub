// ESLint flat config(ESLint 9+)。CJK 标识符是本项目既有风格,故不启用 id-* 限制。
export default [
	{
		ignores: ['_worker.js', 'node_modules/', 'test/'],
	},
	{
		files: ['src/**/*.js', 'build.js', 'tests/**/*.mjs'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				fetch: 'readonly',
				Request: 'readonly',
				Response: 'readonly',
				URL: 'readonly',
				URLSearchParams: 'readonly',
				Headers: 'readonly',
				TextEncoder: 'readonly',
				TextDecoder: 'readonly',
				AbortSignal: 'readonly',
				btoa: 'readonly',
				atob: 'readonly',
				crypto: 'readonly',
				console: 'readonly',
			},
		},
		rules: {
			'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
			'no-constant-condition': 'off',
		},
	},
];
