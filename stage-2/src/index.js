#!/usr/bin/env node
"use strict";
// Tablekeeper Stage 1 Implementation
// This is a Node.js/TypeScript implementation following the spec
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const uuid_1 = require("uuid");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const luxon_1 = require("luxon");
const fs = __importStar(require("fs"));
const path_1 = __importDefault(require("path"));
// In-memory storage (in production, this would be a database)
let state = {
    users: {},
    restaurants: {},
    reservations: {},
    idempotencyKeys: {},
    exportState: null,
    tokens: {}
};
const app = (0, express_1.default)();
app.use(express_1.default.json());
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
// Serialize reservation object to consistent format
const serializeReservation = (reservation) => {
    const tableIds = reservation.table_ids && reservation.table_ids.length > 0
        ? reservation.table_ids
        : [reservation.table_id];
    const out = {
        reservation_id: reservation.id,
        reference: reservation.reference,
        user_id: reservation.user_id,
        restaurant_id: reservation.restaurant_id,
        table_ids: tableIds,
        starts_at_local: reservation.starts_at_local,
        starts_at: reservation.starts_at,
        ends_at: reservation.ends_at,
        party_size: reservation.party_size,
        status: reservation.status,
        created_at: reservation.created_at
    };
    if (tableIds.length === 1) {
        out.table_id = tableIds[0];
    }
    return out;
};
// Check whether a reservation occupies a given table at the given interval
const reservationOccupiesTable = (reservation, tableId, start, end) => {
    const ids = reservation.table_ids && reservation.table_ids.length > 0
        ? reservation.table_ids
        : [reservation.table_id];
    if (!ids.includes(tableId))
        return false;
    const resStart = luxon_1.DateTime.fromISO(reservation.starts_at);
    const resEnd = luxon_1.DateTime.fromISO(reservation.ends_at);
    return !(end <= resStart || start >= resEnd);
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
    const token = authHeader.substring(7);
    // Check if token exists in our token map
    const userId = state.tokens[token];
    if (!userId) {
        return res.status(401).json({
            error: {
                code: 'unauthenticated',
                message: 'Invalid token'
            }
        });
    }
    // Set user in request
    req.user = { id: userId };
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
// Express error handling middleware for JSON parsing errors
const jsonErrorHandler = (err, req, res, next) => {
    if (err && err.name === 'SyntaxError') {
        return res.status(400).json({
            error: {
                code: 'malformed_request',
                message: 'Malformed JSON request'
            }
        });
    }
    next(err);
};
// Routes
// Serve HTML pages
const PUB = path_1.default.join(__dirname, '..', 'public');
const page = (f) => (_req, res) => {
    const p = path_1.default.join(PUB, f);
    if (!fs.existsSync(p))
        return res.status(404).send('not found');
    res.type('html').send(fs.readFileSync(p, 'utf8'));
};
app.get('/', page('index.html'));
app.get('/login', page('login.html'));
app.get('/signup', page('signup.html'));
app.get('/lookup', page('lookup.html'));
// Health endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});
// Reset endpoint
app.post('/_test/reset', (req, res) => {
    const fixture = req.body;
    // Validate fixture structure
    if (!fixture || typeof fixture !== 'object') {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Invalid fixture data'
            }
        });
    }
    // Validate users array
    if (!Array.isArray(fixture.users)) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Invalid users array in fixture'
            }
        });
    }
    // Validate restaurants array
    if (!Array.isArray(fixture.restaurants)) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Invalid restaurants array in fixture'
            }
        });
    }
    // Validate reservations array
    if (!Array.isArray(fixture.reservations)) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Invalid reservations array in fixture'
            }
        });
    }
    // Validate all fixture IDs and references BEFORE clearing state
    // Validate users
    for (const user of fixture.users) {
        if (!user || typeof user !== 'object' || !user.id) {
            return res.status(422).json({
                error: {
                    code: 'validation_failed',
                    message: 'Invalid user in fixture'
                }
            });
        }
        // Validate user ID length (1-64 characters)
        if (typeof user.id !== 'string' || user.id.length < 1 || user.id.length > 64) {
            return res.status(422).json({
                error: {
                    code: 'validation_failed',
                    message: 'Invalid user ID length in fixture'
                }
            });
        }
    }
    // Validate restaurants
    for (const restaurant of fixture.restaurants) {
        if (!restaurant || typeof restaurant !== 'object' || !restaurant.id) {
            return res.status(422).json({
                error: {
                    code: 'validation_failed',
                    message: 'Invalid restaurant in fixture'
                }
            });
        }
        // Validate restaurant ID length (1-64 characters)
        if (typeof restaurant.id !== 'string' || restaurant.id.length < 1 || restaurant.id.length > 64) {
            return res.status(422).json({
                error: {
                    code: 'validation_failed',
                    message: 'Invalid restaurant ID length in fixture'
                }
            });
        }
    }
    // Validate tables (if they exist)
    for (const restaurant of fixture.restaurants) {
        if (restaurant && Array.isArray(restaurant.tables)) {
            for (const table of restaurant.tables) {
                if (!table || typeof table !== 'object' || !table.id) {
                    return res.status(422).json({
                        error: {
                            code: 'validation_failed',
                            message: 'Invalid table in fixture'
                        }
                    });
                }
                // Validate table ID length (1-64 characters)
                if (typeof table.id !== 'string' || table.id.length < 1 || table.id.length > 64) {
                    return res.status(422).json({
                        error: {
                            code: 'validation_failed',
                            message: 'Invalid table ID length in fixture'
                        }
                    });
                }
            }
        }
    }
    // Validate reservations
    for (const reservation of fixture.reservations) {
        if (!reservation || typeof reservation !== 'object' || !reservation.id) {
            return res.status(422).json({
                error: {
                    code: 'validation_failed',
                    message: 'Invalid reservation in fixture'
                }
            });
        }
        // Validate reservation ID length (1-64 characters)
        if (typeof reservation.id !== 'string' || reservation.id.length < 1 || reservation.id.length > 64) {
            return res.status(422).json({
                error: {
                    code: 'validation_failed',
                    message: 'Invalid reservation ID length in fixture'
                }
            });
        }
        // Validate reservation reference format
        if (typeof reservation.reference !== 'string' ||
            !/^[A-Z0-9]{6,12}$/.test(reservation.reference)) {
            return res.status(422).json({
                error: {
                    code: 'validation_failed',
                    message: 'Invalid reservation reference format in fixture'
                }
            });
        }
    }
    // Save tokens to preserve them across reset
    const savedTokens = state.tokens;
    // Clear current state only after validation passes
    state = {
        users: {},
        restaurants: {},
        reservations: {},
        idempotencyKeys: {},
        exportState: null,
        tokens: savedTokens // Preserve issued tokens
    };
    // Load fixture data
    fixture.users.forEach(user => {
        // Hash password if it exists (for seeded users)
        if (user.password) {
            const hashedPassword = bcryptjs_1.default.hashSync(user.password, 10);
            // Create a new user object with hashed password
            const userWithHash = Object.assign(Object.assign({}, user), { password_hash: hashedPassword });
            // Remove password field from the object
            delete userWithHash.password;
            state.users[user.id] = userWithHash;
        }
        else {
            state.users[user.id] = user;
        }
    });
    fixture.restaurants.forEach(restaurant => {
        state.restaurants[restaurant.id] = restaurant;
    });
    fixture.reservations.forEach(reservation => {
        // Apply the same normalization that happens during creation
        // For seeded reservations, we need to compute starts_at/ends_at from starts_at_local
        let normalizedReservation = Object.assign({}, reservation);
        // Ensure reservation has required fields with defaults
        normalizedReservation.status = reservation.status || 'confirmed';
        // If starts_at_local is provided, compute the absolute instants
        if (reservation.starts_at_local) {
            // Find the restaurant to get timezone info
            const restaurant = getRestaurantById(reservation.restaurant_id);
            if (restaurant) {
                // Parse the local time and convert to absolute instants
                const startsAt = luxon_1.DateTime.fromISO(reservation.starts_at_local, { zone: restaurant.timezone });
                if (startsAt.isValid) {
                    // Compute ends_at based on reservation duration
                    const endsAt = startsAt.plus({ minutes: restaurant.reservation_duration_minutes });
                    normalizedReservation.starts_at = startsAt.toISO({ suppressMilliseconds: true }) || '';
                    normalizedReservation.ends_at = endsAt.toISO({ suppressMilliseconds: true }) || '';
                }
                else {
                    // If invalid time, set empty strings
                    normalizedReservation.starts_at = '';
                    normalizedReservation.ends_at = '';
                }
            }
            else {
                // If no restaurant found, set empty strings
                normalizedReservation.starts_at = '';
                normalizedReservation.ends_at = '';
            }
        }
        else {
            // If no starts_at_local, set empty strings
            normalizedReservation.starts_at = '';
            normalizedReservation.ends_at = '';
        }
        state.reservations[normalizedReservation.id] = normalizedReservation;
    });
    res.status(204).send();
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
            exportState: state.exportState,
            tokens: state.tokens
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
    // Replace state (import restores the exported state, including tokens)
    state.users = importedState.users || {};
    state.restaurants = importedState.restaurants || {};
    state.reservations = importedState.reservations || {};
    state.idempotencyKeys = importedState.idempotencyKeys || {};
    state.exportState = importedState.exportState || null;
    state.tokens = importedState.tokens || {};
    res.status(204).send();
});
// Authentication endpoints
app.post('/auth/signup', (req, res) => {
    const { email, password, display_name } = req.body;
    // Validate inputs - type-check before value-check
    if (typeof email !== 'string') {
        return res.status(400).json({
            error: {
                code: 'malformed_request',
                message: 'Email must be a string'
            }
        });
    }
    if (typeof password !== 'string') {
        return res.status(400).json({
            error: {
                code: 'malformed_request',
                message: 'Password must be a string'
            }
        });
    }
    if (typeof display_name !== 'string') {
        return res.status(400).json({
            error: {
                code: 'malformed_request',
                message: 'Display name must be a string'
            }
        });
    }
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
    // Check if email already exists (search through all users)
    const existingUser = Object.values(state.users).find(user => user.email === email);
    if (existingUser) {
        return res.status(409).json({
            error: {
                code: 'email_taken',
                message: 'Email already registered'
            }
        });
    }
    // Hash password
    const saltRounds = 10;
    bcryptjs_1.default.hash(password, saltRounds, (err, hash) => {
        if (err) {
            return res.status(500).json({
                error: {
                    code: 'internal_error',
                    message: 'Failed to hash password'
                }
            });
        }
        const userId = `u_${(0, uuid_1.v4)().substring(0, 12)}`;
        const newUser = {
            id: userId,
            email,
            password_hash: hash,
            display_name
        };
        state.users[userId] = newUser;
        // Generate a real token for the user
        const token = `token_${(0, uuid_1.v4)().substring(0, 16)}`;
        state.tokens[token] = userId;
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
    bcryptjs_1.default.compare(password, user.password_hash, (err, result) => {
        if (err || !result) {
            return res.status(401).json({
                error: {
                    code: 'unauthenticated',
                    message: 'Invalid email or password'
                }
            });
        }
        // Generate a real token for the user
        const token = `token_${(0, uuid_1.v4)().substring(0, 16)}`;
        state.tokens[token] = user.id;
        res.status(200).json({
            user_id: user.id,
            display_name: user.display_name,
            token
        });
    });
});
// Validate auth endpoint
app.get('/auth/validate', (req, res) => {
    const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const uid = state.tokens[tok];
    const user = uid && state.users[uid];
    if (!user)
        return res.status(401).json({ error: { code: 'unauthenticated', message: 'Invalid token' } });
    res.status(200).json({ user_id: user.id, display_name: user.display_name });
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
    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Invalid date format. Expected YYYY-MM-DD'
            }
        });
    }
    // Validate actual calendar date components
    const [yearStr, monthStr, dayStr] = date.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const day = parseInt(dayStr, 10);
    // Check if month and day are in valid ranges
    if (month < 1 || month > 12 || day < 1 || day > 31) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Invalid date components'
            }
        });
    }
    // Create a date object to check if it's a valid calendar date
    const testDate = new Date(year, month - 1, day);
    if (testDate.getFullYear() !== year ||
        testDate.getMonth() !== month - 1 ||
        testDate.getDate() !== day) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Invalid date'
            }
        });
    }
    // Validate party size
    const partySizeStr = party_size;
    // Check raw string format first - must be digits only
    if (!/^[0-9]+$/.test(partySizeStr)) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Invalid party size. Must be a positive integer'
            }
        });
    }
    const partySize = parseInt(partySizeStr, 10);
    if (isNaN(partySize) || partySize < 1 || partySize > 20) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Invalid party size. Must be between 1 and 20'
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
    const targetDate = luxon_1.DateTime.fromISO(dateStr, { zone: 'UTC' });
    if (!targetDate.isValid) {
        return [];
    }
    // Find opening hours for this day
    const weekday = targetDate.weekday === 7 ? 'sun' : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][targetDate.weekday - 1];
    const openingHour = restaurant.opening_hours.find(h => h.weekday === weekday);
    if (!openingHour) {
        return [];
    }
    const slots = [];
    // Parse opening and closing times
    const [openHour, openMinute] = openingHour.opens.split(':').map(Number);
    const [closeHour, closeMinute] = openingHour.closes.split(':').map(Number);
    // Create slots
    let slotStart = luxon_1.DateTime.fromObject({
        year: targetDate.year,
        month: targetDate.month,
        day: targetDate.day,
        hour: openHour,
        minute: openMinute
    }, { zone: restaurant.timezone });
    const slotEnd = luxon_1.DateTime.fromObject({
        year: targetDate.year,
        month: targetDate.month,
        day: targetDate.day,
        hour: closeHour,
        minute: closeMinute
    }, { zone: restaurant.timezone });
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
        // Build available_options: singles first (fixture order), then declared pairs
        const availableOptions = [];
        for (const table of restaurant.tables) {
            if (table.capacity >= partySize && availableTables.some(t => t.id === table.id)) {
                availableOptions.push({ table_ids: [table.id], capacity: table.capacity });
            }
        }
        if (Array.isArray(restaurant.combinable)) {
            for (const pair of restaurant.combinable) {
                if (!Array.isArray(pair) || pair.length !== 2)
                    continue;
                const [a, b] = pair;
                const tableA = restaurant.tables.find(t => t.id === a);
                const tableB = restaurant.tables.find(t => t.id === b);
                if (!tableA || !tableB)
                    continue;
                const capacity = tableA.capacity + tableB.capacity;
                if (capacity < partySize)
                    continue;
                // Check both tables are free (no overlapping confirmed reservation on either)
                const aFree = !Object.values(state.reservations).some(res => res.status === 'confirmed' && reservationOccupiesTable(res, a, slotStart, slotEndDateTime));
                const bFree = !Object.values(state.reservations).some(res => res.status === 'confirmed' && reservationOccupiesTable(res, b, slotStart, slotEndDateTime));
                if (aFree && bFree) {
                    availableOptions.push({ table_ids: [a, b], capacity });
                }
            }
        }
        slots.push({
            starts_at_local: slotStart.toFormat('yyyy-MM-dd\'T\'HH:mm'), // YYYY-MM-DDTHH:MM format
            starts_at: slotStart.toISO({ suppressMilliseconds: true }),
            available_table_ids: availableTables.map(t => t.id),
            available_options: availableOptions
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
            if (reservation.status === 'confirmed' && reservationOccupiesTable(reservation, table.id, start, end)) {
                isAvailable = false;
                break;
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
    const { restaurant_id, table_id, table_ids, starts_at_local, party_size } = req.body;
    const userId = req.user.id;
    // Validate required fields
    if (!restaurant_id || !starts_at_local || party_size === undefined) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Missing required fields'
            }
        });
    }
    // Resolve the table set: table_ids (1 or 2) or legacy table_id
    let tableSet;
    if (table_ids !== undefined && table_id !== undefined) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Send either table_id or table_ids, not both'
            }
        });
    }
    if (table_ids !== undefined) {
        if (!Array.isArray(table_ids) || table_ids.length < 1 || table_ids.length > 2 ||
            table_ids.some(id => typeof id !== 'string')) {
            return res.status(422).json({
                error: {
                    code: 'combination_not_allowed',
                    message: 'table_ids must be one or two table ids'
                }
            });
        }
        if (new Set(table_ids).size !== table_ids.length) {
            return res.status(422).json({
                error: {
                    code: 'validation_failed',
                    message: 'Duplicate table id in set'
                }
            });
        }
        tableSet = table_ids;
    }
    else if (typeof table_id === 'string' && table_id) {
        tableSet = [table_id];
    }
    else {
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
        // For exact byte matching, we need to be very careful about JSON serialization
        // Use the exact same serialization method that was used when caching
        try {
            // We store the body as JSON string, so we compare with the same approach
            // The key issue is that when we store it, we use JSON.stringify(req.body)
            // But when we compare, we should make sure we're comparing the same way
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
        catch (e) {
            // If parsing fails, treat as different body
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
    // Get tables
    const tables = tableSet.map(id => restaurant.tables.find(t => t.id === id));
    if (tables.some(t => !t)) {
        return res.status(404).json({
            error: {
                code: 'not_found',
                message: 'Table not found'
            }
        });
    }
    // Validate combination: a pair must be declared combinable (unordered)
    if (tableSet.length === 2) {
        const [a, b] = tableSet;
        const declared = Array.isArray(restaurant.combinable) &&
            restaurant.combinable.some(pair => Array.isArray(pair) && pair.length === 2 &&
                ((pair[0] === a && pair[1] === b) || (pair[0] === b && pair[1] === a)));
        if (!declared) {
            return res.status(422).json({
                error: {
                    code: 'combination_not_allowed',
                    message: 'This pair of tables cannot be combined'
                }
            });
        }
    }
    // Validate party size vs combined capacity
    const combinedCapacity = tables.reduce((sum, t) => sum + t.capacity, 0);
    if (party_size > combinedCapacity) {
        return res.status(422).json({
            error: {
                code: 'party_exceeds_capacity',
                message: 'Party size exceeds table capacity'
            }
        });
    }
    // Parse start time
    const startsAt = luxon_1.DateTime.fromISO(starts_at_local, { zone: restaurant.timezone });
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
    const weekday = startsAt.weekday === 7 ? 'sun' : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][startsAt.weekday - 1];
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
    const opensAt = luxon_1.DateTime.fromObject({
        year: startsAt.year,
        month: startsAt.month,
        day: startsAt.day,
        hour: openHour,
        minute: openMinute
    }, { zone: restaurant.timezone });
    const closesAt = luxon_1.DateTime.fromObject({
        year: startsAt.year,
        month: startsAt.month,
        day: startsAt.day,
        hour: closeHour,
        minute: closeMinute
    }, { zone: restaurant.timezone });
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
    // Check for overlapping reservations on any table in the set
    const reservationConflict = Object.values(state.reservations).find(res => {
        if (res.status !== 'confirmed')
            return false;
        return tableSet.some(tableId => reservationOccupiesTable(res, tableId, startsAt, endsAt));
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
    const reservationId = `res_${(0, uuid_1.v4)().replace(/-/g, '').substring(0, 12)}`;
    const reference = generateReference();
    const reservation = {
        id: reservationId,
        reference,
        user_id: userId,
        restaurant_id,
        table_id: tableSet[0],
        table_ids: tableSet,
        starts_at_local,
        starts_at: startsAt.toISO({ suppressMilliseconds: true }),
        ends_at: endsAt.toISO({ suppressMilliseconds: true }),
        party_size,
        status: 'confirmed',
        created_at: luxon_1.DateTime.now().toISO({ suppressMilliseconds: true, includeOffset: true })
    };
    // Store reservation
    state.reservations[reservationId] = reservation;
    // Prepare the exact response that will be sent
    const responseToSend = serializeReservation(reservation);
    // Cache idempotency key with the exact response
    state.idempotencyKeys[`${userId}:${idempotencyKey}`] = {
        userId,
        body: JSON.stringify(req.body),
        response: responseToSend
    };
    res.status(201).json(serializeReservation(reservation));
});
app.get('/reservations', authenticate, (req, res) => {
    const userId = req.user.id;
    const userReservations = getReservationsByUserId(userId);
    // Sort by starts_at descending
    userReservations.sort((a, b) => {
        return new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime();
    });
    // Convert to the correct response format
    const formattedReservations = userReservations.map(r => serializeReservation(r));
    res.status(200).json({ reservations: formattedReservations });
});
app.get('/reservations/:reference', authenticate, (req, res) => {
    const reference = req.params.reference;
    const userId = req.user.id;
    const reservation = getReservationByReference(reference || '');
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
    // Convert to correct response format
    res.status(200).json(serializeReservation(reservation));
});
app.post('/reservations/:reference/cancel', authenticate, (req, res) => {
    const reference = req.params.reference;
    const userId = req.user.id;
    const reservation = getReservationByReference(reference || '');
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
    const startsAt = luxon_1.DateTime.fromISO(reservation.starts_at);
    const now = luxon_1.DateTime.now();
    const timeUntilStart = startsAt.diff(now, 'minutes').minutes;
    // Check if cancellation is within cutoff period
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
    res.status(200).json(serializeReservation(reservation));
});
app.patch('/reservations/:reference', authenticate, (req, res) => {
    const reference = req.params.reference;
    const userId = req.user.id;
    const { table_id, table_ids, starts_at_local, party_size } = req.body;
    const reservation = getReservationByReference(reference || '');
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
    if (table_ids !== undefined && table_id !== undefined) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Send either table_id or table_ids, not both'
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
    let updatedReservation = Object.assign({}, reservation);
    let changesMade = false;
    if (table_ids !== undefined) {
        if (!Array.isArray(table_ids) || table_ids.length < 1 || table_ids.length > 2 ||
            table_ids.some(id => typeof id !== 'string')) {
            return res.status(422).json({
                error: {
                    code: 'combination_not_allowed',
                    message: 'table_ids must be one or two table ids'
                }
            });
        }
        if (new Set(table_ids).size !== table_ids.length) {
            return res.status(422).json({
                error: {
                    code: 'validation_failed',
                    message: 'Duplicate table id in set'
                }
            });
        }
        const tables = table_ids.map(id => restaurant.tables.find(t => t.id === id));
        if (tables.some(t => !t)) {
            return res.status(404).json({
                error: {
                    code: 'not_found',
                    message: 'Table not found'
                }
            });
        }
        if (table_ids.length === 2) {
            const [a, b] = table_ids;
            const declared = Array.isArray(restaurant.combinable) &&
                restaurant.combinable.some(pair => Array.isArray(pair) && pair.length === 2 &&
                    ((pair[0] === a && pair[1] === b) || (pair[0] === b && pair[1] === a)));
            if (!declared) {
                return res.status(422).json({
                    error: {
                        code: 'combination_not_allowed',
                        message: 'This pair of tables cannot be combined'
                    }
                });
            }
        }
        updatedReservation.table_id = table_ids[0];
        updatedReservation.table_ids = table_ids;
        changesMade = true;
    }
    else if (table_id !== undefined) {
        // Validate table exists in the restaurant
        const table = restaurant.tables.find(t => t.id === table_id);
        if (!table) {
            return res.status(404).json({
                error: {
                    code: 'not_found',
                    message: 'Table not found'
                }
            });
        }
        updatedReservation.table_id = table_id;
        updatedReservation.table_ids = [table_id];
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
        // Use the same response format as create endpoint
        return res.status(200).json(serializeReservation(reservation));
    }
    // Validate changes
    const newStartsAt = starts_at_local ? luxon_1.DateTime.fromISO(starts_at_local, { zone: restaurant.timezone }) : luxon_1.DateTime.fromISO(reservation.starts_at);
    const newPartySize = party_size !== undefined ? party_size : reservation.party_size;
    const newTableSet = table_ids !== undefined
        ? table_ids
        : table_id !== undefined
            ? [table_id]
            : (reservation.table_ids && reservation.table_ids.length > 0 ? reservation.table_ids : [reservation.table_id]);
    // Validate party size vs combined capacity
    const newTables = newTableSet.map(id => restaurant.tables.find(t => t.id === id));
    if (newTables.every(t => t)) {
        const combinedCapacity = newTables.reduce((sum, t) => sum + t.capacity, 0);
        if (newPartySize > combinedCapacity) {
            return res.status(422).json({
                error: {
                    code: 'party_exceeds_capacity',
                    message: 'Party size exceeds table capacity'
                }
            });
        }
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
        const weekday = newStartsAt.weekday === 7 ? 'sun' : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][newStartsAt.weekday - 1];
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
        const opensAt = luxon_1.DateTime.fromObject({
            year: newStartsAt.year,
            month: newStartsAt.month,
            day: newStartsAt.day,
            hour: openHour,
            minute: openMinute
        }, { zone: restaurant.timezone });
        const closesAt = luxon_1.DateTime.fromObject({
            year: newStartsAt.year,
            month: newStartsAt.month,
            day: newStartsAt.day,
            hour: closeHour,
            minute: closeMinute
        }, { zone: restaurant.timezone });
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
    let updatedEndsAt;
    const reservationConflict = Object.values(state.reservations).find(res => {
        if (res.id === reservation.id || res.status !== 'confirmed')
            return false;
        // Calculate updated ends time for overlap check
        if (starts_at_local) {
            const updatedStartsAt = luxon_1.DateTime.fromISO(updatedReservation.starts_at_local, { zone: restaurant.timezone });
            updatedEndsAt = updatedStartsAt.plus({ minutes: restaurant.reservation_duration_minutes });
        }
        else {
            updatedEndsAt = luxon_1.DateTime.fromISO(reservation.ends_at);
        }
        // Check for overlap on any table in the new set
        return newTableSet.some(tableId => reservationOccupiesTable(res, tableId, newStartsAt, updatedEndsAt));
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
    updatedReservation.table_id = newTableSet[0];
    updatedReservation.table_ids = newTableSet;
    // Check cutoff for changes
    // Always check cutoff regardless of what's changed (rule applies to current start time)
    if (restaurant) {
        // Determine the start time to check against cutoff
        let startsAtToCheck;
        if (starts_at_local) {
            // If new start time is provided, use it
            startsAtToCheck = luxon_1.DateTime.fromISO(updatedReservation.starts_at_local, { zone: restaurant.timezone });
        }
        else {
            // If no new start time, use the existing start time
            startsAtToCheck = luxon_1.DateTime.fromISO(reservation.starts_at);
        }
        const now = luxon_1.DateTime.now();
        const timeUntilStart = startsAtToCheck.diff(now, 'minutes').minutes;
        // Check if change is within cutoff period
        if (timeUntilStart <= restaurant.cancellation_cutoff_minutes) {
            return res.status(409).json({
                error: {
                    code: 'cutoff_passed',
                    message: 'Change deadline passed'
                }
            });
        }
    }
    // Update times based on new start time
    if (starts_at_local) {
        const updatedStartsAt = luxon_1.DateTime.fromISO(updatedReservation.starts_at_local, { zone: restaurant.timezone });
        const updatedEndsAt = updatedStartsAt.plus({ minutes: restaurant.reservation_duration_minutes });
        updatedReservation.starts_at = updatedStartsAt.toISO({ suppressMilliseconds: true }) || '';
        updatedReservation.ends_at = updatedEndsAt.toISO({ suppressMilliseconds: true }) || '';
    }
    state.reservations[reservation.id] = updatedReservation;
    res.status(200).json(serializeReservation(updatedReservation));
});
// Reservation moves route
app.post('/reservation-moves', authenticate, (req, res) => {
    const { reference, table_id, table_ids, starts_at_local, party_size } = req.body;
    const userId = req.user.id;
    // Validate required fields (reference is required, others optional)
    if (!reference) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Missing required field: reference'
            }
        });
    }
    // Validate time format if provided
    if (starts_at_local && !validateTimeFormat(starts_at_local)) {
        return res.status(422).json({
            error: {
                code: 'validation_failed',
                message: 'Invalid time format'
            }
        });
    }
    // Get the reservation
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
    // Validate that the reservation is not already cancelled
    if (reservation.status === 'cancelled') {
        return res.status(409).json({
            error: {
                code: 'reservation_cancelled',
                message: 'Cannot move a cancelled reservation'
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
    // If starts_at_local is provided, validate and process the move
    if (starts_at_local) {
        // Parse start time
        const startsAt = luxon_1.DateTime.fromISO(starts_at_local, { zone: restaurant.timezone });
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
        const weekday = startsAt.weekday === 7 ? 'sun' : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][startsAt.weekday - 1];
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
        const opensAt = luxon_1.DateTime.fromObject({
            year: startsAt.year,
            month: startsAt.month,
            day: startsAt.day,
            hour: openHour,
            minute: openMinute
        }, { zone: restaurant.timezone });
        const closesAt = luxon_1.DateTime.fromObject({
            year: startsAt.year,
            month: startsAt.month,
            day: startsAt.day,
            hour: closeHour,
            minute: closeMinute
        }, { zone: restaurant.timezone });
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
        // Check for overlapping reservations on any table in the current set
        const currentTableSet = reservation.table_ids && reservation.table_ids.length > 0
            ? reservation.table_ids
            : [reservation.table_id];
        const reservationConflict = Object.values(state.reservations).find(res => {
            if (res.id === reservation.id || res.status !== 'confirmed')
                return false;
            return currentTableSet.some(tableId => reservationOccupiesTable(res, tableId, startsAt, endsAt));
        });
        if (reservationConflict) {
            return res.status(409).json({
                error: {
                    code: 'table_unavailable',
                    message: 'Table is not available at the requested time'
                }
            });
        }
        // Update reservation with new time
        const updatedReservation = Object.assign({}, reservation);
        updatedReservation.starts_at_local = starts_at_local;
        updatedReservation.starts_at = startsAt.toISO({ suppressMilliseconds: true }) || '';
        updatedReservation.ends_at = endsAt.toISO({ suppressMilliseconds: true }) || '';
        state.reservations[reservation.id] = updatedReservation;
        res.status(200).json(serializeReservation(updatedReservation));
    }
    else {
        // Only table(s) provided - validate and update table only
        let newTableSet = null;
        if (table_ids !== undefined) {
            if (!Array.isArray(table_ids) || table_ids.length < 1 || table_ids.length > 2 ||
                table_ids.some(id => typeof id !== 'string')) {
                return res.status(422).json({
                    error: {
                        code: 'combination_not_allowed',
                        message: 'table_ids must be one or two table ids'
                    }
                });
            }
            if (new Set(table_ids).size !== table_ids.length) {
                return res.status(422).json({
                    error: {
                        code: 'validation_failed',
                        message: 'Duplicate table id in set'
                    }
                });
            }
            const tables = table_ids.map(id => restaurant.tables.find(t => t.id === id));
            if (tables.some(t => !t)) {
                return res.status(422).json({
                    error: {
                        code: 'not_found',
                        message: 'Table not found'
                    }
                });
            }
            if (table_ids.length === 2) {
                const [a, b] = table_ids;
                const declared = Array.isArray(restaurant.combinable) &&
                    restaurant.combinable.some(pair => Array.isArray(pair) && pair.length === 2 &&
                        ((pair[0] === a && pair[1] === b) || (pair[0] === b && pair[1] === a)));
                if (!declared) {
                    return res.status(422).json({
                        error: {
                            code: 'combination_not_allowed',
                            message: 'This pair of tables cannot be combined'
                        }
                    });
                }
            }
            newTableSet = table_ids;
        }
        else if (table_id) {
            const tableExists = restaurant.tables.some(t => t.id === table_id);
            if (!tableExists) {
                return res.status(422).json({
                    error: {
                        code: 'not_found',
                        message: 'Table not found'
                    }
                });
            }
            newTableSet = [table_id];
        }
        if (newTableSet) {
            // Check if tables are available (no time conflict) using current reservation time
            const currentStart = luxon_1.DateTime.fromISO(reservation.starts_at);
            const currentEnd = luxon_1.DateTime.fromISO(reservation.ends_at);
            const reservationConflict = Object.values(state.reservations).find(res => {
                if (res.id === reservation.id || res.status !== 'confirmed')
                    return false;
                return newTableSet.some(tableId => reservationOccupiesTable(res, tableId, currentStart, currentEnd));
            });
            if (reservationConflict) {
                return res.status(409).json({
                    error: {
                        code: 'table_unavailable',
                        message: 'Table is not available at the requested time'
                    }
                });
            }
            // Update reservation with new table(s)
            const updatedReservation = Object.assign({}, reservation);
            updatedReservation.table_id = newTableSet[0];
            updatedReservation.table_ids = newTableSet;
            state.reservations[reservation.id] = updatedReservation;
            res.status(200).json(serializeReservation(updatedReservation));
        }
        else {
            // No changes requested
            return res.status(200).json(serializeReservation(reservation));
        }
    }
});
// Add error handlers
app.use(jsonErrorHandler);
app.use(errorHandler);
// Start server
const PORT = parseInt(process.env.PORT || '8080', 10);
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Tablekeeper service running on port ${PORT}`);
});
//# sourceMappingURL=index.js.map