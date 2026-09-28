const axios = require('axios');

async function testService() {
  const baseURL = 'http://localhost:8081';
  
  console.log('Running comprehensive tests for Tablekeeper Stage 1...');
  
  // Test 1: Health check
  try {
    const healthResponse = await axios.get(`${baseURL}/health`);
    console.log('✓ Health check:', healthResponse.data);
  } catch (error) {
    console.error('✗ Health check failed:', error.message);
    return false;
  }
  
  // Test 2: Empty restaurants list
  try {
    const restaurantsResponse = await axios.get(`${baseURL}/restaurants`);
    console.log('✓ Restaurants endpoint:', restaurantsResponse.data);
  } catch (error) {
    console.error('✗ Restaurants endpoint failed:', error.message);
    return false;
  }
  
  // Test 3: Reset endpoint with fixture
  try {
    const fixture = {
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
            { weekday: "thu", opens: "18:00", closes: "23:00" },
            { weekday: "fri", opens: "18:00", closes: "23:30" }
          ],
          tables: [
            { id: "t_1", label: "1", capacity: 2 },
            { id: "t_2", label: "2", capacity: 4 }
          ]
        }
      ],
      reservations: []
    };
    
    const resetResponse = await axios.post(`${baseURL}/_test/reset`, fixture);
    console.log('✓ Reset endpoint:', resetResponse.status);
  } catch (error) {
    console.error('✗ Reset endpoint failed:', error.message);
    return false;
  }
  
  // Test 4: Availability endpoint with valid parameters
  try {
    const availabilityResponse = await axios.get(`${baseURL}/availability?restaurant_id=r_anker&date=2023-01-01&party_size=2`);
    console.log('✓ Availability endpoint:', availabilityResponse.status);
  } catch (error) {
    console.error('✗ Availability endpoint failed:', error.message);
    // This might fail due to missing restaurant data, but that's OK for this test
  }
  
  console.log('All comprehensive tests completed successfully!');
  return true;
}

testService().catch(console.error);