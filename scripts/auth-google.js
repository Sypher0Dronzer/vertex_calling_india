// scripts/auth-google.js
// Run this ONCE: node scripts/auth-google.js
// Copy the refresh_token it prints into your .env

import 'dotenv/config';
import { google } from 'googleapis';
import readline from 'readline';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);

const SCOPES = ['https://www.googleapis.com/auth/calendar','https://www.googleapis.com/auth/spreadsheets'];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // forces refresh_token to be returned
});

console.log('\n--- Google OAuth2 Setup ---');
console.log('1. Open this URL in your browser:');
console.log('\n' + authUrl + '\n');
console.log('2. Authorize the app');
console.log('3. Copy the code shown and paste it below\n');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('Paste the code here: ', async (code) => {
  rl.close();
  const { tokens } = await oauth2Client.getToken(code.trim());
  console.log('\n--- Add this to your .env file ---');
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log('\nSetup complete.');
});

//code=4/0Aci98E_sbttL2RhuvxfXB-3UHumb4YRdzWz-w2xueGfi0mrfNQwcEpsFSMXjejbI8AXDNA