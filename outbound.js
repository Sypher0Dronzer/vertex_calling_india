// src/scripts/outbound.js
import "dotenv/config";
import fs from "fs";
import { parse } from "csv-parse/sync";
import {
  SipClient,
  RoomServiceClient,
  AgentDispatchClient,
} from "livekit-server-sdk";

const sipClient = new SipClient(
  process.env.LIVEKIT_URL,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET,
);

const roomClient = new RoomServiceClient(
  process.env.LIVEKIT_URL.replace("wss://", "https://"),
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET,
);

function loadNumbers(csvPath) {
  const content = fs.readFileSync(csvPath, "utf-8");
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

async function callContact(contact) {
  const phoneNumber = contact.phone ?? contact.Phone ?? contact.number;
  const name = contact.name ?? contact.Name ?? "Customer";

  if (!phoneNumber) {
    console.log("[Skip] No phone number in row:", contact);
    return;
  }

  const roomName = `outbound-${phoneNumber.replace(/\D/g, "")}-${Date.now()}`;
  console.log(`\n[Calling] ${name} at ${phoneNumber} → room: ${roomName}`);

  try {
    // ---- Exact same pattern as LiveKit docs ----
    const participant = await sipClient.createSipParticipant(
      String(process.env.LIVEKIT_OUTBOUND_TRUNK_ID).trim(),
      phoneNumber,
      roomName,
      {
        participantIdentity: `sip_${phoneNumber.replace(/\D/g, "")}`,
        participantName: name,
        waitUntilAnswered: true,
        playDialtone: true,
        krispEnabled: true,
        maxCallDuration: 300,
      },
    );
      console.log(
      "[Connected] Call answered, participant:",
      participant.participantIdentity,
    );

    const dispatchClient = new AgentDispatchClient(
      process.env.LIVEKIT_URL.replace("wss://", "https://"),
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
    );

    // ---- Dispatch agent to this room explicitly ----
await dispatchClient.createDispatch(roomName, 'my-agent', {
  metadata: JSON.stringify({ 
    isOutbound: true,
    callerName: name,
    callerPhone: phoneNumber,
  })})

  

    // Wait for call to finish before dialing next
    await waitForRoomEmpty(roomName);
    console.log(`[Done] Call with ${name} ended`);
  } catch (err) {
    console.error(`[Error] ${name} at ${phoneNumber}:`, err.message);
    if (err.metadata) {
      console.error("SIP status:", err.metadata["sip_status"]);
      console.error("SIP code:", err.metadata["sip_status_code"]);
    }
  }
}

async function waitForRoomEmpty(roomName) {
  while (true) {
    await sleep(3000);
    try {
      const participants = await roomClient.listParticipants(roomName);
      if (participants.length === 0) break;
      console.log(
        `[Waiting] ${participants.length} participant(s) still in room`,
      );
    } catch {
      break; // room gone = call ended
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runCampaign(csvPath) {
  const contacts = loadNumbers(csvPath);
  console.log(`[Campaign] ${contacts.length} contacts loaded from ${csvPath}`);

  for (let i = 0; i < contacts.length; i++) {
    console.log(`\n[Progress] ${i + 1}/${contacts.length}`);
    await callContact(contacts[i]);
    await sleep(2000);
  }

  console.log("\n[Campaign] All calls completed.");
}

const csvPath = process.argv[2] ?? "./contacts.csv";
runCampaign(csvPath);
