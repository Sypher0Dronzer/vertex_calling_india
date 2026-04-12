// services/calendar.js
import "dotenv/config";
import { google } from "googleapis";
import * as chrono from "chrono-node";

function getAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
  return oauth2Client;
}

const getCalendar = () => google.calendar({ version: "v3", auth: getAuth() });
const getSheets = () => google.sheets({ version: "v4", auth: getAuth() });

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SLOT_DURATION_MINUTES = 30;

function parseDate(dateStr) {
  if (!dateStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  return chrono.parseDate(dateStr, new Date(), { forwardDate: true }) ?? null;
}

function parseTime(timeStr) {
  if (!timeStr) return null;
  const hhmm = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) return { hours: parseInt(hhmm[1]), minutes: parseInt(hhmm[2]) };
  const ampm = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (ampm) {
    let h = parseInt(ampm[1]);
    const m = parseInt(ampm[2] ?? "0");
    const mer = ampm[3].toLowerCase();
    if (mer === "pm" && h < 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    return { hours: h, minutes: m };
  }
  return null;
}

function validateFutureDate(date) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  if (date < now)
    return {
      error: true,
      message: "That date is in the past. Please choose a future date.",
    };
  return null;
}

// ---- Check availability  this does 12-3 am----
export async function checkAvailability(dateStr) {
  const date = parseDate(dateStr);
  if (!date)
    return { error: true, message: `Could not understand date: ${dateStr}` };
  const pastError = validateFutureDate(date);
  if (pastError) return pastError;

  const calendar = getCalendar();
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const res = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    // timeZone: "Asia/Kolkata",
  });

  const events = res.data.items ?? [];

  // ---- FIX: correct loop end ----
  const loopEnd = new Date(date);
  loopEnd.setHours(23, 30, 0, 0); // last slot starts at 11:30pm

  const allSlots = [];
  const cur = new Date(dayStart);
  while (cur <= loopEnd) {            // ← compare Date to Date, not Date to number
    allSlots.push(new Date(cur));
    cur.setMinutes(cur.getMinutes() + SLOT_DURATION_MINUTES);
  }

  // Generate all 30-min slots for the day
  // const allSlots = [];
  // const cur = new Date(dayStart);
  // while (cur <= new Date(date).setHours(23, 30, 0, 0)) {
  //   allSlots.push(new Date(cur));
  //   cur.setMinutes(cur.getMinutes() + SLOT_DURATION_MINUTES);
  // }

  const now = new Date();
  const freeSlots = allSlots
    .filter((slot) => slot > now)
    .filter((slot) => {
      const slotEnd = new Date(slot.getTime() + SLOT_DURATION_MINUTES * 60000);
      return !events.some((e) => {
        const es = new Date(e.start.dateTime ?? e.start.date);
        const ee = new Date(e.end.dateTime ?? e.end.date);
        return slot < ee && slotEnd > es;
      });
    });

  if (freeSlots.length === 0)
    return { available: false, message: `No slots available on ${dateStr}.` };

  const readable = freeSlots
    .slice(0, 5)
    .map((s) =>
      s.toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      }),
    );
  return {
    available: true,
    date: dateStr,
    freeSlots: readable,
    message: `Available slots on ${dateStr}: ${readable.join(", ")}`,
  };
}



// ---- Book meeting ----
export async function bookMeeting(dateStr, timeStr, callerName, callerPhone) {
  console.log(
    "---- bookMeeting ----",
    dateStr,
    timeStr,
    callerName,
    callerPhone,
  );
  const date = parseDate(dateStr);
  if (!date)
    return { error: true, message: `Could not parse date: ${dateStr}` };
  const pastError = validateFutureDate(date);
  if (pastError) return pastError;
  const time = parseTime(timeStr);
  if (!time)
    return { error: true, message: `Could not parse time: ${timeStr}` };

  const startTime = new Date(date);
  startTime.setHours(time.hours, time.minutes, 0, 0);
  const endTime = new Date(startTime.getTime() + SLOT_DURATION_MINUTES * 60000);

  const calendar = getCalendar();
  const event = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    resource: {
      summary: `Meeting — ${callerName}`,
      description: `Vertex Media meeting\nClient: ${callerName}\nPhone: ${callerPhone}`,
      start: { dateTime: startTime.toISOString() },
      end: { dateTime: endTime.toISOString() },
    },
  });

  // Log to Sheet1 — main meetings sheet
  const now = new Date();
  await getSheets().spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Meetings!A:F",
    valueInputOption: "USER_ENTERED",
    resource: {
      values: [
        [
          callerName,
          callerPhone,
          now.toLocaleDateString("en-IN"), // date called
          dateStr, // date of meeting
          timeStr, // time of meeting
          "Confirmed",
        ],
      ],
    },
  });

  return {
    success: true,
    message: `Meeting booked for ${callerName} on ${dateStr} at ${timeStr}. We look forward to speaking with you.`,
  };
}

// ---- Cancel meeting ----
export async function cancelMeeting(callerPhone, dateStr) {
  console.log("---- cancelMeeting ----", callerPhone, dateStr);
  const date = parseDate(dateStr);
  if (!date)
    return { error: true, message: `Could not parse date: ${dateStr}` };

  const calendar = getCalendar();
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const res = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
  });

  const event = res.data.items?.find((e) =>
    e.description?.includes(callerPhone),
  );
  if (!event)
    return {
      error: true,
      message: `No meeting found for ${callerPhone} on ${dateStr}.`,
    };

  const name = event.summary?.replace("Meeting — ", "") ?? "Unknown";
  const timeStr = new Date(event.start.dateTime).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: event.id });

  return {
    success: true,
    message: `Meeting for ${name} at ${timeStr} on ${dateStr} has been cancelled.`,
  };
}

// ---- Reschedule meeting ----
export async function rescheduleMeeting(
  callerPhone,
  currentDateStr,
  newDateStr,
  newTimeStr,
) {
  console.log(
    "---- rescheduleMeeting ----",
    callerPhone,
    currentDateStr,
    newDateStr,
    newTimeStr,
  );
  const currentDate = parseDate(currentDateStr);
  if (!currentDate)
    return { error: true, message: `Could not parse date: ${currentDateStr}` };

  const calendar = getCalendar();
  const dayStart = new Date(currentDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(currentDate);
  dayEnd.setHours(23, 59, 59, 999);

  const res = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
    
  });

  const event = res.data.items?.find((e) =>
    e.description?.includes(callerPhone),
  );
  if (!event)
    return {
      error: true,
      message: `No meeting found for ${callerPhone} on ${currentDateStr}.`,
    };

  const newDate = parseDate(newDateStr);
  if (!newDate)
    return { error: true, message: `Could not parse new date: ${newDateStr}` };
  const pastError = validateFutureDate(newDate);
  if (pastError) return pastError;

  const time = parseTime(newTimeStr);
  if (!time)
    return { error: true, message: `Could not parse new time: ${newTimeStr}` };

  const newStart = new Date(newDate);
  newStart.setHours(time.hours, time.minutes, 0, 0);
  const newEnd = new Date(newStart.getTime() + SLOT_DURATION_MINUTES * 60000);

  await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId: event.id,
    resource: {
      start: { dateTime: newStart.toISOString() },
      end: { dateTime: newEnd.toISOString() },
    },
  });

  return {
    success: true,
    message: `Meeting rescheduled to ${newDateStr} at ${newTimeStr}.`,
  };
}

// ---- Log callback request ----
// For people who say "call me later" or "not interested right now"
export async function logCallbackRequest(
  callerPhone,
  callerName,
  preferredTime,
) {
  console.log("---- logCallbackRequest ----", callerPhone, callerName);
  const now = new Date();

  await getSheets().spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Callbacks!A:D",
    valueInputOption: "USER_ENTERED",
    resource: {
      values: [
        [
          callerName,
          callerPhone,
          now.toLocaleDateString("en-IN"),
          preferredTime ?? "Not specified",
        ],
      ],
    },
  });

  return {
    success: true,
    message: `No problem! We will call you back${preferredTime ? ` around ${preferredTime}` : " at a convenient time"}. Have a great day!`,
  };
}
