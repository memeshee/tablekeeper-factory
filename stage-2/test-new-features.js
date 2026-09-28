const axios = require('axios');

async function testNewFeatures() {
  const baseURL = 'http://localhost:8081';
  
  console.log('Testing newly implemented features...');
  
  // Test 1: Reservation moves route exists
  try {
    const response = await axios.post(`${baseURL}/reservation-moves`, {});
    console.log('✓ Reservation moves route accessible (expected 422 for missing params)');
  } catch (error) {
    if (error.response && error.response.status === 422) {
      console.log('✓ Reservation moves route properly handles missing params');
    } else {
      console.log('✗ Reservation moves route error:', error.message);
    }
  }
  
  console.log('New feature tests completed!');
}

testNewFeatures().catch(console.error);