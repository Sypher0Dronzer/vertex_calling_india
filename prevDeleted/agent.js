entry: async (ctx) => {
    await ctx.connect();
    const participant = await ctx.waitForParticipant();
     const agent = new voice.Agent({
          instructions: prompt2,
          transcription: {
            userTranscription: true,
            agentTranscription: true,
            sentenceTokenizer: true, // Split LLM output into sentences for early TTS
          },
          tools: calendarTools,
        });

    // Detect if outbound — room name starts with "outbound-"
    // const isOutbound = ctx.room.name.startsWith('outbound-');
    // const callerName = participant.name ?? 'there';

    // Extract phone from SIP identity: "sip_+916292016636" → "+916292016636"
  const callerPhone = participant.identity.replace('sip_', '').replace('sip-', '');

    // Read metadata passed from outbound script
    const metadata = ctx.job.metadata ? JSON.parse(ctx.job.metadata) : {};
    const isOutbound = metadata.isOutbound ?? false;
    const callerName = metadata.callerName ?? participant.name ?? "there";

    // Create the agent session with STT, LLM, and TTS configurations
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad,
      // Speech-to-Text using Sarvam plugin with auto-detection
      stt: new sarvam.STT({
        targetLanguageCode: "unknown", // Auto-detect language
        model: "saaras:v3",
        speaker: "shubh",
        pace: 1.0,
        temperature: 0.6,
      }),

      // Large Language Model using OpenAI-compatible Mistral
      // llm: new openai.LLM({
      //   model: "mistral-large-latest",
      //   baseURL: "https://api.mistral.ai/v1",
      //   apiKey: process.env.MISTRAL_API_KEY,
      // }),
      llm: "openai/gpt-4.1-mini",
      // Text-to-Speech using Sarvam plugin
      tts: new sarvam.TTS({
        targetLanguageCode: "en-IN",
        model: "bulbul:v3",
        speaker: "simran", // Female: priya, simran, ishita, kavya | Male: aditya, anand, rohan
      }),
    });

    // Event listener for user speech committed: Update instructions based on detected language
    session.on("user_speech_committed", (userMsg) => {
      const detectedLang = userMsg?.language ?? null;
      console.log("[Language detected]", detectedLang);

      // Map detected language to TTS language code
      const ttsLang = langMap[detectedLang] ?? "en-IN";
      // Get script instructions for the language
      const scriptRule = scriptInstructions[ttsLang] ?? "Reply in English.";

      // Update agent instructions dynamically based on detected language
      session.updateAgentInstructions(
        `You are a helpful voice assistant for booking appointments in India.
Keep every reply to ONE sentence maximum.
Never use markdown, bullet points, or special characters.
Speak naturally as if on a phone call.
CRITICAL: ${scriptRule}
NEVER romanize any language. Always use the native script.`,
      );
    });

    // Start the agent session in the room
    await session.start({ agent, room: ctx.room });

    if (isOutbound) {
      // Agent speaks first on outbound
      await session.say(
        `Hello ${callerName} ! This is a call from our clinic. I am calling to remind you about your upcoming appointment. How can I help you today?`,
      );
    } else {
      // Inbound — ask language preference
      await session.say("Namaste! What language are you comfortable in?");
    }
  },