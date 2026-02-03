import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { logger } from "../utils/logger.js";
import { createVoiceGateway, type VoiceGateway } from "../voice/index.js";
import type { VoiceConfig, VoiceMessage, AudioFormat } from "../voice/types.js";

// WebSocket is added via @fastify/websocket plugin
interface WebSocket {
  send(data: string | Buffer): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  close(): void;
  readyState: number;
}

interface VoiceConnection {
  id: string;
  socket: WebSocket;
  gateway: VoiceGateway;
  audioChunks: Buffer[];
  isRecording: boolean;
  conversationId?: string;
  createdAt: Date;
}

const connections = new Map<string, VoiceConnection>();

/**
 * Send a typed message over WebSocket
 */
function sendMessage(socket: WebSocket, type: VoiceMessage["type"], data: unknown): void {
  if (socket.readyState !== 1) return; // OPEN state

  const message: VoiceMessage = {
    type,
    data,
    timestamp: Date.now(),
  };
  socket.send(JSON.stringify(message));
}

/**
 * Register voice WebSocket routes
 * Requires @fastify/websocket to be registered first
 */
export function registerVoiceWebSocket(
  server: FastifyInstance,
  voiceConfig: VoiceConfig,
  processMessage: (text: string, conversationId?: string) => Promise<{ response: string; conversationId?: string }>
): void {
  // Voice WebSocket endpoint
  server.get("/ws/voice", { websocket: true }, (socket: WebSocket) => {
    const connectionId = randomUUID();
    const gateway = createVoiceGateway(voiceConfig);

    const connection: VoiceConnection = {
      id: connectionId,
      socket,
      gateway,
      audioChunks: [],
      isRecording: false,
      createdAt: new Date(),
    };

    connections.set(connectionId, connection);

    logger.info({ connectionId }, "Voice WebSocket connected");

    // Send connection confirmation
    sendMessage(socket, "response_start", { connectionId, status: "connected" });

    socket.on("message", async (rawMessage: unknown) => {
      try {
        // Binary data = audio chunk
        if (Buffer.isBuffer(rawMessage)) {
          if (connection.isRecording) {
            connection.audioChunks.push(rawMessage);
          }
          return;
        }

        // Text data = JSON command
        const messageStr = typeof rawMessage === "string" ? rawMessage : String(rawMessage);
        const message = JSON.parse(messageStr);

        switch (message.type) {
          case "start_recording":
            connection.audioChunks = [];
            connection.isRecording = true;
            logger.debug({ connectionId }, "Started recording");
            break;

          case "stop_recording":
            connection.isRecording = false;
            await handleVoiceInput(connection, processMessage);
            break;

          case "text_input":
            // Direct text input (fallback for non-voice)
            await handleTextInput(connection, message.text, processMessage);
            break;

          case "config":
            // Update configuration (format, etc.)
            if (message.format) {
              logger.debug({ connectionId, format: message.format }, "Config updated");
            }
            break;

          default:
            logger.warn({ connectionId, type: message.type }, "Unknown message type");
        }
      } catch (error) {
        logger.error({ error, connectionId }, "Voice WebSocket message error");
        sendMessage(socket, "error", {
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    socket.on("close", () => {
      connections.delete(connectionId);
      logger.info({ connectionId }, "Voice WebSocket disconnected");
    });

    socket.on("error", (error: unknown) => {
      logger.error({ error, connectionId }, "Voice WebSocket error");
      connections.delete(connectionId);
    });
  });

  // REST endpoint for one-shot voice processing
  server.post("/api/voice/process", async (request, reply) => {
    const body = request.body as {
      audio?: string; // Base64 encoded audio
      text?: string; // Or direct text
      format?: AudioFormat;
      conversationId?: string;
    };

    if (!body.audio && !body.text) {
      reply.status(400);
      return { error: "Either audio or text is required" };
    }

    const gateway = createVoiceGateway(voiceConfig);

    try {
      let inputText: string;

      if (body.audio) {
        // Decode and transcribe audio
        const audioBuffer = Buffer.from(body.audio, "base64");
        const transcription = await gateway.transcribe(audioBuffer);
        inputText = transcription.text;
      } else {
        inputText = body.text!;
      }

      // Process with LLM
      const { response, conversationId } = await processMessage(inputText, body.conversationId);

      // Synthesize response
      const synthesis = await gateway.synthesize(response, {
        format: body.format || "ogg_opus",
        turbo: true,
      });

      return {
        transcription: body.audio ? inputText : undefined,
        response,
        audio: synthesis.audio.toString("base64"),
        format: synthesis.format,
        conversationId,
      };
    } catch (error) {
      logger.error({ error }, "Voice processing failed");
      reply.status(500);
      return {
        error: error instanceof Error ? error.message : "Voice processing failed",
      };
    }
  });

  // TTS-only endpoint
  server.post("/api/voice/synthesize", async (request, reply) => {
    const body = request.body as {
      text: string;
      format?: AudioFormat;
      turbo?: boolean;
    };

    if (!body.text) {
      reply.status(400);
      return { error: "Text is required" };
    }

    const gateway = createVoiceGateway(voiceConfig);

    try {
      const synthesis = await gateway.synthesize(body.text, {
        format: body.format || "ogg_opus",
        turbo: body.turbo ?? true,
      });

      return {
        audio: synthesis.audio.toString("base64"),
        format: synthesis.format,
        characters: body.text.length,
      };
    } catch (error) {
      logger.error({ error }, "TTS failed");
      reply.status(500);
      return {
        error: error instanceof Error ? error.message : "TTS failed",
      };
    }
  });

  logger.info("Voice WebSocket routes registered");
}

/**
 * Handle voice input after recording stops
 */
async function handleVoiceInput(
  connection: VoiceConnection,
  processMessage: (text: string, conversationId?: string) => Promise<{ response: string; conversationId?: string }>
): Promise<void> {
  const { socket, gateway, audioChunks, id: connectionId } = connection;

  if (audioChunks.length === 0) {
    sendMessage(socket, "error", { message: "No audio recorded" });
    return;
  }

  const audioBuffer = Buffer.concat(audioChunks);
  connection.audioChunks = [];

  logger.debug({ connectionId, audioSize: audioBuffer.length }, "Processing voice input");

  try {
    // Step 1: Transcribe
    const transcription = await gateway.transcribe(audioBuffer);

    if (!transcription.text.trim()) {
      sendMessage(socket, "error", { message: "Could not transcribe audio" });
      return;
    }

    sendMessage(socket, "transcription", { text: transcription.text });

    // Step 2: Process with LLM
    sendMessage(socket, "response_start", { status: "processing" });

    const { response, conversationId } = await processMessage(
      transcription.text,
      connection.conversationId
    );

    if (conversationId) {
      connection.conversationId = conversationId;
    }

    // Step 3: Stream TTS response
    const chunks: Buffer[] = [];
    for await (const chunk of gateway.synthesizeStream(response, { turbo: true })) {
      chunks.push(chunk);
      // Send audio chunk as binary
      socket.send(chunk);
      sendMessage(socket, "response_chunk", { chunkSize: chunk.length });
    }

    sendMessage(socket, "response_end", {
      text: response,
      audioSize: chunks.reduce((sum, c) => sum + c.length, 0),
      conversationId: connection.conversationId,
    });

    logger.debug(
      {
        connectionId,
        transcriptionLength: transcription.text.length,
        responseLength: response.length,
      },
      "Voice response sent"
    );
  } catch (error) {
    logger.error({ error, connectionId }, "Voice processing failed");
    sendMessage(socket, "error", {
      message: error instanceof Error ? error.message : "Processing failed",
    });
  }
}

/**
 * Handle direct text input (non-voice fallback)
 */
async function handleTextInput(
  connection: VoiceConnection,
  text: string,
  processMessage: (text: string, conversationId?: string) => Promise<{ response: string; conversationId?: string }>
): Promise<void> {
  const { socket, gateway, id: connectionId } = connection;

  try {
    sendMessage(socket, "response_start", { status: "processing" });

    const { response, conversationId } = await processMessage(text, connection.conversationId);

    if (conversationId) {
      connection.conversationId = conversationId;
    }

    // Stream TTS
    const chunks: Buffer[] = [];
    for await (const chunk of gateway.synthesizeStream(response, { turbo: true })) {
      chunks.push(chunk);
      socket.send(chunk);
      sendMessage(socket, "response_chunk", { chunkSize: chunk.length });
    }

    sendMessage(socket, "response_end", {
      text: response,
      audioSize: chunks.reduce((sum, c) => sum + c.length, 0),
      conversationId: connection.conversationId,
    });
  } catch (error) {
    logger.error({ error, connectionId }, "Text processing failed");
    sendMessage(socket, "error", {
      message: error instanceof Error ? error.message : "Processing failed",
    });
  }
}

/**
 * Get active voice connections
 */
export function getActiveVoiceConnections(): { id: string; createdAt: Date; hasConversation: boolean }[] {
  return Array.from(connections.values()).map((c) => ({
    id: c.id,
    createdAt: c.createdAt,
    hasConversation: !!c.conversationId,
  }));
}
