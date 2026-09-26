//!/usr/bin/env node
// Tablekeeper Stage 1 Implementation
// This is a Node.js/TypeScript implementation following the spec
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const { DateTime, IANAZone } = require('luxon');
const fs = require('fs');
// In-memory storage (in production, this would be a database)
let state = {
    users: {},
    restaurants: {},
    reservations: {},
    idempotencyKeys: {},
    exportState: null
};
const app = express();
app.use(express.json());
// Helper functions
const generateReference = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};
const validateEmail = (email) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};
const validateTimeFormat = (time) => {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(time);
};
const getRestaurantById = (id) => {
    return state.restaurants[id];
};
const getUserById = (id) => {
    return state.users[id];
};
const getReservationByReference = (reference) => {
    return Object.values(state.reservations).find(r => r.reference === reference);
};
const getReservationsByUserId = (userId) => {
    return Object.values(state.reservations).filter(r => r.user_id === userId);
};
const getReservationById = (id) => {
    return state.reservations[id];
};
// Middleware
const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: {
                code: 'unauthenticated',
                message: 'Missing or invalid authorization header'
            }
        });
    }
    // In a real implementation, we'd validate the token
    // For now, we'll simulate authentication
    const token = authHeader.substring(7);
    // For demo purposes, we'll just check if it's a valid UUID-like string
    if (!token.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        return res.status(401).json({
            error: {
                code: 'unauthenticated',
                message: 'Invalid token'
            }
        });
    }
    // Simulate authenticated user (in real app, we'd decode the token)
    req.user = { id: 'u_test_user' };
    next();
};
// Error handling middleware
const errorHandler = (err, req, res, next) => {
    console.error(err);
    res.status(500).json({
        error: {
            code: 'internal_error',
            message: 'Internal server error'
        }
    });
};
// Routes
// Health endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});
// Reset endpoint
app.post('/_test/reset', async (req, res) => {
    const fixture = req.body;
    // Clear current state
    state = {
        users: {},
        restaurants: {},
        reservations: {},
        idempotencyKeys: {},
        exportState: null
    };
    
    // Process users with proper async handling
    const userPromises = fixture.users.map(async (user) => {
        // Hash the password if it's not already hashed
        if (user.password && !user.password_hash) {
            try {
                const saltRounds = 10;
                const hash = await new Promise((resolve, reject) => {
                    bcrypt.hash(user.password, saltRounds, (err, hash) => {
                        if (err) reject(err);
                        else resolve(hash);
                    });
                });
                const newUser = {
                    ...user,
                    password_hash: hash,
                    password: undefined // Remove plaintext password
                };
                state.users[user.id] = newUser;
            } catch (err) {
                console.error('Failed to hash password during reset:', err);
                throw err;
            }
        } else {
            // User already has password_hash or no password
            state.users[user.id] = user;
        }
    });
    
    try {
        await Promise.all(userPromises);
        fixture.restaurants.forEach(restaurant => {
            state.restaurants[restaurant.id] = restaurant;
        });
        fixture.reservations.forEach(reservation => {
            state.reservations[reservation.id] = reservation;
        });
        res.status(204).send();
    } catch (err) {
        return res.status(500).json({
            error: {
                code: 'internal_error',
                message: 'Failed to process users during reset'
            }
        });
    }
});
// Export endpoint
app.get('/_test/export', (req, res) => {
    res.status(200).json({
        track: 'tablekeeper',
        format_version: 1,
        state: {
            users: state.users,
            restaurants: state.restaurants,
            reservations: state.reservations,
            idempotencyKeys: state.idempotencyKeys,
            exportState: state.exportState
        }
    });
});
// Import endpoint
app.post('/_test/import', (req, res) => {
    const { track, format_version, state: importedState } = req.body;
    if (track !== 'tablekeeper' || format_version !== 1) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Invalid track or format version'
            }
        });
    }
    // Replace state
    state.users = importedState.users || {};
    state.restaurants = importedState.restaurants || {};
    state.reservations = importedState.reservations || {};
    state.idempotencyKeys = importedState.idempotencyKeys || {};
    state.exportState = importedState.exportState || null;
    res.status(204).send();
});
// Authentication endpoints
app.post('/auth/signup', (req, res) => {
    const { email, password, display_name } = req.body;
    // Validate inputs
    if (!validateEmail(email)) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Invalid email format'
            }
        });
    }
    if (password.length < 8) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Password must be at least 8 characters'
            }
        });
    }
    if (state.users[email]) {
        return res.status(409).json({
            error: {
                code: 'email_taken',
                message: 'Email already registered'
            }
        });
    }
    // Hash password
    const saltRounds = 10;
    bcrypt.hash(password, saltRounds, (err, hash) => {
        if (err) {
            return res.status(500).json({
                error: {
                    code: 'internal_error',
                    message: 'Failed to hash password'
                }
            });
        }
        const userId = `u_${uuidv4().substring(0, 12)}`;
        const newUser = {
            id: userId,
            email,
            password_hash: hash,
            display_name
        };
        state.users[userId] = newUser;
        // Generate a mock token for demonstration
        const token = `token_${uuidv4().substring(0, 16)}`;
        res.status(201).json({
            user_id: userId,
            display_name,
            token
        });
    });
});
app.post('/auth/login', (req, res) => {
    const { email, password } = req.body;
    // Find user
    const user = Object.values(state.users).find(u => u.email === email);
    if (!user) {
        return res.status(401).json({
            error: {
                code: 'unauthenticated',
                message: 'Invalid email or password'
            }
        });
    }
    // Compare password
    bcrypt.compare(password, user.password_hash, (err, result) => {
        if (err || !result) {
            return res.status(401).json({
                error: {
                    code: 'unauthenticated',
                    message: 'Invalid email or password'
                }
            });
        }
        // Generate a mock token for demonstration
        const token = `token_${uuidv4().substring(0, 16)}`;
        res.status(200).json({
            user_id: user.id,
            display_name: user.display_name,
            token
        });
    });
});
// Public endpoints
app.get('/restaurants', (req, res) => {
    const restaurants = Object.values(state.restaurants).map(r => ({
        id: r.id,
        name: r.name,
        timezone: r.timezone
    }));
    res.status(200).json({ restaurants });
});
app.get('/restaurants/:id', (req, res) => {
    const restaurant = getRestaurantById(req.params.id);
    if (!restaurant) {
        return res.status(404).json({
            error: {
                code: 'not_found',
                message: 'Restaurant not found'
            }
        });
    }
    res.status(200).json(restaurant);
});
app.get('/availability', (req, res) => {
    const { restaurant_id, date, party_size } = req.query;
    // Validate required parameters
    if (!restaurant_id || !date || !party_size) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Missing required parameters'
            }
        });
    }
    const restaurant = getRestaurantById(restaurant_id);
    if (!restaurant) {
        return res.status(404).json({
            error: {
                code: 'not_found',
                message: 'Restaurant not found'
            }
        });
    }
    // Validate party size
    const partySize = parseInt(party_size, 10);
    if (isNaN(partySize) || partySize < 1) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Invalid party size'
            }
        });
    }
    // Get available slots
    const slots = generateAvailableSlots(restaurant, date, partySize);
    res.status(200).json({
        restaurant_id,
        date,
        timezone: restaurant.timezone,
        slots
    });
});
// Helper function to generate available slots
const generateAvailableSlots = (restaurant, dateStr, partySize) => {
    // Parse the date
    const targetDate = DateTime.fromISO(dateStr, { zone: 'UTC' });
    if (!targetDate.isValid) {
        return [];
    }
    // Find opening hours for this day
    const weekday = targetDate.toISOWeekday() === 7 ? 'sun' : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][targetDate.toISOWeekday() - 1];
    const openingHour = restaurant.opening_hours.find(h => h.weekday === weekday);
    if (!openingHour) {
        return [];
    }
    const slots = [];
    // Parse opening and closing times
    const [openHour, openMinute] = openingHour.opens.split(':').map(Number);
    const [closeHour, closeMinute] = openingHour.closes.split(':').map(Number);
    // Create slots
    let slotStart = DateTime.fromObject({
        year: targetDate.year,
        month: targetDate.month,
        day: targetDate.day,
        hour: openHour,
        minute: openMinute,
        zone: restaurant.timezone
    });
    const slotEnd = DateTime.fromObject({
        year: targetDate.year,
        month: targetDate.month,
        day: targetDate.day,
        hour: closeHour,
        minute: closeMinute,
        zone: restaurant.timezone
    });
    const durationMinutes = restaurant.reservation_duration_minutes;
    const slotInterval = restaurant.slot_minutes;
    while (slotStart < slotEnd) {
        const slotEndDateTime = slotStart.plus({ minutes: durationMinutes });
        // Check if slot would exceed closing time
        if (slotEndDateTime > slotEnd) {
            break;
        }
        // Check if table is available
        const availableTables = getAvailableTables(restaurant, slotStart, slotEndDateTime, partySize);
        slots.push({
            starts_at_local: slotStart.toISO({ suppressMilliseconds: true, includeOffset: false }),
            starts_at: slotStart.toISO({ suppressMilliseconds: true }),
            available_table_ids: availableTables.map(t => t.id)
        });
        slotStart = slotStart.plus({ minutes: slotInterval });
    }
    return slots;
};
// Helper function to find available tables
const getAvailableTables = (restaurant, start, end, partySize) => {
    // Filter tables by capacity
    const eligibleTables = restaurant.tables.filter(table => table.capacity >= partySize);
    // Check for conflicts with existing reservations
    const availableTables = [];
    for (const table of eligibleTables) {
        let isAvailable = true;
        // Check existing reservations for this table
        for (const reservation of Object.values(state.reservations)) {
            if (reservation.table_id === table.id && reservation.status === 'confirmed') {
                const resStart = DateTime.fromISO(reservation.starts_at);
                const resEnd = DateTime.fromISO(reservation.ends_at);
                // Check for overlap
                if (!(end <= resStart || start >= resEnd)) {
                    isAvailable = false;
                    break;
                }
            }
        }
        if (isAvailable) {
            availableTables.push(table);
        }
    }
    return availableTables;
};
// Protected endpoints
app.post('/reservations', authenticate, (req, res) => {
    const { restaurant_id, table_id, starts_at_local, party_size } = req.body;
    const userId = req.user.id;
    // Validate required fields
    if (!restaurant_id || !table_id || !starts_at_local || party_size === undefined) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Missing required fields'
            }
        });
    }
    // Validate time format
    if (!validateTimeFormat(starts_at_local)) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Invalid time format'
            }
        });
    }
    // Validate party size
    if (typeof party_size !== 'number' || party_size < 1 || !Number.isInteger(party_size)) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Invalid party size'
            }
        });
    }
    // Validate idempotency key
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey) {
        return res.status(400).json({
            error: {
                code: 'missing_idempotency_key',
                message: 'Idempotency key is required'
            }
        });
    }
    // Check if key already used
    const keyEntry = state.idempotencyKeys[`${userId}:${idempotencyKey}`];
    if (keyEntry) {
        // If same body, return the cached response
        if (JSON.stringify(req.body) === keyEntry.body) {
            return res.status(200).json(keyEntry.response);
        }
        else {
            return res.status(409).json({
                error: {
                    code: 'idempotency_key_reuse',
                    message: 'Idempotency key already used with different request body'
                }
            });
        }
    }
    // Get restaurant
    const restaurant = getRestaurantById(restaurant_id);
    if (!restaurant) {
        return res.status(404).json({
            error: {
                code: 'not_found',
                message: 'Restaurant not found'
            }
        });
    }
    // Get table
    const table = restaurant.tables.find(t => t.id === table_id);
    if (!table) {
        return res.status(404).json({
            error: {
                code: 'not_found',
                message: 'Table not found'
            }
        });
    }
    // Validate party size vs table capacity
    if (party_size > table.capacity) {
        return res.status(422).json({
            error: {
                code: 'party_exceeds_capacity',
                message: 'Party size exceeds table capacity'
            }
        });
    }
    // Parse start time
    const startsAt = DateTime.fromISO(starts_at_local, { zone: restaurant.timezone });
    if (!startsAt.isValid) {
        return res.status(422).json({
            error: {
                code: 'invalid_local_time',
                message: 'Invalid local time'
            }
        });
    }
    // Check if start time is on slot grid
    const startMinutes = startsAt.hour * 60 + startsAt.minute;
    if (startMinutes % restaurant.slot_minutes !== 0) {
        return res.status(422).json({
            error: {
                code: 'not_on_slot_grid',
                message: 'Start time is not on slot grid'
            }
        });
    }
    // Check if reservation would be within opening hours
    const weekday = startsAt.toISOWeekday() === 7 ? 'sun' : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][startsAt.toISOWeekday() - 1];
    const openingHour = restaurant.opening_hours.find(h => h.weekday === weekday);
    if (!openingHour) {
        return res.status(422).json({
            error: {
                code: 'outside_opening_hours',
                message: 'Reservation outside opening hours'
            }
        });
    }
    const [openHour, openMinute] = openingHour.opens.split(':').map(Number);
    const [closeHour, closeMinute] = openingHour.closes.split(':').map(Number);
    const opensAt = DateTime.fromObject({
        year: startsAt.year,
        month: startsAt.month,
        day: startsAt.day,
        hour: openHour,
        minute: openMinute,
        zone: restaurant.timezone
    });
    const closesAt = DateTime.fromObject({
        year: startsAt.year,
        month: startsAt.month,
        day: startsAt.day,
        hour: closeHour,
        minute: closeMinute,
        zone: restaurant.timezone
    });
    if (startsAt < opensAt || startsAt >= closesAt) {
        return res.status(422).json({
            error: {
                code: 'outside_opening_hours',
                message: 'Reservation outside opening hours'
            }
        });
    }
    // Check if reservation would end after closing
    const endsAt = startsAt.plus({ minutes: restaurant.reservation_duration_minutes });
    if (endsAt > closesAt) {
        return res.status(422).json({
            error: {
                code: 'outside_opening_hours',
                message: 'Reservation would end after closing'
            }
        });
    }
    // Check for overlapping reservations
    const reservationConflict = Object.values(state.reservations).find(res => {
        if (res.table_id !== table_id || res.status !== 'confirmed')
            return false;
        const resStart = DateTime.fromISO(res.starts_at);
        const resEnd = DateTime.fromISO(res.ends_at);
        // Check for overlap
        return !(endsAt <= resStart || startsAt >= resEnd);
    });
    if (reservationConflict) {
        return res.status(409).json({
            error: {
                code: 'table_unavailable',
                message: 'Table is not available at the requested time'
            }
        });
    }
    // Create reservation
    const reservationId = `res_${uuidv4().substring(0, 12)}`;
    const reference = generateReference();
    const reservation = {
        id: reservationId,
        reference,
        user_id: userId,
        restaurant_id,
        table_id,
        starts_at_local,
        starts_at: startsAt.toISO({ suppressMilliseconds: true }),
        ends_at: endsAt.toISO({ suppressMilliseconds: true }),
        party_size,
        status: 'confirmed',
        created_at: DateTime.now().toISO({ suppressMilliseconds: true, includeOffset: true })
    };
    // Store reservation
    state.reservations[reservationId] = reservation;
    // Cache idempotency key
    state.idempotencyKeys[`${userId}:${idempotencyKey}`] = {
        userId,
        body: JSON.stringify(req.body),
        response: reservation
    };
    res.status(201).json(reservation);
});
app.get('/reservations', authenticate, (req, res) => {
    const userId = req.user.id;
    const userReservations = getReservationsByUserId(userId);
    // Sort by starts_at descending
    userReservations.sort((a, b) => {
        return new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime();
    });
    res.status(200).json({ reservations: userReservations });
});
app.get('/reservations/:reference', authenticate, (req, res) => {
    const reference = req.params.reference;
    const userId = req.user.id;
    const reservation = getReservationByReference(reference);
    if (!reservation) {
        return res.status(404).json({
            error: {
                code: 'not_found',
                message: 'Reservation not found'
            }
        });
    }
    // Check ownership
    if (reservation.user_id !== userId) {
        return res.status(404).json({
            error: {
                code: 'not_found',
                message: 'Reservation not found'
            }
        });
    }
    res.status(200).json(reservation);
});
app.post('/reservations/:reference/cancel', authenticate, (req, res) => {
    const reference = req.params.reference;
    const userId = req.user.id;
    const reservation = getReservationByReference(reference);
    if (!reservation) {
        return res.status(404).json({
            error: {
                code: 'not_found',
                message: 'Reservation not found'
            }
        });
    }
    // Check ownership
    if (reservation.user_id !== userId) {
        return res.status(404).json({
            error: {
                code: 'not_found',
                message: 'Reservation not found'
            }
        });
    }
    // Check if already cancelled
    if (reservation.status === 'cancelled') {
        return res.status(200).json(reservation);
    }
    // Check cancellation cutoff
    const restaurant = getRestaurantById(reservation.restaurant_id);
    if (!restaurant) {
        return res.status(404).json({
            error: {
                code: 'not_found',
                message: 'Restaurant not found'
            }
        });
    }
    const startsAt = DateTime.fromISO(reservation.starts_at);
    const now = DateTime.now();
    const timeUntilStart = startsAt.diff(now, 'minutes').minutes;
    if (timeUntilStart <= restaurant.cancellation_cutoff_minutes) {
        return res.status(409).json({
            error: {
                code: 'cutoff_passed',
                message: 'Cancellation deadline passed'
            }
        });
    }
    // Cancel reservation
    reservation.status = 'cancelled';
    res.status(200).json(reservation);
});
app.patch('/reservations/:reference', authenticate, (req, res) => {
    const reference = req.params.reference;
    const userId = req.user.id;
    const { table_id, starts_at_local, party_size } = req.body;
    const reservation = getReservationByReference(reference);
    if (!reservation) {
        return res.status(404).json({
            error: {
                code: 'not_found',
                message: 'Reservation not found'
            }
        });
    }
    // Check ownership
    if (reservation.user_id !== userId) {
        return res.status(404).json({
            error: {
                code: 'not_found',
                message: 'Reservation not found'
            }
        });
    }
    // Check if cancelled
    if (reservation.status === 'cancelled') {
        return res.status(409).json({
            error: {
                code: 'reservation_cancelled',
                message: 'Cannot amend a cancelled reservation'
            }
        });
    }
    // Validate inputs if provided
    if (party_size !== undefined && (typeof party_size !== 'number' || party_size < 1 || !Number.isInteger(party_size))) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Invalid party size'
            }
        });
    }
    // Get restaurant
    const restaurant = getRestaurantById(reservation.restaurant_id);
    if (!restaurant) {
        return res.status(404).json({
            error: {
                code: 'not_found',
                message: 'Restaurant not found'
            }
        });
    }
    // Apply changes if provided
    let updatedReservation = { ...reservation };
    let changesMade = false;
    if (table_id !== undefined) {
        updatedReservation.table_id = table_id;
        changesMade = true;
    }
    if (starts_at_local !== undefined) {
        // Validate time format
        if (!validateTimeFormat(starts_at_local)) {
            return res.status(422).json({
                error: {
                    code: 'validation_failed',
                    message: 'Invalid time format'
                }
            });
        }
        updatedReservation.starts_at_local = starts_at_local;
        changesMade = true;
    }
    if (party_size !== undefined) {
        updatedReservation.party_size = party_size;
        changesMade = true;
    }
    if (!changesMade) {
        // No changes made, return current reservation
        return res.status(200).json(reservation);
    }
    // Validate changes
    const newStartsAt = starts_at_local ? DateTime.fromISO(starts_at_local, { zone: restaurant.timezone }) : DateTime.fromISO(reservation.starts_at);
    const newPartySize = party_size !== undefined ? party_size : reservation.party_size;
    const newTableId = table_id !== undefined ? table_id : reservation.table_id;
    // Validate party size vs table capacity
    const table = restaurant.tables.find(t => t.id === newTableId);
    if (table && newPartySize > table.capacity) {
        return res.status(422).json({
            error: {
                code: 'party_exceeds_capacity',
                message: 'Party size exceeds table capacity'
            }
        });
    }
    // Check if start time is on slot grid
    if (starts_at_local) {
        const startMinutes = newStartsAt.hour * 60 + newStartsAt.minute;
        if (startMinutes % restaurant.slot_minutes !== 0) {
            return res.status(422).json({
                error: {
                    code: 'not_on_slot_grid',
                    message: 'Start time is not on slot grid'
                }
            });
        }
    }
    // Check if reservation would be within opening hours
    if (starts_at_local) {
        const weekday = newStartsAt.toISOWeekday() === 7 ? 'sun' : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][newStartsAt.toISOWeekday() - 1];
        const openingHour = restaurant.opening_hours.find(h => h.weekday === weekday);
        if (!openingHour) {
            return res.status(422).json({
                error: {
                    code: 'outside_opening_hours',
                    message: 'Reservation outside opening hours'
                }
            });
        }
        const [openHour, openMinute] = openingHour.opens.split(':').map(Number);
        const [closeHour, closeMinute] = openingHour.closes.split(':').map(Number);
        const opensAt = DateTime.fromObject({
            year: newStartsAt.year,
            month: newStartsAt.month,
            day: newStartsAt.day,
            hour: openHour,
            minute: openMinute,
            zone: restaurant.timezone
        });
        const closesAt = DateTime.fromObject({
            year: newStartsAt.year,
            month: newStartsAt.month,
            day: newStartsAt.day,
            hour: closeHour,
            minute: closeMinute,
            zone: restaurant.timezone
        });
        if (newStartsAt < opensAt || newStartsAt >= closesAt) {
            return res.status(422).json({
                error: {
                    code: 'outside_opening_hours',
                    message: 'Reservation outside opening hours'
                }
            });
        }
        // Check if reservation would end after closing
        const endsAt = newStartsAt.plus({ minutes: restaurant.reservation_duration_minutes });
        if (endsAt > closesAt) {
            return res.status(422).json({
                error: {
                    code: 'outside_opening_hours',
                    message: 'Reservation would end after closing'
                }
            });
        }
    }
    // Check for overlapping reservations
    const reservationConflict = Object.values(state.reservations).find(res => {
        if (res.id === reservation.id || res.table_id !== newTableId || res.status !== 'confirmed')
            return false;
        const resStart = DateTime.fromISO(res.starts_at);
        const resEnd = DateTime.fromISO(res.ends_at);
        // Check for overlap
        return !(endsAt <= resStart || newStartsAt >= resEnd);
    });
    if (reservationConflict) {
        return res.status(409).json({
            error: {
                code: 'table_unavailable',
                message: 'Table is not available at the requested time'
            }
        });
    }
    // Update reservation
    updatedReservation.starts_at_local = starts_at_local || reservation.starts_at_local;
    updatedReservation.party_size = party_size !== undefined ? party_size : reservation.party_size;
    updatedReservation.table_id = table_id !== undefined ? table_id : reservation.table_id;
    // Update times based on new start time
    if (starts_at_local) {
        const updatedStartsAt = DateTime.fromISO(updatedReservation.starts_at_local, { zone: restaurant.timezone });
        const updatedEndsAt = updatedStartsAt.plus({ minutes: restaurant.reservation_duration_minutes });
        updatedReservation.starts_at = updatedStartsAt.toISO({ suppressMilliseconds: true });
        updatedReservation.ends_at = updatedEndsAt.toISO({ suppressMilliseconds: true });
    }
    state.reservations[reservation.id] = updatedReservation;
    res.status(200).json(updatedReservation);
});
// Add error handler
app.use(errorHandler);
// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Tablekeeper service running on port ${PORT}`);
});
//# sourceMappingURL=index.js.map