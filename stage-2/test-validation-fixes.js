const axios = require('axios');

async function testSpecificValidations() {
  const baseURL = 'http://localhost:8081';
  
  console.log('Testing specific validation fixes...');
  
  // Test 1: Invalid date (2026-02-30 should fail)
  try {
    const response = await axios.get(`${baseURL}/availability?restaurant_id=r_anker&date=2026-02-30&party_size=2`);
    console.log('✗ Invalid date should have failed but got:', response.status);
  } catch (error) {
    if (error.response && error.response.status === 422) {
      console.log('✓ Invalid date correctly rejected');
    } else {
      console.log('✗ Unexpected error for invalid date:', error.message);
    }
  }
  
  // Test 2: Invalid party size formats
  try {
    const response = await axios.get(`${baseURL}/availability?restaurant_id=r_anker&date=2023-01-01&party_size=1e9`);
    console.log('✗ Invalid party size "1e9" should have failed but got:', response.status);
  } catch (error) {
    if (error.response && error.response.status === 422) {
      console.log('✓ Invalid party size "1e9" correctly rejected');
    } else {
      console.log('✗ Unexpected error for invalid party size "1e9":', error.message);
    }
  }
  
  try {
    const response = await axios.get(`${baseURL}/availability?restaurant_id=r_anker&date=2023-01-01&party_size=4.0`);
    console.log('✗ Invalid party size "4.0" should have failed but got:', response.status);
  } catch (error) {
    if (error.response && error.response.status === 422) {
      console.log('✓ Invalid party size "4.0" correctly rejected');
    } else {
      console.log('✗ Unexpected error for invalid party size "4.0":', error.message);
    }
  }
  
  // Test 3: Valid party size should work
  try {
    const response = await axios.get(`${baseURL}/availability?restaurant_id=r_anker&date=2023-01-01&party_size=4`);
    console.log('✓ Valid party size "4" accepted:', response.status);
  } catch (error) {
    console.log('✗ Valid party size "4" was rejected:', error.message);
  }
  
  console.log('Specific validation tests completed!');
}

testSpecificValidations().catch(console.error);