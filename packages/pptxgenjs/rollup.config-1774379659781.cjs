'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var pkg = require('./package.json');
var resolve = require('@rollup/plugin-node-resolve');
var commonjs = require('@rollup/plugin-commonjs');
var typescript = require('rollup-plugin-typescript2');

const nodeBuiltinsRE = /^node:.*/; /* Regex that matches all Node built-in specifiers */

var rollup_config = {
	input: "src/pptxgen.ts",
	output: [
		{
			file: "./dist/pptxgen.js",
			format: "iife",
			name: "PptxGenJS",
			globals: { jszip: "JSZip" },
		},
		{ file: "./dist/pptxgen.cjs.js", format: "cjs", exports: "default" },
		{ file: "./dist/pptxgen.es.js", format: "es" },
	],
	external: [
		nodeBuiltinsRE,
		...Object.keys(pkg.dependencies || {}),
		...Object.keys(pkg.peerDependencies || {}),
	],
	plugins: [
		resolve({ preferBuiltins: true }),
		commonjs(),
		typescript({ typescript: require("typescript") }),
	]
};

exports.default = rollup_config;
