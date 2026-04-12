import { ServerOptions, cli, defineAgent, llm, voice } from "@livekit/agents";
import * as silero from "@livekit/agents-plugin-silero";
import { fileURLToPath } from "node:url";
// import * as openai from "@livekit/agents-plugin-openai";
import { configDotenv } from "dotenv";
import * as sarvam from "@livekit/agents-plugin-sarvam";
// import { prompt2,langMap, prompt1, scriptInstructions } from "./constants.js";
import { createCalendarTools } from "./tools/calendar.tool.js";
import {buildPrompt} from './constants.js'
configDotenv();

export default defineAgent({
  // Prewarm function: Executed once at startup to prepare shared resources
  prewarm: async (proc) => {
    // Load the Voice Activity Detection (VAD) model once, to be reused across all calls
    proc.userData.vad = await silero.VAD.load();
  },

  // Entry function: Main logic executed for each call
  entry: async (ctx) => {
  await ctx.connect();
  const participant  = await ctx.waitForParticipant();
  const callerPhone  = participant.identity.replace(/^sip[_-]/, '');
  const isOutbound   = ctx.room.name.startsWith('outbound-');
  const metadata     = ctx.job?.metadata ? JSON.parse(ctx.job.metadata) : {};
  const callerName   = metadata.callerName ?? null; // this is basically the company name
  console.log("This is metadata", metadata)

  const agent = new voice.Agent({
    instructions: buildPrompt(isOutbound, callerName),
    tools: createCalendarTools(ctx.room, callerPhone),
  });

  const session = new voice.AgentSession({
    vad: ctx.proc.userData.vad,
    stt: new sarvam.STT({ targetLanguageCode: 'unknown', model: 'saaras:v3' }),
    llm: 'openai/gpt-4.1-mini',
    tts: new sarvam.TTS({ targetLanguageCode: 'en-IN', model: 'bulbul:v3', speaker: 'simran' }),
  });

  await session.start({ agent, room: ctx.room });

  if (isOutbound) {
    await session.say(`Hello ! This is Simran from Vertex Media. We help businesses grow through digital marketing and media solutions. Do you have a couple of minutes to hear more?`);
  } else {
    await session.say(`Hello! Thank you for calling Vertex Media. How can I help you today?`);
  }
},
});

// Run the application with server options
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: "my-agent",
  }),
);
