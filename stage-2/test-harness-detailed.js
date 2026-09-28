const axios = require('axios');

async function testService() {
  const baseURL = 'http://localhost:8081';
  
  console.log('Testing Tablekeeper Stage 1 service...');
  
  // Test health endpoint
  try {
    const healthResponse = await axios.get(`${baseURL}/health`);
    console.log('✓ Health check:', healthResponse.data);
  } catch (error) {
    console.error('✗ Health check failed:', error.message);
    return false;
  }
  
  // Test empty restaurants list
  try {
    const restaurantsResponse = await axios.get(`${baseURL}/restaurants`);
    console.log('✓ Restaurants endpoint:', restaurantsResponse.data);
  } catch (error) {
    console.error('✗ Restaurants endpoint failed:', error.message);
    return false;
  }
  
  // Test reset endpoint with fixture
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
  
  console.log('All basic tests passed!');
  return true;
}

testService().catch(console.error);