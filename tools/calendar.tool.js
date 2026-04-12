// src/tools/calendar.tool.js
import { llm } from "@livekit/agents";
import {
  bookMeeting,
  cancelMeeting,
  checkAvailability,
  logCallbackRequest,
  rescheduleMeeting,
} from "../services/calendar.js";

// Add this at top of calendar.tool.js
async function setCallOutcome(room, outcome) {
  try {
    const { RoomServiceClient } = await import('livekit-server-sdk');
    const roomClient = new RoomServiceClient(
      process.env.LIVEKIT_URL.replace('wss://', 'https://'),
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
    );
    await roomClient.updateRoomMetadata(
      room.name,
      JSON.stringify({ callOutcome: outcome })
    );
  } catch (e) {
    console.error('[setCallOutcome error]', e.message);
  }
}

export function createCalendarTools(room, callerPhone) {
  return {
    check_availability: llm.tool({
      description: 'Check available meeting slots on a given date.',
      parameters: llm.toJsonSchema({
        type: 'object',
        properties: {
          date: { type: 'string', description: 'ISO format YYYY-MM-DD' },
        },
        required: ['date'],
      }),
      execute: async ({ date }) => {
        console.log('[Tool] check_availability', date);
        return JSON.stringify(await checkAvailability(date));
      },
    }),

    book_meeting: llm.tool({
      description: 'Book a meeting with the client. For inbound calls, ask for their name first. For outbound, name is already known.',
      parameters: llm.toJsonSchema({
        type: 'object',
        properties: {
          date: { type: 'string', description: 'ISO format YYYY-MM-DD' },
          time: { type: 'string', description: '24hr HH:MM' },
          name: { type: 'string', description: 'Client name — use known name if available' },
        },
        required: ['date', 'time', 'name'],
      }),
      execute: async ({ date, time, name }) => {
        console.log('[Tool] book_meeting', date, time, name, callerPhone);
        const result = await bookMeeting(date, time, name, callerPhone);

        // Hang up after successful booking
        if (result.success) {
          setTimeout(async () => {
            try {
              const { RoomServiceClient } = await import('livekit-server-sdk');
              const roomClient = new RoomServiceClient(
                process.env.LIVEKIT_URL.replace('wss://', 'https://'),
                process.env.LIVEKIT_API_KEY,
                process.env.LIVEKIT_API_SECRET,
              );
              await roomClient.removeParticipant(room.name, `sip_${callerPhone.replace('+', '')}`);
            } catch (e) {
              console.error('[Hangup error]', e.message);
            }
          }, 6000);
        }
        await setCallOutcome(room, 'accepted');

        return JSON.stringify(result);
      },
    }),

    cancel_meeting: llm.tool({
      description: 'Cancel an existing meeting using phone number and date.',
      parameters: llm.toJsonSchema({
        type: 'object',
        properties: {
          date: { type: 'string', description: 'ISO format YYYY-MM-DD' },
        },
        required: ['date'],
      }),
      execute: async ({ date }) => {
        console.log('[Tool] cancel_meeting', callerPhone, date);
        return JSON.stringify(await cancelMeeting(callerPhone, date));
      },
    }),

    reschedule_meeting: llm.tool({
      description: 'Reschedule an existing meeting to a new date and time.',
      parameters: llm.toJsonSchema({
        type: 'object',
        properties: {
          current_date: { type: 'string', description: 'Current meeting date ISO YYYY-MM-DD' },
          new_date:     { type: 'string', description: 'New date ISO YYYY-MM-DD' },
          new_time:     { type: 'string', description: 'New time HH:MM 24hr' },
        },
        required: ['current_date', 'new_date', 'new_time'],
      }),
      execute: async ({ current_date, new_date, new_time }) => {
        console.log('[Tool] reschedule_meeting', callerPhone, current_date, new_date, new_time);
        return JSON.stringify(await rescheduleMeeting(callerPhone, current_date, new_date, new_time));
      },
    }),

    request_callback: llm.tool({
      description: 'Log a callback request when the client says they are busy, not interested right now, or want to be called later.',
      parameters: llm.toJsonSchema({
        type: 'object',
        properties: {
          name:           { type: 'string', description: 'Client name' },
          preferred_time: { type: 'string', description: 'When they want to be called back e.g. "tomorrow evening", "next week"' },
        },
        required: ['name'],
      }),
      execute: async ({ name, preferred_time }) => {
        console.log('[Tool] request_callback', callerPhone, name);
        const result = await logCallbackRequest(callerPhone, name, preferred_time ?? null);

        // Hang up after logging callback
        setTimeout(async () => {
          try {
            const { RoomServiceClient } = await import('livekit-server-sdk');
            const roomClient = new RoomServiceClient(
              process.env.LIVEKIT_URL.replace('wss://', 'https://'),
              process.env.LIVEKIT_API_KEY,
              process.env.LIVEKIT_API_SECRET,
            );
            await roomClient.removeParticipant(room.name, `sip_${callerPhone.replace('+', '')}`);
          } catch (e) {
            console.error('[Hangup error]', e.message);
          }
        }, 5000);
        await setCallOutcome(room, 'callback');

        return JSON.stringify(result);
      },
    }),

    transfer_to_human: llm.tool({
      description: 'Transfer the call to a human operator when the caller asks something out of scope, wants to speak to a person, or has a complex query.',
      parameters: llm.toJsonSchema({
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Reason for transfer' },
        },
        required: ['reason'],
      }),
      execute: async ({ reason }) => {
        console.log('[Tool] transfer_to_human', reason);
        await setCallOutcome(room, 'transferred');
        try {
          const { SipClient } = await import('livekit-server-sdk');
          const sipClient = new SipClient(
            process.env.LIVEKIT_URL.replace('wss://', 'https://'),
            process.env.LIVEKIT_API_KEY,
            process.env.LIVEKIT_API_SECRET,
          );
          // Transfer to your operator number
          const sipParticipantIdentity = `sip_${callerPhone.replace('+', '')}`;
          await sipClient.transferSipParticipant(
            room.name,
            sipParticipantIdentity,
            `tel:${process.env.OPERATOR_PHONE_NUMBER}`,
            { playDialtone: true },
          );
          return JSON.stringify({ success: true, message: 'Transferring you to our team now. Please hold.' });
        } catch (e) {
          console.error('[Transfer error]', e.message);
          return JSON.stringify({ error: true, message: 'Transfer failed. Our team will call you back shortly.' });
        }
      },
    }),

    mark_not_interested: llm.tool({
  description: 'Call this when the person clearly says they are not interested and want to end the call.',
  parameters: llm.toJsonSchema({ type: 'object', properties: {}, required: [] }),
  execute: async () => {
    await setCallOutcome(room, 'rejected');
    setTimeout(async () => {
      try {
        const { RoomServiceClient } = await import('livekit-server-sdk');
        const rc = new RoomServiceClient(
          process.env.LIVEKIT_URL.replace('wss://', 'https://'),
          process.env.LIVEKIT_API_KEY,
          process.env.LIVEKIT_API_SECRET,
        );
        await rc.removeParticipant(room.name, `sip_${callerPhone.replace('+', '')}`);
      } catch {}
    }, 4000);
    return JSON.stringify({ success: true, message: 'No problem at all. Have a great day!' });
  },
}),
  };
}