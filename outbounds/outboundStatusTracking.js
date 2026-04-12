// src/scripts/outbound.js
import "dotenv/config";
import fs from "fs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { google } from "googleapis";
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

const dispatchClient = new AgentDispatchClient(
  process.env.LIVEKIT_URL.replace("wss://", "https://"),
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET,
);

// ---- Status values ----
// pending    → not yet called
// accepted   → booked a meeting
// rejected   → not interested
// no_answer  → didn't pick up or invalid number
// callback   → asked to call later

// ---- CSV helpers ----
function loadCSV(csvPath) {
  const content = fs.readFileSync(csvPath, "utf-8");
  return parse(content, { columns: true, skip_empty_lines: true, trim: true });
}

function saveCSV(csvPath, rows) {
  const csv = stringify(rows, { header: true });
  fs.writeFileSync(csvPath, csv);
}

// ---- Google Sheets helpers ----
function getSheets() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.sheets({ version: "v4", auth });
}

async function loadFromSheets() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Leads!A:D", // Name | Phone | Status
  });
  const rows = res.data.values ?? [];
  const headers = rows[0]; // ['Name', 'Phone', 'Status']
  return rows.slice(1).map((row) => ({
    name:   row[0] ?? "Customer",
    phone:  row[1] ?? "",
    status: row[2] ?? "pending",
    company:row[3]?? "",
    _rowIndex: rows.indexOf(row) + 1, // 1-indexed, +1 for header
  }));
}

async function updateSheetStatus(rowIndex, status) {
  const sheets = getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `Leads!C${rowIndex }`, // +1 because row 1 is header
    valueInputOption: "USER_ENTERED",
    resource: { values: [[status]] },
  });
}

// ---- Determine call outcome by monitoring room ----
async function waitForCallOutcome(roomName) {
  // Give agent time to join and conversation to happen
  await sleep(5000);

  let lastParticipantCount = 0;
  let maxWait = 300; // max 5 minutes

  while (maxWait > 0) {
    await sleep(3000);
    maxWait -= 3;

    try {
      const participants = await roomClient.listParticipants(roomName);
      lastParticipantCount = participants.length;
      if (participants.length === 0) break;
      console.log(`[Waiting] ${participants.length} participant(s) in room`);
    } catch {
      break;
    }
  }

  // Read outcome from room metadata set by agent
  try {
    const rooms = await roomClient.listRooms([roomName]);
    const meta  = rooms[0]?.metadata ? JSON.parse(rooms[0].metadata) : {};
    return meta.callOutcome ?? "no_answer";
  } catch {
    return "no_answer";
  }
}

// ---- Main call function ----
async function callContact(contact) {
  const phoneNumber = contact.phone ?? contact.Phone ?? contact.number;
  const name        = contact.name  ?? contact.Name  ?? "Customer";

  if (!phoneNumber) {
    console.log("[Skip] No phone number:", contact);
    return "no_answer";
  }

  // Skip already processed contacts
  const status = (contact.status ?? "pending").toLowerCase();
  if (["accepted", "rejected", "callback"].includes(status)) {
    console.log(`[Skip] ${name} already has status: ${status}`);
    return status;
  }

  const roomName = `outbound-${phoneNumber.replace(/\D/g, "")}-${Date.now()}`;
  console.log(`\n[Calling] ${name} at ${phoneNumber} → room: ${roomName}`);

  try {
    await sipClient.createSipParticipant(
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
        ringingTimeout: 30, // 30s ring timeout
      },
    );

    console.log("[Connected] Call answered");

    await dispatchClient.createDispatch(roomName, "my-agent", {
      metadata: JSON.stringify({
        isOutbound: true,
        callerName: name,
        callerPhone: phoneNumber,
      }),
    });

    const outcome = await waitForCallOutcome(roomName);
    console.log(`[Outcome] ${name}: ${outcome}`);
    return outcome;

  } catch (err) {
    // waitUntilAnswered throws if not answered
    if (err.message?.includes("timeout") || err.message?.includes("not answered")) {
      console.log(`[No Answer] ${name} did not pick up`);
      return "no_answer";
    }
    console.error(`[Error] ${name} at ${phoneNumber}:`, err.message);
    return "no_answer";
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- CSV campaign ----
async function runCSVCampaign(csvPath) {
  let contacts = loadCSV(csvPath);

  // Add status column if missing
  if (!("status" in (contacts[0] ?? {}))) {
    contacts = contacts.map((c) => ({ ...c, status: "pending" }));
  }

  const pending = contacts.filter(
    (c) => !["accepted", "rejected", "callback"].includes((c.status ?? "").toLowerCase())
  );
  console.log(`[Campaign] ${pending.length} pending out of ${contacts.length} total`);

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    const status  = (contact.status ?? "pending").toLowerCase();

    if (["accepted", "rejected", "callback"].includes(status)) {
      console.log(`[Skip] ${contact.name ?? contact.Name} — ${status}`);
      continue;
    }

    console.log(`\n[Progress] ${i + 1}/${contacts.length}`);
    const outcome = await callContact(contact);

    // Update status in array and save immediately
    // so if script crashes we don't lose progress
    contacts[i].status = outcome;
    saveCSV(csvPath, contacts);
    console.log(`[Saved] ${contact.name ?? contact.Name} → ${outcome}`);

    await sleep(2000);
  }

  console.log("\n[Campaign] Done.");
  console.log("[Summary]");
  const summary = contacts.reduce((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});
  console.table(summary);
}

// ---- Sheets campaign ----
async function runSheetsCampaign() {
  const contacts = await loadFromSheets();
  const pending  = contacts.filter(
    (c) => !["accepted", "rejected", "callback"].includes((c.status ?? "").toLowerCase())
  );
  console.log(`[Campaign] ${pending.length} pending out of ${contacts.length} total`);

  for (const contact of contacts) {
    const status = (contact.status ?? "pending").toLowerCase();
    if (["accepted", "rejected", "callback"].includes(status)) {
      console.log(`[Skip] ${contact.name} — ${status}`);
      continue;
    }

    const outcome = await callContact(contact);

    // Update status in sheet immediately
    await updateSheetStatus(contact._rowIndex, outcome);
    console.log(`[Saved] ${contact.name} → ${outcome} (row ${contact._rowIndex + 1})`);

    await sleep(2000);
  }

  console.log("\n[Campaign] Done.");
}

// ---- Entry point ----
const source = process.argv[2] ?? "./contacts.csv";

if (source === "--sheets") {
  runSheetsCampaign();
} else {
  runCSVCampaign(source);
}