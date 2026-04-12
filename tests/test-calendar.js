
import 'dotenv/config';
import { bookAppointment, checkAvailability } from '../services/calendar.js';


// Test 1 — check slots
const slots = await checkAvailability('tomorrow');
console.log('Availability:', slots);

// Test 2 — book one
const booking = await bookAppointment('tomorrow', '3pm', 'Test User', '+91XXXXXXXXXX');
console.log('Booking:', booking);