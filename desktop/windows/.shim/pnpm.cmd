@echo off
REM pnpm shim: electron-builder runs "pnpm list --prod --json" to collect prod deps.
REM This machine only has the bundled pnpm.mjs (no global pnpm command).
"C:\Users\Enged\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" "C:\Users\Enged\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" %*
