-- Hammerspoon entry point.
--
-- LIVE COPY: ~/.hammerspoon/init.lua  (this is the file Hammerspoon loads)
-- SNAPSHOT:  ~/homer/config/hammerspoon/init.lua  (version-controlled by the
--            nightly repo snapshot; edit the live copy, then copy it across so
--            the two stay identical).
--
-- Implements the F5 push-to-toggle dictation front-end designed in
-- ~/homer/output/codex/dictate-f5-frontend-design-2026-08-13-1152.md.

-- Enables the `hs` command-line tool (/opt/homebrew/bin/hs -> this app bundle),
-- which is how the config is inspected and debugged from a terminal, e.g.
--   hs -c 'hs.accessibilityState()'
-- It changes no dictation behavior and needs no extra permissions.
require("hs.ipc")

local dictate = require("dictate")
dictate.start()
