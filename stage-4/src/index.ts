#!/usr/bin/env node

// Tablekeeper Stage 1 Implementation
// This is a Node.js/TypeScript implementation following the spec

import express, { type Request, type Response, type NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { DateTime, IANAZone } from 'luxon';
import * as fs from 'fs';
import path from 'path';

// Types and interfaces
interface User {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
}

interface Table {
  id: string;
  label: string;
  capacity: number;
}

interface OpeningHour {
  weekday: string;
  opens: string;
  closes: string;
}

interface Restaurant {
  id: string;
  name: string;
  timezone: string;
  slot_minutes: number;
  reservation_duration_minutes: number;
  cancellation_cutoff_minutes: number;
  opening_hours: OpeningHour[];
  tables: Table[];
  combinable?: [string, string][];
  manager_user_ids?: string[];
}

interface Policy {
  policy_version: number;
  effective_from: string;
  slot_minutes: number;
  reservation_duration_minutes: number;
  cancellation_cutoff_minutes: number;
  opening_hours: OpeningHour[];
  capacities: Record<string, number>;
}

interface AcceptedTerms {
  policy_version: number;
  slot_minutes: number;
  reservation_duration_minutes: number;
  cancellation_cutoff_minutes: number;
  opening_hours: OpeningHour[];
  capacities: Record<string, number>;
}

interface HistoryChange {
  field: string;
  from: any;
  to: any;
}

interface HistoryEntry {
  seq: number;
  at: string;
  event: 'created' | 'changed' | 'cancelled';
  revision: number;
  accepted_terms: AcceptedTerms;
  changes: HistoryChange[];
}

interface Reservation {
  id: string;
  reference: string;
  user_id: string;
  restaurant_id: string;
  table_id: string;
  table_ids?: string[];
  starts_at_local: string;
  starts_at: string;
  ends_at: string;
  party_size: number;
  status: 'confirmed' | 'cancelled';
  created_at: string;
  revision: number;
  accepted_terms: AcceptedTerms;
  history: HistoryEntry[];
}

interface Series {
  id: string;
  owner: string;
  restaurant_id: string;
  revision: number;
  interval_weeks: number;
  occurrences: string[]; // reservation references in index order
  exceptions: Record<string, boolean>; // reference -> exception flag
}

interface Fixture {
  users: User[];
  restaurants: Restaurant[];
  reservations: Reservation[];
}

// In-memory storage (in production, this would be a database)
let state: {
  users: Record<string, User>;
  restaurants: Record<string, Restaurant>;
  reservations: Record<string, Reservation>;
  idempotencyKeys: Record<string, { userId: string; body: string; response: any }>;
  exportState: any;
  tokens: Record<string, string>; // token -> user_id mapping
  policies: Record<string, Policy[]>; // restaurant_id -> published policies in publication order
  nextPolicyVersion: Record<string, number>; // restaurant_id -> next version to allocate
  history: Record<string, HistoryEntry[]>; // reservation_id -> history entries
  series: Record<string, Series>; // series_id -> series
  seriesByReservation: Record<string, string>; // reservation reference -> series_id
  restaurantRevisions: Record<string, number>; // restaurant_id -> revision counter
} = {
  users: {},
  restaurants: {},
  reservations: {},
  idempotencyKeys: {},
  exportState: null,
  tokens: {},
  policies: {},
  nextPolicyVersion: {},
  history: {},
  series: {},
  seriesByReservation: {},
  restaurantRevisions: {}
};

// Append a history entry to a reservation (seq continues from the last entry)
const appendHistory = (reservation: Reservation, event: HistoryEntry['event'],
                       changes: HistoryChange[]): void => {
  const entries = state.history[reservation.id] || [];
  const entry: HistoryEntry = {
    seq: entries.length + 1,
    at: DateTime.now().toISO({ suppressMilliseconds: true, includeOffset: true }),
    event,
    revision: reservation.revision,
    accepted_terms: reservation.accepted_terms,
    changes
  };
  entries.push(entry);
  state.history[reservation.id] = entries;
};

const app = express();
app.use(express.json());

// Helper functions
const generateReference = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

const validateEmail = (email: string): boolean => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

const validateTimeFormat = (time: string): boolean => {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(time);
};

const getRestaurantById = (id: string): Restaurant | undefined => {
  return state.restaurants[id];
};

const getUserById = (id: string): User | undefined => {
  return state.users[id];
};

const getReservationByReference = (reference: string): Reservation | undefined => {
  return Object.values(state.reservations).find(r => r.reference === reference);
};

const getReservationsByUserId = (userId: string): Reservation[] => {
  return Object.values(state.reservations).filter(r => r.user_id === userId);
};

const getReservationById = (id: string): Reservation | undefined => {
  return state.reservations[id];
};

// Serialize reservation object to consistent format
const serializeReservation = (reservation: Reservation): any => {
  const tableIds: string[] = reservation.table_ids && reservation.table_ids.length > 0
    ? reservation.table_ids
    : [reservation.table_id];
  const out: any = {
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
    created_at: reservation.created_at,
    revision: reservation.revision,
    accepted_terms: reservation.accepted_terms
  };
  if (tableIds.length === 1) {
    out.table_id = tableIds[0];
  }
  return out;
};

// Build the policy-0 (fixture) accepted terms for a restaurant
const fixtureAcceptedTerms = (restaurant: Restaurant): AcceptedTerms => ({
  policy_version: 0,
  slot_minutes: restaurant.slot_minutes,
  reservation_duration_minutes: restaurant.reservation_duration_minutes,
  cancellation_cutoff_minutes: restaurant.cancellation_cutoff_minutes,
  opening_hours: restaurant.opening_hours,
  capacities: Object.fromEntries(restaurant.tables.map(t => [t.id, t.capacity]))
});

// Select the policy applicable to a local calendar date (YYYY-MM-DD).
// Greatest effective_from <= date; ties broken by greatest policy_version.
// Falls back to policy 0 (fixture rules) when no published policy applies.
const selectPolicy = (restaurant: Restaurant, localDate: string): {
  policy_version: number;
  slot_minutes: number;
  reservation_duration_minutes: number;
  cancellation_cutoff_minutes: number;
  opening_hours: OpeningHour[];
  capacities: Record<string, number>;
} => {
  const published = state.policies[restaurant.id] || [];
  let best: Policy | null = null;
  for (const p of published) {
    if (p.effective_from > localDate) continue;
    if (!best || p.effective_from > best.effective_from ||
        (p.effective_from === best.effective_from && p.policy_version > best.policy_version)) {
      best = p;
    }
  }
  if (best) {
    return {
      policy_version: best.policy_version,
      slot_minutes: best.slot_minutes,
      reservation_duration_minutes: best.reservation_duration_minutes,
      cancellation_cutoff_minutes: best.cancellation_cutoff_minutes,
      opening_hours: best.opening_hours,
      capacities: best.capacities
    };
  }
  return {
    policy_version: 0,
    slot_minutes: restaurant.slot_minutes,
    reservation_duration_minutes: restaurant.reservation_duration_minutes,
    cancellation_cutoff_minutes: restaurant.cancellation_cutoff_minutes,
    opening_hours: restaurant.opening_hours,
    capacities: Object.fromEntries(restaurant.tables.map(t => [t.id, t.capacity]))
  };
};

// Check whether a reservation occupies a given table at the given interval
const reservationOccupiesTable = (reservation: Reservation, tableId: string, start: DateTime, end: DateTime): boolean => {
  const ids = reservation.table_ids && reservation.table_ids.length > 0
    ? reservation.table_ids
    : [reservation.table_id];
  if (!ids.includes(tableId)) return false;
  const resStart = DateTime.fromISO(reservation.starts_at);
  const resEnd = DateTime.fromISO(reservation.ends_at);
  return !(end <= resStart || start >= resEnd);
};

// Middleware
const authenticate = (req: Request, res: Response, next: NextFunction) => {
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
  (req as any).user = { id: userId };
  next();
};

// Error handling middleware
const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err);
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Internal server error'
    }
  });
};

// Express error handling middleware for JSON parsing errors
const jsonErrorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
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
const PUB = path.join(__dirname, '..', 'public');
const page = (f: string) => (_req: any, res: any) => {
  const p = path.join(PUB, f);
  if (!fs.existsSync(p)) return res.status(404).send('not found');
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
  const fixture: Fixture = req.body;
  
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
    tokens: savedTokens, // Preserve issued tokens
    policies: {},
    nextPolicyVersion: {},
    history: {},
    series: {},
    seriesByReservation: {},
    restaurantRevisions: {}
  };

  // Load fixture data
  fixture.users.forEach(user => {
    // Hash password if it exists (for seeded users)
    if ((user as any).password) {
      const hashedPassword = bcrypt.hashSync((user as any).password, 10);
      // Create a new user object with hashed password
      const userWithHash = {
        ...user,
        password_hash: hashedPassword
      };
      // Remove password field from the object
      delete (userWithHash as any).password;
      state.users[user.id] = userWithHash as User;
    } else {
      state.users[user.id] = user;
    }
  });

  fixture.restaurants.forEach(restaurant => {
    state.restaurants[restaurant.id] = restaurant;
    state.policies[restaurant.id] = [];
    state.nextPolicyVersion[restaurant.id] = 1;
    state.restaurantRevisions[restaurant.id] = 0;
  });

fixture.reservations.forEach(reservation => {
    // Apply the same normalization that happens during creation
    // For seeded reservations, we need to compute starts_at/ends_at from starts_at_local
    let normalizedReservation = { ...reservation };
    
    // Ensure reservation has required fields with defaults
    normalizedReservation.status = reservation.status || 'confirmed';
    normalizedReservation.revision = 1;
    normalizedReservation.accepted_terms = fixtureAcceptedTerms(getRestaurantById(reservation.restaurant_id)!);
    normalizedReservation.history = [];
    
    // If starts_at_local is provided, compute the absolute instants
    if (reservation.starts_at_local) {
      // Find the restaurant to get timezone info
      const restaurant = getRestaurantById(reservation.restaurant_id);
      if (restaurant) {
        // Parse the local time and convert to absolute instants
        const startsAt = DateTime.fromISO(reservation.starts_at_local, { zone: restaurant.timezone });
        if (startsAt.isValid) {
          // Compute ends_at based on reservation duration
          const endsAt = startsAt.plus({ minutes: restaurant.reservation_duration_minutes });
          
          normalizedReservation.starts_at = startsAt.toISO({ suppressMilliseconds: true }) || '';
          normalizedReservation.ends_at = endsAt.toISO({ suppressMilliseconds: true }) || '';
        } else {
          // If invalid time, set empty strings
          normalizedReservation.starts_at = '';
          normalizedReservation.ends_at = '';
        }
      } else {
        // If no restaurant found, set empty strings
        normalizedReservation.starts_at = '';
        normalizedReservation.ends_at = '';
      }
    } else {
      // If no starts_at_local, set empty strings
      normalizedReservation.starts_at = '';
      normalizedReservation.ends_at = '';
    }
    
    state.reservations[normalizedReservation.id] = normalizedReservation;
    // Seed the created history entry for the seeded reservation
    const tableIds = normalizedReservation.table_ids && normalizedReservation.table_ids.length > 0
      ? normalizedReservation.table_ids
      : [normalizedReservation.table_id];
    const createdChanges: HistoryChange[] = [];
    if (tableIds.length === 1) {
      createdChanges.push({ field: 'table_id', from: null, to: tableIds[0] });
    } else {
      createdChanges.push({ field: 'table_ids', from: null, to: tableIds });
    }
    createdChanges.push({ field: 'starts_at_local', from: null, to: normalizedReservation.starts_at_local });
    createdChanges.push({ field: 'party_size', from: null, to: normalizedReservation.party_size });
    appendHistory(normalizedReservation, 'created', createdChanges);
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
      tokens: state.tokens,
      policies: state.policies,
      nextPolicyVersion: state.nextPolicyVersion,
      history: state.history,
      series: state.series,
      seriesByReservation: state.seriesByReservation,
      restaurantRevisions: state.restaurantRevisions
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
  state.policies = importedState.policies || {};
  state.nextPolicyVersion = importedState.nextPolicyVersion || {};
  state.history = importedState.history || {};
  state.series = importedState.series || {};
  state.seriesByReservation = importedState.seriesByReservation || {};
  state.restaurantRevisions = importedState.restaurantRevisions || {};

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
    const newUser: User = {
      id: userId,
      email,
      password_hash: hash,
      display_name
    };

    state.users[userId] = newUser;

    // Generate a real token for the user
    const token = `token_${uuidv4().substring(0, 16)}`;
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
  bcrypt.compare(password, user.password_hash, (err, result) => {
    if (err || !result) {
      return res.status(401).json({
        error: {
          code: 'unauthenticated',
          message: 'Invalid email or password'
        }
      });
    }

    // Generate a real token for the user
    const token = `token_${uuidv4().substring(0, 16)}`;
    state.tokens[token] = user.id;

    res.status(200).json({
      user_id: user.id,
      display_name: user.display_name,
      token
    });
  });
});

// Validate auth endpoint
app.get('/auth/validate', (req: any, res: any) => {
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const uid = state.tokens[tok];
  const user = uid && state.users[uid];
  if (!user) return res.status(401).json({ error: { code: 'unauthenticated', message: 'Invalid token' } });
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

// Public: list published policies in publication order (policy 0 omitted)
app.get('/restaurants/:id/policies', (req, res) => {
  const restaurant = getRestaurantById(req.params.id);
  if (!restaurant) {
    return res.status(404).json({
      error: {
        code: 'not_found',
        message: 'Restaurant not found'
      }
    });
  }

  res.status(200).json({ policies: state.policies[restaurant.id] || [] });
});

// Publish a complete booking policy (manager only, idempotent)
app.post('/restaurants/:id/policies', authenticate, (req, res) => {
  const restaurant = getRestaurantById(req.params.id);
  if (!restaurant) {
    return res.status(404).json({
      error: {
        code: 'not_found',
        message: 'Restaurant not found'
      }
    });
  }

  const userId = (req as any).user.id;
  const managers = Array.isArray(restaurant.manager_user_ids) ? restaurant.manager_user_ids : [];
  if (!managers.includes(userId)) {
    return res.status(403).json({
      error: {
        code: 'forbidden',
        message: 'Only managers may publish policies'
      }
    });
  }

  const idempotencyKey = req.headers['idempotency-key'] as string;
  if (!idempotencyKey) {
    return res.status(400).json({
      error: {
        code: 'missing_idempotency_key',
        message: 'Idempotency key is required'
      }
    });
  }

  const keyEntry = state.idempotencyKeys[`${userId}:${idempotencyKey}`];
  if (keyEntry) {
    if (JSON.stringify(req.body) === keyEntry.body) {
      return res.status(200).json(keyEntry.response);
    }
    return res.status(409).json({
      error: {
        code: 'idempotency_key_reuse',
        message: 'Idempotency key already used with different request body'
      }
    });
  }

  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(422).json({
      error: {
        code: 'validation_failed',
        message: 'Policy body must be an object'
      }
    });
  }

  const tableIds = restaurant.tables.map(t => t.id);

  const validatePolicy = (p: any): string | null => {
    if (typeof p.effective_from !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.effective_from)) {
      return 'invalid effective_from';
    }
    const [y, m, d] = p.effective_from.split('-').map(Number);
    const testDate = new Date(y, m - 1, d);
    if (testDate.getFullYear() !== y || testDate.getMonth() !== m - 1 || testDate.getDate() !== d) {
      return 'invalid effective_from';
    }
    if (typeof p.slot_minutes !== 'number' || !Number.isInteger(p.slot_minutes) ||
        p.slot_minutes < 1 || p.slot_minutes > 1440) {
      return 'invalid slot_minutes';
    }
    if (typeof p.reservation_duration_minutes !== 'number' || !Number.isInteger(p.reservation_duration_minutes) ||
        p.reservation_duration_minutes < 1 || p.reservation_duration_minutes > 1440) {
      return 'invalid reservation_duration_minutes';
    }
    if (typeof p.cancellation_cutoff_minutes !== 'number' || !Number.isInteger(p.cancellation_cutoff_minutes) ||
        p.cancellation_cutoff_minutes < 0 || p.cancellation_cutoff_minutes > 10080) {
      return 'invalid cancellation_cutoff_minutes';
    }
    if (!Array.isArray(p.opening_hours)) {
      return 'invalid opening_hours';
    }
    const weekdays = new Set<string>();
    for (const h of p.opening_hours) {
      if (!h || typeof h !== 'object' ||
          typeof h.weekday !== 'string' ||
          !['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(h.weekday) ||
          typeof h.opens !== 'string' || !/^\d{2}:\d{2}$/.test(h.opens) ||
          typeof h.closes !== 'string' || !/^\d{2}:\d{2}$/.test(h.closes)) {
        return 'invalid opening_hours entry';
      }
      if (weekdays.has(h.weekday)) {
        return 'duplicate weekday in opening_hours';
      }
      weekdays.add(h.weekday);
    }
    if (!p.capacities || typeof p.capacities !== 'object' || Array.isArray(p.capacities)) {
      return 'invalid capacities';
    }
    const capKeys = Object.keys(p.capacities);
    if (capKeys.length !== tableIds.length ||
        !tableIds.every(id => capKeys.includes(id))) {
      return 'capacities must name exactly the restaurant table ids';
    }
    for (const id of capKeys) {
      const cap = p.capacities[id];
      if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1 || cap > 100) {
        return 'invalid capacity value';
      }
    }
    return null;
  };

  const problem = validatePolicy(body);
  if (problem) {
    return res.status(422).json({
      error: {
        code: 'validation_failed',
        message: problem
      }
    });
  }

  const version = state.nextPolicyVersion[restaurant.id];
  const policy: Policy = {
    policy_version: version,
    effective_from: body.effective_from,
    slot_minutes: body.slot_minutes,
    reservation_duration_minutes: body.reservation_duration_minutes,
    cancellation_cutoff_minutes: body.cancellation_cutoff_minutes,
    opening_hours: body.opening_hours,
    capacities: body.capacities
  };

  state.policies[restaurant.id].push(policy);
  state.nextPolicyVersion[restaurant.id] = version + 1;
  state.restaurantRevisions[restaurant.id] = (state.restaurantRevisions[restaurant.id] || 0) + 1;

  const response = policy;
  state.idempotencyKeys[`${userId}:${idempotencyKey}`] = {
    userId,
    body: JSON.stringify(req.body),
    response
  };

  res.status(201).json(response);
});

app.get('/availability', (req, res) => {
  const { restaurant_id, date, party_size, explain } = req.query;

  // Validate required parameters
  if (!restaurant_id || !date || !party_size) {
    return res.status(422).json({
      error: {
        code: 'validation_failed',
        message: 'Missing required parameters'
      }
    });
  }

  // `explain` is optional; its only accepted value is the string "true".
  // Any other value (including "false", "1", empty string) is 422.
  const explainFlag = explain === undefined ? false : explain === 'true';
  if (explain !== undefined && explain !== 'true') {
    return res.status(422).json({
      error: {
        code: 'validation_failed',
        message: 'Invalid explain parameter'
      }
    });
  }

  const restaurant = getRestaurantById(restaurant_id as string);
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
  if (!dateRegex.test(date as string)) {
    return res.status(422).json({
      error: {
        code: 'validation_failed',
        message: 'Invalid date format. Expected YYYY-MM-DD'
      }
    });
  }

  // Validate actual calendar date components
  const [yearStr, monthStr, dayStr] = (date as string).split('-');
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
  const partySizeStr = party_size as string;
  
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
  const slots = generateAvailableSlots(restaurant, date as string, partySize, explainFlag);

  res.status(200).json({
    restaurant_id,
    date,
    timezone: restaurant.timezone,
    slots
  });
});

// Helper function to generate available slots
const generateAvailableSlots = (restaurant: Restaurant, dateStr: string, partySize: number,
                                explain: boolean): any[] => {
  // Parse the date
  const targetDate = DateTime.fromISO(dateStr, { zone: 'UTC' });
  if (!targetDate.isValid) {
    return [];
  }

  // Select the policy applicable to this local calendar date
  const policy = selectPolicy(restaurant, dateStr);

  // Find opening hours for this day
  const weekday = targetDate.weekday === 7 ? 'sun' : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][targetDate.weekday - 1];
  const openingHour = policy.opening_hours.find(h => h.weekday === weekday);

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
    minute: openMinute
  }, { zone: restaurant.timezone });

  const slotEnd = DateTime.fromObject({
    year: targetDate.year,
    month: targetDate.month,
    day: targetDate.day,
    hour: closeHour,
    minute: closeMinute
  }, { zone: restaurant.timezone });

  const durationMinutes = policy.reservation_duration_minutes;
  const slotInterval = policy.slot_minutes;

  while (slotStart < slotEnd) {
    const slotEndDateTime = slotStart.plus({ minutes: durationMinutes });
    
    // Check if slot would exceed closing time
    if (slotEndDateTime > slotEnd) {
      break;
    }

    // Check if table is available
    const availableTables = getAvailableTables(restaurant, slotStart, slotEndDateTime, partySize, policy);

    // Build available_options: singles first (fixture order), then declared pairs
    const availableOptions: { table_ids: string[]; capacity: number }[] = [];
    for (const table of restaurant.tables) {
      const cap = policy.capacities[table.id];
      if (cap !== undefined && cap >= partySize && availableTables.some(t => t.id === table.id)) {
        availableOptions.push({ table_ids: [table.id], capacity: cap });
      }
    }
    if (Array.isArray(restaurant.combinable)) {
      for (const pair of restaurant.combinable) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [a, b] = pair;
        const capA = policy.capacities[a];
        const capB = policy.capacities[b];
        if (capA === undefined || capB === undefined) continue;
        const capacity = capA + capB;
        if (capacity < partySize) continue;
        // Check both tables are free (no overlapping confirmed reservation on either)
        const aFree = !Object.values(state.reservations).some(res =>
          res.status === 'confirmed' && reservationOccupiesTable(res, a, slotStart, slotEndDateTime)
        );
        const bFree = !Object.values(state.reservations).some(res =>
          res.status === 'confirmed' && reservationOccupiesTable(res, b, slotStart, slotEndDateTime)
        );
        if (aFree && bFree) {
          availableOptions.push({ table_ids: [a, b], capacity });
        }
      }
    }

    const slot: any = {
      starts_at_local: slotStart.toFormat('yyyy-MM-dd\'T\'HH:mm'), // YYYY-MM-DDTHH:MM format
      starts_at: slotStart.toISO({ suppressMilliseconds: true }),
      available_table_ids: availableTables.map(t => t.id),
      available_options: availableOptions
    };

    if (explain) {
      slot.explain = restaurant.tables.map(table => {
        const cap = policy.capacities[table.id];
        const capacityHolds = cap !== undefined && cap >= partySize;
        const noOverlapHolds = !Object.values(state.reservations).some(res =>
          res.status === 'confirmed' && reservationOccupiesTable(res, table.id, slotStart, slotEndDateTime)
        );
        return {
          table_id: table.id,
          policy_version: policy.policy_version,
          available: capacityHolds && noOverlapHolds,
          rules: [
            { rule: 'capacity', holds: capacityHolds },
            { rule: 'no_overlap', holds: noOverlapHolds }
          ]
        };
      });
    }

    slots.push(slot);

    slotStart = slotStart.plus({ minutes: slotInterval });
  }

  return slots;
};

// Helper function to find available tables
const getAvailableTables = (restaurant: Restaurant, start: DateTime, end: DateTime, partySize: number,
                            policy: { capacities: Record<string, number> }): Table[] => {
  // Filter tables by capacity (from the selected policy)
  const eligibleTables = restaurant.tables.filter(table => {
    const cap = policy.capacities[table.id];
    return cap !== undefined && cap >= partySize;
  });

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
  const userId = (req as any).user.id;

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
  let tableSet: string[];
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
  } else if (typeof table_id === 'string' && table_id) {
    tableSet = [table_id];
  } else {
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
  const idempotencyKey = req.headers['idempotency-key'] as string;
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
      } else {
        return res.status(409).json({
          error: {
            code: 'idempotency_key_reuse',
            message: 'Idempotency key already used with different request body'
          }
        });
      }
    } catch (e) {
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
      restaurant.combinable.some(pair =>
        Array.isArray(pair) && pair.length === 2 &&
        ((pair[0] === a && pair[1] === b) || (pair[0] === b && pair[1] === a))
      );
    if (!declared) {
      return res.status(422).json({
        error: {
          code: 'combination_not_allowed',
          message: 'This pair of tables cannot be combined'
        }
      });
    }
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

  // Select the policy applicable to the booking's local start date
  const localDate = startsAt.toFormat('yyyy-MM-dd');
  const policy = selectPolicy(restaurant, localDate);

  // Validate party size vs combined capacity (from the selected policy)
  const combinedCapacity = tableSet.reduce((sum, id) => sum + (policy.capacities[id] ?? 0), 0);
  if (party_size > combinedCapacity) {
    return res.status(422).json({
      error: {
        code: 'party_exceeds_capacity',
        message: 'Party size exceeds table capacity'
      }
    });
  }

  // Check if start time is on slot grid
  const startMinutes = startsAt.hour * 60 + startsAt.minute;
  if (startMinutes % policy.slot_minutes !== 0) {
    return res.status(422).json({
      error: {
        code: 'not_on_slot_grid',
        message: 'Start time is not on slot grid'
      }
    });
  }

  // Check if reservation would be within opening hours
  const weekday = startsAt.weekday === 7 ? 'sun' : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][startsAt.weekday - 1];
  const openingHour = policy.opening_hours.find(h => h.weekday === weekday);
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
      minute: openMinute
    }, { zone: restaurant.timezone });

const closesAt = DateTime.fromObject({
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
  const endsAt = startsAt.plus({ minutes: policy.reservation_duration_minutes });
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
    if (res.status !== 'confirmed') return false;
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
  const reservationId = `res_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
  const reference = generateReference();

  const reservation: Reservation = {
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
    created_at: DateTime.now().toISO({ suppressMilliseconds: true, includeOffset: true }),
    revision: 1,
    accepted_terms: policy,
    history: []
  };

  // Store reservation
  state.reservations[reservationId] = reservation;

  // Record the created history entry
  const createdChanges: HistoryChange[] = [];
  if (tableSet.length === 1) {
    createdChanges.push({ field: 'table_id', from: null, to: tableSet[0] });
  } else {
    createdChanges.push({ field: 'table_ids', from: null, to: tableSet });
  }
  createdChanges.push({ field: 'starts_at_local', from: null, to: starts_at_local });
  createdChanges.push({ field: 'party_size', from: null, to: party_size });
  appendHistory(reservation, 'created', createdChanges);

  // Bump the restaurant revision once for this booking
  state.restaurantRevisions[restaurant_id] = (state.restaurantRevisions[restaurant_id] || 0) + 1;

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

// Create a recurring series from an existing reservation (occurrence zero).
// Atomic: on any failure nothing is created and no idempotency claim is kept.
app.post('/series', authenticate, (req, res) => {
  const userId = (req as any).user.id;
  const { anchor_reference, count, interval_weeks } = req.body;

  // Validate body fields
  if (typeof anchor_reference !== 'string' || !anchor_reference) {
    return res.status(422).json({
      error: {
        code: 'validation_failed',
        message: 'anchor_reference is required'
      }
    });
  }
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 2 || count > 12) {
    return res.status(422).json({
      error: {
        code: 'validation_failed',
        message: 'count must be an integer 2..12'
      }
    });
  }
  if (typeof interval_weeks !== 'number' || !Number.isInteger(interval_weeks) ||
      interval_weeks < 1 || interval_weeks > 4) {
    return res.status(422).json({
      error: {
        code: 'validation_failed',
        message: 'interval_weeks must be an integer 1..4'
      }
    });
  }

  // Idempotency key (stage-1 replay rules)
  const idempotencyKey = req.headers['idempotency-key'] as string;
  if (!idempotencyKey) {
    return res.status(400).json({
      error: {
        code: 'missing_idempotency_key',
        message: 'Idempotency key is required'
      }
    });
  }
  const keyEntry = state.idempotencyKeys[`${userId}:${idempotencyKey}`];
  if (keyEntry) {
    if (JSON.stringify(req.body) === keyEntry.body) {
      return res.status(200).json(keyEntry.response);
    }
    return res.status(409).json({
      error: {
        code: 'idempotency_key_reuse',
        message: 'Idempotency key already used with different request body'
      }
    });
  }

  // Resolve the anchor
  const anchor = getReservationByReference(anchor_reference);
  if (!anchor || anchor.user_id !== userId) {
    return res.status(404).json({
      error: {
        code: 'not_found',
        message: 'Reservation not found'
      }
    });
  }
  if (anchor.status === 'cancelled') {
    return res.status(409).json({
      error: {
        code: 'reservation_cancelled',
        message: 'Anchor is cancelled'
      }
    });
  }
  if (state.seriesByReservation[anchor.reference]) {
    return res.status(409).json({
      error: {
        code: 'already_in_series',
        message: 'Anchor is already part of a series'
      }
    });
  }

  // Anchor must satisfy its accepted cancellation cutoff
  const anchorStart = DateTime.fromISO(anchor.starts_at);
  const timeUntilAnchorStart = anchorStart.diff(DateTime.now(), 'minutes').minutes;
  if (timeUntilAnchorStart <= anchor.accepted_terms.cancellation_cutoff_minutes) {
    return res.status(409).json({
      error: {
        code: 'cutoff_passed',
        message: 'Anchor cancellation deadline passed'
      }
    });
  }

  const restaurant = getRestaurantById(anchor.restaurant_id);
  if (!restaurant) {
    return res.status(404).json({
      error: {
        code: 'not_found',
        message: 'Restaurant not found'
      }
    });
  }

  const anchorTableSet: string[] = anchor.table_ids && anchor.table_ids.length > 0
    ? anchor.table_ids
    : [anchor.table_id];

  // Build the series atomically. On any failure, roll back everything.
  const newReservations: Reservation[] = [];
  const newHistory: Record<string, HistoryEntry[]> = {};
  const newSeriesByReservation: Record<string, string> = {};
  const seriesId = `series_${uuidv4().replace(/-/g, '').substring(0, 12)}`;

  try {
    const occurrences: { index: number; reference: string; exception: boolean; reservation: any }[] = [];

    // Occurrence 0: the anchor itself, unchanged
    occurrences.push({
      index: 0,
      reference: anchor.reference,
      exception: false,
      reservation: serializeReservation(anchor)
    });
    newSeriesByReservation[anchor.reference] = seriesId;

    // Occurrences 1..count-1
    for (let i = 1; i < count; i++) {
      const anchorLocal = DateTime.fromISO(anchor.starts_at_local, { zone: restaurant.timezone });
      const targetDate = anchorLocal.plus({ days: i * interval_weeks * 7 });
      const startsAtLocal = targetDate.toFormat('yyyy-MM-dd\'T\'HH:mm');
      const startsAt = DateTime.fromISO(startsAtLocal, { zone: restaurant.timezone });
      if (!startsAt.isValid) {
        throw { status: 422, code: 'invalid_local_time', message: 'Invalid local time' };
      }

      const localDate = startsAt.toFormat('yyyy-MM-dd');
      const policy = selectPolicy(restaurant, localDate);

      // Capacity check
      const combinedCapacity = anchorTableSet.reduce((sum, id) => sum + (policy.capacities[id] ?? 0), 0);
      if (anchor.party_size > combinedCapacity) {
        throw { status: 422, code: 'party_exceeds_capacity', message: 'Party size exceeds table capacity' };
      }

      // Slot grid check
      const startMinutes = startsAt.hour * 60 + startsAt.minute;
      if (startMinutes % policy.slot_minutes !== 0) {
        throw { status: 422, code: 'not_on_slot_grid', message: 'Start time is not on slot grid' };
      }

      // Opening hours check
      const weekday = startsAt.weekday === 7 ? 'sun' : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][startsAt.weekday - 1];
      const openingHour = policy.opening_hours.find(h => h.weekday === weekday);
      if (!openingHour) {
        throw { status: 422, code: 'outside_opening_hours', message: 'Reservation outside opening hours' };
      }
      const [openHour, openMinute] = openingHour.opens.split(':').map(Number);
      const [closeHour, closeMinute] = openingHour.closes.split(':').map(Number);
      const opensAt = DateTime.fromObject({
        year: startsAt.year, month: startsAt.month, day: startsAt.day,
        hour: openHour, minute: openMinute
      }, { zone: restaurant.timezone });
      const closesAt = DateTime.fromObject({
        year: startsAt.year, month: startsAt.month, day: startsAt.day,
        hour: closeHour, minute: closeMinute
      }, { zone: restaurant.timezone });
      if (startsAt < opensAt || startsAt >= closesAt) {
        throw { status: 422, code: 'outside_opening_hours', message: 'Reservation outside opening hours' };
      }
      const endsAt = startsAt.plus({ minutes: policy.reservation_duration_minutes });
      if (endsAt > closesAt) {
        throw { status: 422, code: 'outside_opening_hours', message: 'Reservation would end after closing' };
      }

      // Occupancy check (against all confirmed reservations, including ones created earlier in this loop)
      const allReservations = [...Object.values(state.reservations), ...newReservations];
      const conflict = allReservations.find(res => {
        if (res.status !== 'confirmed') return false;
        return anchorTableSet.some(tableId => reservationOccupiesTable(res, tableId, startsAt, endsAt));
      });
      if (conflict) {
        throw { status: 409, code: 'table_unavailable', message: 'Table is not available at the requested time' };
      }

      const reservationId = `res_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
      const reference = generateReference();
      const reservation: Reservation = {
        id: reservationId,
        reference,
        user_id: userId,
        restaurant_id: restaurant.id,
        table_id: anchorTableSet[0],
        table_ids: anchorTableSet,
        starts_at_local: startsAtLocal,
        starts_at: startsAt.toISO({ suppressMilliseconds: true }),
        ends_at: endsAt.toISO({ suppressMilliseconds: true }),
        party_size: anchor.party_size,
        status: 'confirmed',
        created_at: DateTime.now().toISO({ suppressMilliseconds: true, includeOffset: true }),
        revision: 1,
        accepted_terms: policy,
        history: []
      };
      newReservations.push(reservation);
      newSeriesByReservation[reference] = seriesId;

      const createdChanges: HistoryChange[] = [];
      if (anchorTableSet.length === 1) {
        createdChanges.push({ field: 'table_id', from: null, to: anchorTableSet[0] });
      } else {
        createdChanges.push({ field: 'table_ids', from: null, to: anchorTableSet });
      }
      createdChanges.push({ field: 'starts_at_local', from: null, to: startsAtLocal });
      createdChanges.push({ field: 'party_size', from: null, to: anchor.party_size });
      newHistory[reservationId] = [{
        seq: 1,
        at: reservation.created_at,
        event: 'created',
        revision: 1,
        accepted_terms: policy,
        changes: createdChanges
      }];

      occurrences.push({
        index: i,
        reference,
        exception: false,
        reservation: serializeReservation(reservation)
      });
    }

    // Commit atomically
    for (const r of newReservations) {
      state.reservations[r.id] = r;
    }
    for (const [id, entries] of Object.entries(newHistory)) {
      state.history[id] = entries;
    }
    const series: Series = {
      id: seriesId,
      owner: userId,
      restaurant_id: restaurant.id,
      revision: 1,
      interval_weeks,
      occurrences: occurrences.map(o => o.reference),
      exceptions: {}
    };
    for (const ref of series.occurrences) {
      state.seriesByReservation[ref] = seriesId;
    }
    state.series[seriesId] = series;
    state.restaurantRevisions[restaurant.id] = (state.restaurantRevisions[restaurant.id] || 0) + 1;

    const response = {
      series_id: seriesId,
      revision: 1,
      interval_weeks,
      occurrences
    };
    state.idempotencyKeys[`${userId}:${idempotencyKey}`] = {
      userId,
      body: JSON.stringify(req.body),
      response
    };

    res.status(201).json(response);
  } catch (err: any) {
    // Rollback: nothing was committed yet, so just return the error
    const status = err?.status || 500;
    const code = err?.code || 'internal_error';
    const message = err?.message || 'Internal server error';
    res.status(status).json({ error: { code, message } });
  }
});

// Get a series with current reservation states. Owner-only; 404 otherwise.
app.get('/series/:series_id', (req, res) => {
  const series = state.series[req.params.series_id];
  if (!series) {
    return res.status(404).json({
      error: {
        code: 'not_found',
        message: 'Series not found'
      }
    });
  }

  const authHeader = req.headers.authorization;
  let userId: string | null = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    userId = state.tokens[token] || null;
  }
  if (userId !== series.owner) {
    return res.status(404).json({
      error: {
        code: 'not_found',
        message: 'Series not found'
      }
    });
  }

  const occurrences = series.occurrences.map((reference, index) => {
    const reservation = getReservationByReference(reference);
    return {
      index,
      reference,
      exception: series.exceptions[reference] === true,
      reservation: reservation ? serializeReservation(reservation) : null
    };
  });

  res.status(200).json({
    series_id: series.id,
    revision: series.revision,
    interval_weeks: series.interval_weeks,
    occurrences
  });
});

app.get('/reservations', authenticate, (req, res) => {
  const userId = (req as any).user.id;
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
  const userId = (req as any).user.id;
  
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

// Current booking decision: revision + accepted terms. Owner-only;
// anyone else (including anonymous) gets 404 not_found, not 401.
app.get('/reservations/:reference/decision', (req, res) => {
  const reference = req.params.reference;
  const reservation = getReservationByReference(reference || '');

  if (!reservation) {
    return res.status(404).json({
      error: {
        code: 'not_found',
        message: 'Reservation not found'
      }
    });
  }

  const authHeader = req.headers.authorization;
  let userId: string | null = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    userId = state.tokens[token] || null;
  }

  if (userId !== reservation.user_id) {
    return res.status(404).json({
      error: {
        code: 'not_found',
        message: 'Reservation not found'
      }
    });
  }

  res.status(200).json({
    reference: reservation.reference,
    revision: reservation.revision,
    accepted_terms: reservation.accepted_terms
  });
});

// Reservation history: the reservation's own record, oldest first.
// Owner-only; anyone else (including anonymous) gets 404 not_found, not 401.
app.get('/reservations/:reference/history', (req, res) => {
  const reference = req.params.reference;
  const reservation = getReservationByReference(reference || '');

  if (!reservation) {
    return res.status(404).json({
      error: {
        code: 'not_found',
        message: 'Reservation not found'
      }
    });
  }

  const authHeader = req.headers.authorization;
  let userId: string | null = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    userId = state.tokens[token] || null;
  }

  if (userId !== reservation.user_id) {
    return res.status(404).json({
      error: {
        code: 'not_found',
        message: 'Reservation not found'
      }
    });
  }

  const entries = (state.history[reservation.id] || []).slice().sort((a, b) => a.seq - b.seq);
  res.status(200).json({
    reference: reservation.reference,
    entries
  });
});

app.post('/reservations/:reference/cancel', authenticate, (req, res) => {
  const reference = req.params.reference;
  const userId = (req as any).user.id;
  
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
  
  // Check if already cancelled: repeat cancel changes nothing
  if (reservation.status === 'cancelled') {
    return res.status(200).json(serializeReservation(reservation));
  }
  
  // Check cancellation cutoff against the accepted terms
  const startsAt = DateTime.fromISO(reservation.starts_at);
  const now = DateTime.now();
  const timeUntilStart = startsAt.diff(now, 'minutes').minutes;
  
  // Check if cancellation is within cutoff period
  if (timeUntilStart <= reservation.accepted_terms.cancellation_cutoff_minutes) {
    return res.status(409).json({
      error: {
        code: 'cutoff_passed',
        message: 'Cancellation deadline passed'
      }
    });
  }
  
  // Cancel reservation: increment revision once, record terminal entry
  reservation.status = 'cancelled';
  reservation.revision += 1;
  appendHistory(reservation, 'cancelled', []);

  // Bump the restaurant revision once for this cancellation
  state.restaurantRevisions[reservation.restaurant_id] =
    (state.restaurantRevisions[reservation.restaurant_id] || 0) + 1;

  // If this reservation is part of a series, bump the series revision once
  const seriesId = state.seriesByReservation[reservation.reference];
  if (seriesId) {
    const series = state.series[seriesId];
    if (series) {
      series.revision += 1;
    }
  }

  res.status(200).json(serializeReservation(reservation));
});

app.patch('/reservations/:reference', authenticate, (req, res) => {
  const reference = req.params.reference;
  const userId = (req as any).user.id;
  const { table_id, table_ids, starts_at_local, party_size, expected_revision } = req.body;

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

  // expected_revision: positive integer; wrong type/range -> 422;
  // differing from current -> 409 stale_revision before cutoff/validation
  if (expected_revision !== undefined) {
    if (typeof expected_revision !== 'number' || !Number.isInteger(expected_revision) ||
        expected_revision < 1) {
      return res.status(422).json({
        error: {
          code: 'validation_failed',
          message: 'Invalid expected_revision'
        }
      });
    }
    if (expected_revision !== reservation.revision) {
      return res.status(409).json({
        error: {
          code: 'stale_revision',
          message: 'Reservation revision has changed'
        }
      });
    }
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

  // Resolve the requested table set (or the current one when unchanged)
  let newTableSet: string[] | null = null;
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
        restaurant.combinable.some(pair =>
          Array.isArray(pair) && pair.length === 2 &&
          ((pair[0] === a && pair[1] === b) || (pair[0] === b && pair[1] === a))
        );
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
  } else if (table_id !== undefined) {
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
    newTableSet = [table_id];
  }

  // Validate time format if provided
  if (starts_at_local !== undefined && !validateTimeFormat(starts_at_local)) {
    return res.status(422).json({
      error: {
        code: 'validation_failed',
        message: 'Invalid time format'
      }
    });
  }

  const currentTableSet: string[] = reservation.table_ids && reservation.table_ids.length > 0
    ? reservation.table_ids
    : [reservation.table_id];
  const newStartsAt = starts_at_local !== undefined
    ? DateTime.fromISO(starts_at_local, { zone: restaurant.timezone })
    : DateTime.fromISO(reservation.starts_at);
  const newPartySize = party_size !== undefined ? party_size : reservation.party_size;
  const resultingTableSet: string[] = newTableSet || currentTableSet;

  // Detect a no-op amendment: every provided field equals its current value.
  // A no-op still requires a confirmed, editable booking but records no entry.
  const tableUnchanged = newTableSet === null ||
    newTableSet.length === currentTableSet.length &&
    newTableSet.every((id, i) => id === currentTableSet[i]);
  const timeUnchanged = starts_at_local === undefined || starts_at_local === reservation.starts_at_local;
  const partyUnchanged = party_size === undefined || party_size === reservation.party_size;
  if (tableUnchanged && timeUnchanged && partyUnchanged) {
    return res.status(200).json(serializeReservation(reservation));
  }

  // Check the OLD accepted cutoff first, against the current start
  const oldStartsAt = DateTime.fromISO(reservation.starts_at);
  const timeUntilStart = oldStartsAt.diff(DateTime.now(), 'minutes').minutes;
  if (timeUntilStart <= reservation.accepted_terms.cancellation_cutoff_minutes) {
    return res.status(409).json({
      error: {
        code: 'cutoff_passed',
        message: 'Change deadline passed'
      }
    });
  }

  // Validate all resulting fields against the policy applicable to the
  // resulting start date
  const localDate = newStartsAt.toFormat('yyyy-MM-dd');
  const policy = selectPolicy(restaurant, localDate);

  // Validate party size vs combined capacity (from the selected policy)
  const combinedCapacity = resultingTableSet.reduce((sum, id) => sum + (policy.capacities[id] ?? 0), 0);
  if (newPartySize > combinedCapacity) {
    return res.status(422).json({
      error: {
        code: 'party_exceeds_capacity',
        message: 'Party size exceeds table capacity'
      }
    });
  }

  // Check if start time is on slot grid
  const startMinutes = newStartsAt.hour * 60 + newStartsAt.minute;
  if (startMinutes % policy.slot_minutes !== 0) {
    return res.status(422).json({
      error: {
        code: 'not_on_slot_grid',
        message: 'Start time is not on slot grid'
      }
    });
  }

  // Check if reservation would be within opening hours
  const weekday = newStartsAt.weekday === 7 ? 'sun' : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][newStartsAt.weekday - 1];
  const openingHour = policy.opening_hours.find(h => h.weekday === weekday);
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
    minute: openMinute
  }, { zone: restaurant.timezone });

  const closesAt = DateTime.fromObject({
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
  const endsAt = newStartsAt.plus({ minutes: policy.reservation_duration_minutes });
  if (endsAt > closesAt) {
    return res.status(422).json({
      error: {
        code: 'outside_opening_hours',
        message: 'Reservation would end after closing'
      }
    });
  }

  // Check for overlapping reservations on any table in the new set
  const reservationConflict = Object.values(state.reservations).find(res => {
    if (res.id === reservation.id || res.status !== 'confirmed') return false;
    return resultingTableSet.some(tableId => reservationOccupiesTable(res, tableId, newStartsAt, endsAt));
  });

  if (reservationConflict) {
    return res.status(409).json({
      error: {
        code: 'table_unavailable',
        message: 'Table is not available at the requested time'
      }
    });
  }

  // Build the history changes for the fields that actually changed,
  // in the order table_id/table_ids, starts_at_local, party_size
  const changes: HistoryChange[] = [];
  if (!tableUnchanged) {
    if (resultingTableSet.length === 1) {
      const from = currentTableSet.length === 1 ? currentTableSet[0] : currentTableSet;
      changes.push({ field: 'table_id', from, to: resultingTableSet[0] });
    } else {
      changes.push({ field: 'table_ids', from: currentTableSet, to: resultingTableSet });
    }
  }
  if (!timeUnchanged) {
    changes.push({ field: 'starts_at_local', from: reservation.starts_at_local, to: starts_at_local });
  }
  if (!partyUnchanged) {
    changes.push({ field: 'party_size', from: reservation.party_size, to: newPartySize });
  }

  // Atomically replace accepted terms and end time, increment revision once
  reservation.table_id = resultingTableSet[0];
  reservation.table_ids = resultingTableSet;
  reservation.starts_at_local = starts_at_local !== undefined ? starts_at_local : reservation.starts_at_local;
  reservation.starts_at = newStartsAt.toISO({ suppressMilliseconds: true });
  reservation.ends_at = endsAt.toISO({ suppressMilliseconds: true });
  reservation.party_size = newPartySize;
  reservation.accepted_terms = policy;
  reservation.revision += 1;
  appendHistory(reservation, 'changed', changes);

  // Bump the restaurant revision once for this real amendment
  state.restaurantRevisions[reservation.restaurant_id] =
    (state.restaurantRevisions[reservation.restaurant_id] || 0) + 1;

  // A real individual PATCH on a series occurrence permanently marks it as
  // an exception and increments the series revision once
  const seriesId = state.seriesByReservation[reservation.reference];
  if (seriesId) {
    const series = state.series[seriesId];
    if (series) {
      series.exceptions[reservation.reference] = true;
      series.revision += 1;
    }
  }

  res.status(200).json(serializeReservation(reservation));
});

// Reservation moves route
app.post('/reservation-moves', authenticate, (req, res) => {
  const { reference, table_id, table_ids, starts_at_local, party_size } = req.body;
  const userId = (req as any).user.id;
  
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

    const opensAt = DateTime.fromObject({
      year: startsAt.year,
      month: startsAt.month,
      day: startsAt.day,
      hour: openHour,
      minute: openMinute
    }, { zone: restaurant.timezone });

    const closesAt = DateTime.fromObject({
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
      if (res.id === reservation.id || res.status !== 'confirmed') return false;
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
    const updatedReservation = { ...reservation };
    updatedReservation.starts_at_local = starts_at_local;
    updatedReservation.starts_at = startsAt.toISO({ suppressMilliseconds: true }) || '';
    updatedReservation.ends_at = endsAt.toISO({ suppressMilliseconds: true }) || '';

    state.reservations[reservation.id] = updatedReservation;
    state.restaurantRevisions[reservation.restaurant_id] =
      (state.restaurantRevisions[reservation.restaurant_id] || 0) + 1;

    res.status(200).json(serializeReservation(updatedReservation));
  } else {
    // Only table(s) provided - validate and update table only
    let newTableSet: string[] | null = null;
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
          restaurant.combinable.some(pair =>
            Array.isArray(pair) && pair.length === 2 &&
            ((pair[0] === a && pair[1] === b) || (pair[0] === b && pair[1] === a))
          );
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
    } else if (table_id) {
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
      const currentStart = DateTime.fromISO(reservation.starts_at);
      const currentEnd = DateTime.fromISO(reservation.ends_at);
      const reservationConflict = Object.values(state.reservations).find(res => {
        if (res.id === reservation.id || res.status !== 'confirmed') return false;
        return newTableSet!.some(tableId => reservationOccupiesTable(res, tableId, currentStart, currentEnd));
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
      const updatedReservation = { ...reservation };
      updatedReservation.table_id = newTableSet[0];
      updatedReservation.table_ids = newTableSet;

      state.reservations[reservation.id] = updatedReservation;
      state.restaurantRevisions[reservation.restaurant_id] =
        (state.restaurantRevisions[reservation.restaurant_id] || 0) + 1;

      res.status(200).json(serializeReservation(updatedReservation));
    } else {
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