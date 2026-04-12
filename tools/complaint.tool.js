import { google } from "googleapis";

// Initialize Google Sheets Auth
const auth = new google.auth.GoogleAuth({
    keyFile: "path/to/your/service-account.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;

export const complaintTools = {
    execute: () => {
        console.log("This is a placeholder. Please call the specific complaint tool like 'file_complaint'.");
    },
    // We define the tool as a plain object with description, parameters, and execute
    file_complaint: {
        description: "Files a formal complaint into the Google Sheet system",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Name of the person complaining" },
                issue: { type: "string", description: "The details of the complaint" },
                phone: { type: "string", description: "The contact phone number" },
            },
            required: ["name", "issue", "phone"],
        },
        execute: async ({ name, issue, phone }) => {
            try {
                console.log(`[Tool] Logging complaint for ${name}...`);
                await sheets.spreadsheets.values.append({
                    spreadsheetId: SPREADSHEET_ID,
                    range: "Sheet1!A:D",
                    valueInputOption: "USER_ENTERED",
                    requestBody: {
                        values: [[new Date().toLocaleString(), name, phone, issue]],
                    },
                });
                return "The complaint has been successfully recorded in the system.";
            } catch (error) {
                console.error("Error logging complaint:", error);
                return "There was an error saving the complaint. Please try again later.";
            }
        },
    },
};