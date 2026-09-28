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
  
  console.log('All basic tests passed!');
  return true;
}

testService().catch(console.error);