/**
 * Values esbuild substitutes at bundle time. They are declared here so
 * `tsc --noEmit` sees them; the daemon bundle redefines them in
 * `headless/esbuild.config.mjs`, and the test runner pins a fake version.
 */
declare const __DAEMON_VERSION__: string;
