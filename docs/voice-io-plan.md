# Voice I/O Implementation Plan

## Overview

Voice input/output system for HOMER using ElevenLabs API, supporting Telegram voice messages and web-based voice chat.

## Architecture

```
              +----------------------+
Telegram      |  Telegram Adapter    |<-- sendVoice (OGG/Opus)
Voice In  --->|  (bot handlers)      |
              +----------+-----------+
                         |
                         v
                  +------+------+
                  | Voice Gateway|  (orchestrator)
                  +------+------+
                         |
          +--------------+-----------------+
          |                                |
          v                                v
 +-------------------+             +-------------------+
 | STT Provider      |             | LLM Router        |
 | - Whisper (batch) |             | (Claude)          |
 | - Scribe RT (new) |             +-------------------+
 +---------+---------+                     |
           |                               v
           +-------------> TTS Provider ---+
                          - HTTP stream
                          - WebSocket (future)
                                   |
                                   v
                          Telegram sendVoice
                          Web WebSocket
```

## Implementation Phases

### Phase 1: Telegram Voice Fix ✅ COMPLETE

**Goal:** Fix TTS output format for proper Telegram voice notes

**Changes:**
- Updated `src/voice/tts.ts` to support OGG/Opus output format
- Updated `src/bot/index.ts` to use OGG/Opus instead of MP3
- Added turbo model support (`eleven_turbo_v2_5`) for lower latency

**Files Modified:**
- `src/voice/types.ts` - Added `AudioFormat` type, streaming types
- `src/voice/tts.ts` - OGG/Opus, streaming, turbo mode
- `src/bot/index.ts` - OGG/Opus format, turbo model

### Phase 2: Streaming TTS ✅ COMPLETE

**Goal:** Stream TTS audio for faster time-to-first-byte

**Changes:**
- Added `synthesizeSpeechStream()` async generator in `tts.ts`
- Added callback-based streaming option in `synthesizeSpeech()`

**API:**
```typescript
// Async generator streaming
for await (const chunk of synthesizeSpeechStream(text, config)) {
  // Process chunk
}

// Callback-based streaming
await synthesizeSpeech(text, config, {
  stream: true,
  onChunk: (chunk) => { /* process */ }
});
```

### Phase 3: Voice Gateway ✅ COMPLETE

**Goal:** Create orchestrator for STT → LLM → TTS pipeline

**New File:** `src/voice/gateway.ts`

**API:**
```typescript
const gateway = createVoiceGateway(voiceConfig);

// Full pipeline
const result = await gateway.processVoice(audioBuffer, async (text) => {
  return await llm.process(text);
});

// Streaming pipeline
await gateway.processVoiceStreaming(audioBuffer, processText, (chunk) => {
  socket.send(chunk);
});

// Individual operations
const transcription = await gateway.transcribe(audioBuffer);
const audio = await gateway.synthesize(text);
```

### Phase 4: Web Voice WebSocket ✅ COMPLETE

**Goal:** Real-time voice chat via WebSocket for web clients

**New File:** `src/web/voice.ts`

**Endpoints:**
- `WS /ws/voice` - Real-time voice chat
- `POST /api/voice/process` - One-shot voice/text processing
- `POST /api/voice/synthesize` - TTS only

**WebSocket Protocol:**
```json
// Client → Server (JSON)
{ "type": "start_recording" }
{ "type": "stop_recording" }
{ "type": "text_input", "text": "Hello" }
{ "type": "config", "format": "ogg_opus" }

// Client → Server (Binary)
[audio chunks during recording]

// Server → Client (JSON)
{ "type": "response_start", "data": { "connectionId": "...", "status": "connected" } }
{ "type": "transcription", "data": { "text": "..." } }
{ "type": "response_chunk", "data": { "chunkSize": 1234 } }
{ "type": "response_end", "data": { "text": "...", "audioSize": 12345 } }
{ "type": "error", "data": { "message": "..." } }

// Server → Client (Binary)
[audio response chunks]
```

**REST API:**
```bash
# One-shot processing
curl -X POST http://localhost:3000/api/voice/process \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, how are you?"}'

# TTS only
curl -X POST http://localhost:3000/api/voice/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "format": "ogg_opus"}'
```

### Phase 5: Browser Client 🔜 NEXT

**Goal:** Web UI for voice chat with push-to-talk

**Components:**
1. Audio capture using MediaRecorder API
2. WebSocket connection management
3. Audio playback with Web Audio API
4. Push-to-talk button (space bar)

**Implementation:**
```html
<!-- src/web/public/voice.html -->
<div id="voice-chat">
  <button id="ptt-btn">Hold to Talk</button>
  <div id="status">Disconnected</div>
  <div id="transcript"></div>
</div>
```

```javascript
// src/web/public/voice.js
class VoiceClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.mediaRecorder = null;
    this.audioContext = new AudioContext();
  }

  async startRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    this.mediaRecorder.ondataavailable = (e) => this.ws.send(e.data);
    this.ws.send(JSON.stringify({ type: 'start_recording' }));
    this.mediaRecorder.start(100); // 100ms chunks
  }

  stopRecording() {
    this.mediaRecorder.stop();
    this.ws.send(JSON.stringify({ type: 'stop_recording' }));
  }
}
```

### Phase 6: Voice Activity Detection (VAD) 🔮 FUTURE

**Goal:** Auto-detect speech start/end without push-to-talk

**Options:**
1. **Browser VAD:** Web Audio API + volume threshold
2. **Server VAD:** ElevenLabs Scribe v2 with built-in VAD
3. **Hybrid:** Browser for start detection, server for end detection

**Implementation Notes:**
- Use `AudioWorklet` for real-time audio processing
- Implement silence detection (300ms threshold)
- Add visual feedback for recording state

### Phase 7: Realtime STT with Scribe 🔮 FUTURE

**Goal:** Replace Whisper with ElevenLabs Scribe for realtime transcription

**Benefits:**
- 150ms latency (vs Whisper's batch processing)
- Built-in VAD
- WebSocket streaming

**API:**
```typescript
// src/voice/stt/scribe-rt.ts
const scribe = new ScribeRealtimeSTT(config);

scribe.on('transcript', (text, isFinal) => {
  if (isFinal) {
    processWithLLM(text);
  } else {
    showInterimTranscript(text);
  }
});

await scribe.connect();
scribe.sendAudio(chunk);
```

### Phase 8: WebRTC 🔮 FUTURE

**Goal:** Ultra-low latency bidirectional audio

**Why:**
- WebSocket adds ~50-100ms latency
- WebRTC provides direct peer connection
- Better audio quality with adaptive bitrate

**Implementation:**
- Use `simple-peer` or native WebRTC
- TURN server for NAT traversal
- Integrate with existing voice gateway

## File Structure

```
src/voice/
├── index.ts              # Exports
├── types.ts              # Type definitions
├── gateway.ts            # Pipeline orchestrator
├── stt.ts                # Whisper STT (batch)
├── tts.ts                # ElevenLabs TTS
└── (future)
    ├── stt/
    │   ├── whisper.ts    # Batch STT
    │   └── scribe-rt.ts  # Realtime STT
    └── vad.ts            # Voice activity detection

src/web/
├── server.ts             # Fastify server
├── routes.ts             # REST routes
├── voice.ts              # Voice WebSocket + REST
└── public/               # Browser client
    ├── voice.html
    └── voice.js
```

## Cost Estimates

| Component | Usage | Cost |
|-----------|-------|------|
| Whisper STT | $0.006/min | ~$0.18/hr |
| ElevenLabs TTS | ~$0.30/1K chars | ~$0.90/hr (3K chars/hr) |
| Scribe v2 (future) | $0.40/hr streaming | $0.40/hr |

**Monthly estimates:**
- Light use (10 msgs/day): ~$2.50
- Heavy use (1 hr/day): ~$35-50

## Configuration

Environment variables (`.env`):
```bash
# Voice
VOICE_ENABLED=true
OPENAI_API_KEY=sk-...
ELEVEN_LABS_API_KEY=...
ELEVEN_LABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
ELEVEN_LABS_MODEL=eleven_multilingual_v2
```

## Testing

### Telegram Voice
1. Send voice message to HOMER bot
2. Verify transcription in logs
3. Receive voice response in OGG/Opus format
4. Confirm voice note displays correctly (not as audio file)

### Web Voice
```bash
# Test TTS endpoint
curl -X POST http://localhost:3000/api/voice/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is a test"}' \
  | jq -r '.audio' | base64 -d > test.ogg

# Play the audio
afplay test.ogg  # macOS
```

### WebSocket
```javascript
// Browser console
const ws = new WebSocket('ws://localhost:3000/ws/voice');
ws.onmessage = (e) => console.log(JSON.parse(e.data));
ws.send(JSON.stringify({ type: 'text_input', text: 'Hello' }));
```

## References

- [ElevenLabs API Docs](https://elevenlabs.io/docs/api-reference)
- [ElevenLabs Scribe](https://elevenlabs.io/docs/speech-to-text/overview)
- [Fastify WebSocket](https://github.com/fastify/fastify-websocket)
- [MediaRecorder API](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)
