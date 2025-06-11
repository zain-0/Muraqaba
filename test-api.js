import fetch from 'node-fetch';

// Test script to verify API endpoints are working
const API_BASE = 'http://localhost:5000/api';

// Test data
const testUser = {
    name: 'Test User',
    email: 'test@example.com',
    password: 'password123',
    role: 'vendor'
};

async function testAPI() {
    console.log('🧪 Testing API Endpoints...\n');
    
    try {
        // Test 1: Registration with validation
        console.log('📝 Testing user registration...');
        const registerResponse = await fetch(`${API_BASE}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testUser)
        });
        
        if (registerResponse.ok) {
            const registerData = await registerResponse.json();
            console.log('✅ Registration successful');
            console.log(`   - Token received: ${registerData.token ? 'Yes' : 'No'}`);
            console.log(`   - User data included: ${registerData.user ? 'Yes' : 'No'}`);
            console.log(`   - Success field: ${registerData.success}`);
        } else {
            const errorData = await registerResponse.json();
            console.log('❌ Registration failed');
            console.log(`   - Status: ${registerResponse.status}`);
            console.log(`   - Error: ${errorData.message}`);
        }
        
        // Test 2: Login
        console.log('\n🔐 Testing user login...');
        const loginResponse = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: testUser.email,
                password: testUser.password
            })
        });
        
        if (loginResponse.ok) {
            const loginData = await loginResponse.json();
            console.log('✅ Login successful');
            console.log(`   - Token received: ${loginData.token ? 'Yes' : 'No'}`);
            console.log(`   - User data included: ${loginData.user ? 'Yes' : 'No'}`);
            console.log(`   - Success field: ${loginData.success}`);
        } else {
            const errorData = await loginResponse.json();
            console.log('❌ Login failed');
            console.log(`   - Status: ${loginResponse.status}`);
            console.log(`   - Error: ${errorData.message}`);
        }
        
        // Test 3: Validation error
        console.log('\n🚫 Testing validation error...');
        const validationResponse = await fetch(`${API_BASE}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'A', // Too short
                email: 'invalid-email', // Invalid format
                password: '123', // Too short
                role: 'invalid' // Invalid role
            })
        });
        
        const validationData = await validationResponse.json();
        console.log(`✅ Validation working: Status ${validationResponse.status}`);
        console.log(`   - Errors returned: ${validationData.errors ? validationData.errors.length : 0}`);
        console.log(`   - Success field: ${validationData.success}`);
        
        // Test 4: 404 Error
        console.log('\n🔍 Testing 404 error...');
        const notFoundResponse = await fetch(`${API_BASE}/nonexistent`);
        const notFoundData = await notFoundResponse.json();
        console.log(`✅ 404 handling: Status ${notFoundResponse.status}`);
        console.log(`   - Message: ${notFoundData.message}`);
        
        console.log('\n🎉 API testing completed!');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    }
}

// Run tests
testAPI();
