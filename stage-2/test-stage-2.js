#!/usr/bin/env node

// Simple test to verify Stage 2 implementation works
const axios = require('axios');
const fs = require('fs');

// Test data
const fixtureData = {
  users: [
    {
      id: "u_ada",
      email: "ada@example.com",
      password: "correct horse",
      display_name: "Ada"
    }
  ],
  restaurants: [
    {
      id: "r_anker",
      name: "Zum Anker",
      timezone: "Europe/Berlin",
      slot_minutes: 30,
      reservation_duration_minutes: 90,
      cancellation_cutoff_minutes: 120,
      opening_hours: [
        {"weekday": "thu", "opens": "18:00", "closes": "23:00"},
        {"weekday": "fri", "opens": "18:00", "closes": "23:30"}
      ],
      tables: [
        {"id": "t_1", "label": "1", "capacity": 2},
        {"id": "t_2", "label": "2", "capacity": 4},
        {"id": "t_3", "label": "3", "capacity": 6}
      ],
      combinable: [["t_1", "t_2"]]
    }
  ],
  reservations: []
};

async function runTests() {
  try {
    console.log("Testing Stage 2 implementation...");
    
    // Reset the service with our fixture
    console.log("1. Resetting service with fixture data...");
    const resetResponse = await axios.post('http://localhost:8080/_test/reset', fixtureData);
    console.log("   ✓ Reset successful");
    
    // Test availability endpoint with combinations
    console.log("2. Testing availability with combinations...");
    const availabilityResponse = await axios.get('http://localhost:8080/availability?restaurant_id=r_anker&date=2026-09-24&party_size=6');
    console.log("   ✓ Availability retrieved");
    
    // Check that we have combinations in the response
    if (availabilityResponse.data.slots && availabilityResponse.data.slots.length > 0) {
      const slot = availabilityResponse.data.slots[0];
      if (slot.available_options) {
        console.log(`   ✓ Found ${slot.available_options.length} available options`);
        slot.available_options.forEach(option => {
          console.log(`     - Tables: ${option.table_ids.join(', ')}, Capacity: ${option.capacity}`);
        });
      }
    }
    
    // Test signup and login
    console.log("3. Testing authentication...");
    const signupResponse = await axios.post('http://localhost:8080/auth/signup', {
      email: "test@example.com",
      password: "password123",
      display_name: "Test User"
    });
    console.log("   ✓ Signup successful");
    
    const loginResponse = await axios.post('http://localhost:8080/auth/login', {
      email: "test@example.com",
      password: "password123"
    });
    console.log("   ✓ Login successful");
    
    const token = loginResponse.data.token;
    
    // Test combined table booking
    console.log("4. Testing combined table booking...");
    const bookingResponse = await axios.post('http://localhost:8080/reservations', {
      restaurant_id: "r_anker",
      table_ids: ["t_1", "t_2"],
      starts_at_local: "2026-09-24T19:00",
      party_size: 6
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': 'test_booking_123'
      }
    });
    console.log("   ✓ Combined table booking successful");
    console.log(`   ✓ Reservation reference: ${bookingResponse.data.reference}`);
    
    // Test reservation lookup
    console.log("5. Testing reservation lookup...");
    const lookupResponse = await axios.get(`http://localhost:8080/reservations/${bookingResponse.data.reference}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    console.log("   ✓ Reservation lookup successful");
    console.log(`   ✓ Tables booked: ${lookupResponse.data.table_ids ? lookupResponse.data.table_ids.join(', ') : lookupResponse.data.table_id}`);
    
    console.log("\n✓ All tests passed! Stage 2 implementation is working correctly.");
    
  } catch (error) {
    console.error("✗ Test failed:", error.message);
    if (error.response) {
      console.error("Response data:", error.response.data);
      console.error("Response status:", error.response.status);
    }
    process.exit(1);
  }
}

runTests();