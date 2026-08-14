-- Homer dictation front-end: F5 push-to-toggle, ffmpeg -> dictate.ts -> clipboard + Cmd-V.
--
-- LIVE COPY: ~/.hammerspoon/dictate.lua  (this is the file Hammerspoon loads)
-- SNAPSHOT:  ~/homer/config/hammerspoon/dictate.lua  (version-controlled by the
--            nightly repo snapshot; edit the live copy, then copy it across so
--            the two stay identical).
--
-- Implements ~/homer/output/codex/dictate-f5-frontend-design-2026-08-13-1152.md.
-- State machine: idle -> recording -> stopping -> processing -> idle.
--
-- Every executable is referenced by absolute path and the child PATH is set
-- explicitly, because a GUI-launched Hammerspoon does not inherit a shell PATH.
--
-- Backend contract (src/scripts/dictate.ts): stdout = final text only,
-- stderr = diagnostics, exit 0 ok | 1 usage/fatal | 2 transcription failed |
-- 3 no speech detected.

local M = {}

local ROOT = "/Users/yj/homer"
local HOME = os.getenv("HOME")
local FFMPEG = "/opt/homebrew/bin/ffmpeg"
local TSX = ROOT .. "/node_modules/.bin/tsx"
local SCRIPT = ROOT .. "/src/scripts/dictate.ts"
local CACHE_PARENT = HOME .. "/Library/Caches/Homer"
local CACHE_DIR = CACHE_PARENT .. "/dictation"
local AUDIO_INPUT = ":0" -- verify once after granting Hammerspoon microphone access
local TASK_PATH = table.concat({
  ROOT .. "/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"
}, ":")
local INTERRUPTED_KEY = "homer.dictate.interruptedAudio"
local RETENTION_SECONDS = 7 * 24 * 60 * 60

local log = hs.logger.new("dictate", "info")
local menu = hs.menubar.new()
local hotkey, sleepWatcher
local active, backendTask, lastText
local state = "idle"
local lastPressAt = 0

local titles = {
  idle = "D", recording = "●", stopping = "…",
  processing = "…", failed = "!",
}

local function play(name)
  local sound = hs.sound.getByName(name)
  if sound then sound:play() end
end

local function notify(title, detail)
  hs.notify.new({ title = title, informativeText = detail or "" }):send()
end

local function setState(nextState)
  state = nextState
  menu:setTitle(titles[nextState] or "D")
  menu:setTooltip("Dictation: " .. nextState)
end

local function concise(s)
  s = (s or ""):gsub("%s+", " ")
  if #s > 280 then return s:sub(1, 277) .. "..." end
  return s
end

local function fail(title, detail)
  log.e(title .. ": " .. concise(detail))
  setState("failed")
  play("Basso")
  notify(title, detail)
  hs.timer.doAfter(1.5, function()
    if state == "failed" then setState("idle") end
  end)
end

local function ensureCache()
  hs.fs.mkdir(CACHE_PARENT)
  hs.fs.mkdir(CACHE_DIR)
end

local function purgeOldAudio()
  ensureCache()
  local now = os.time()
  for name in hs.fs.dir(CACHE_DIR) do
    if name:match("%.wav$") then
      local path = CACHE_DIR .. "/" .. name
      local modified = hs.fs.attributes(path, "modification")
      if modified and now - modified > RETENTION_SECONDS then
        os.remove(path)
      end
    end
  end
end

local function fileSize(path)
  return hs.fs.attributes(path, "size") or 0
end

local function sameTarget(session)
  local app = hs.application.frontmostApplication()
  return app and session.targetPid and app:pid() == session.targetPid
end

local function finishBackend(session, exitCode, stdout, stderr)
  if active ~= session then return end
  backendTask = nil
  active = nil

  if exitCode ~= 0 then
    local pathNote = "Audio kept: " .. session.audioPath
    if exitCode == 2 then
      fail("Transcription failed", pathNote .. "\n" .. concise(stderr))
    elseif exitCode == 3 then
      fail("No speech detected", pathNote)
    elseif exitCode == 1 then
      fail("Dictation backend error", pathNote .. "\n" .. concise(stderr))
    else
      fail("Unexpected backend exit " .. tostring(exitCode),
        pathNote .. "\n" .. concise(stderr))
    end
    return
  end

  if not stdout or stdout == "" then
    fail("Dictation returned empty text", "Audio kept: " .. session.audioPath)
    return
  end

  lastText = stdout
  if not hs.pasteboard.setContents(stdout) then
    fail("Could not set clipboard", "Audio kept: " .. session.audioPath)
    return
  end

  -- A successful backend and clipboard write are the front-end durability barrier.
  os.remove(session.audioPath)
  setState("idle")

  hs.timer.doAfter(0.05, function()
    if hs.eventtap.isSecureInputEnabled() then
      notify("Dictation ready on clipboard", "Secure input blocked automatic paste.")
    elseif not sameTarget(session) then
      notify("Dictation ready on clipboard", "Focus changed; automatic paste was skipped.")
    else
      hs.eventtap.keyStroke({"cmd"}, "v", 0)
    end
  end)
end

local function startBackend(session)
  setState("processing")

  local task = hs.task.new(TSX, function(code, out, err)
    finishBackend(session, code, out, err)
  end, { SCRIPT, session.audioPath })

  if not task then
    active = nil
    fail("Could not create backend task", "Audio kept: " .. session.audioPath)
    return
  end

  task:setWorkingDirectory(ROOT)
  local env = task:environment()
  env.HOME = HOME
  env.PATH = TASK_PATH
  task:setEnvironment(env)
  backendTask = task

  if not task:start() then
    backendTask = nil
    active = nil
    fail("Could not start backend", "Audio kept: " .. session.audioPath)
  end
end

local function recorderExited(session, exitCode, _, stderr)
  if session.killTimer then session.killTimer:stop() end
  if session.killTimer2 then session.killTimer2:stop() end
  if active ~= session then return end
  session.task = nil

  if not session.stopReason then
    active = nil
    fail("Recorder exited unexpectedly",
      "Audio kept: " .. session.audioPath .. "\n" .. concise(stderr))
    return
  end

  if session.stopReason ~= "user" then
    active = nil
    setState("idle")
    notify("Dictation interrupted", "Audio kept: " .. session.audioPath)
    return
  end

  if session.forced then
    active = nil
    fail("Recorder did not stop cleanly", "Audio kept: " .. session.audioPath)
    return
  end

  -- SIGINT commonly produces a nonzero ffmpeg exit status. A finalized,
  -- nontrivial WAV after a requested stop is the success criterion.
  if fileSize(session.audioPath) <= 44 then
    active = nil
    fail("No microphone audio captured",
      "Audio kept: " .. session.audioPath .. "\n" .. concise(stderr))
    return
  end

  startBackend(session)
end

local function requestStop(reason)
  if state ~= "recording" or not active or not active.task then return end
  local session = active
  session.stopReason = reason

  if reason == "user" then
    local target = hs.application.frontmostApplication()
    session.targetPid = target and target:pid() or nil
    setState("stopping")
    play("Pop")
  else
    setState("stopping")
  end

  local task = session.task
  task:interrupt() -- SIGINT: normal ffmpeg finalization path

  session.killTimer = hs.timer.doAfter(3, function()
    if task:isRunning() then
      session.forced = true
      task:terminate() -- SIGTERM fallback only
      session.killTimer2 = hs.timer.doAfter(2, function()
        if task:isRunning() then
          local pid = task:pid() -- integer supplied by hs.task, not user input
          hs.execute("/bin/kill -KILL " .. tostring(pid))
        end
      end)
    end
  end)
end

local function startRecording()
  if state ~= "idle" then return end

  if not hs.microphoneState(false) then
    hs.microphoneState(true)
    fail("Microphone permission required",
      "Allow Hammerspoon in Privacy & Security -> Microphone, then press F5 again.")
    return
  end
  if not hs.audiodevice.defaultInputDevice() then
    fail("No input device", "Connect or select a microphone and try again.")
    return
  end

  ensureCache()
  local stamp = math.floor(hs.timer.secondsSinceEpoch() * 1000)
  local path = string.format("%s/%s-%d.wav", CACHE_DIR,
    os.date("%Y%m%d-%H%M%S"), stamp)
  local session = { audioPath = path }

  local args = {
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-f", "avfoundation", "-i", AUDIO_INPUT,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    "-y", path,
  }

  local task
  task = hs.task.new(FFMPEG, function(code, out, err)
    recorderExited(session, code, out, err)
  end, args)
  if not task then
    fail("Could not create recorder", FFMPEG)
    return
  end

  session.task = task
  active = session
  if not task:start() then
    active = nil
    fail("Could not start recorder", "Check ffmpeg and AVFoundation device " .. AUDIO_INPUT)
    return
  end

  setState("recording")
  play("Tink")
end

local function toggle()
  local now = hs.timer.secondsSinceEpoch()
  if now - lastPressAt < 0.25 then return end
  lastPressAt = now

  if state == "idle" then
    startRecording()
  elseif state == "recording" then
    requestStop("user")
  else
    play("Funk")
    hs.alert.show("Dictation is " .. state)
  end
end

function M.start()
  purgeOldAudio()
  setState("idle")

  menu:setMenu(function()
    local canToggle = state == "idle" or state == "recording"
    local items = {
      { title = "Status: " .. state, disabled = true },
      {
        title = state == "recording" and "Stop dictation" or "Start dictation",
        disabled = not canToggle,
        fn = toggle,
      },
    }
    if lastText then
      table.insert(items, {
        title = "Copy last transcript",
        fn = function() hs.pasteboard.setContents(lastText) end,
      })
    end
    table.insert(items, { title = "-" })
    -- Wrapped: menu callbacks are invoked with a modifiers table, and
    -- hs.openConsole([bringToFront]) expects a boolean.
    table.insert(items, {
      title = "Open Hammerspoon Console",
      fn = function() hs.openConsole(true) end,
    })
    return items
  end)

  hotkey = hs.hotkey.bind({}, "f5", toggle)
  sleepWatcher = hs.caffeinate.watcher.new(function(event)
    if event == hs.caffeinate.watcher.systemWillSleep and state == "recording" then
      requestStop("sleep")
    end
  end)
  sleepWatcher:start()

  local interrupted = hs.settings.get(INTERRUPTED_KEY)
  if interrupted then
    hs.settings.clear(INTERRUPTED_KEY)
    notify("Previous dictation was interrupted", "Audio kept: " .. interrupted)
  end

  local previousShutdown = hs.shutdownCallback
  hs.shutdownCallback = function()
    if active and active.audioPath then
      hs.settings.set(INTERRUPTED_KEY, active.audioPath)
    end
    if active and active.task and active.task:isRunning() then
      active.task:interrupt()
    end
    if backendTask and backendTask:isRunning() then
      backendTask:terminate()
    end
    if previousShutdown then previousShutdown() end
  end
end

return M
