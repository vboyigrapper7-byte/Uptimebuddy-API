/**
 * UptimeBuddy Auth Verification Script
 * Validates the new production-grade auth flow.
 */
const axios = require('axios');

const API_URL = 'http://localhost:3001/api/v1/auth';

async function verify() {
    console.log('--- Starting Auth Verification ---');
    
    try {
        // 1. Login as Admin
        console.log('1. Testing Admin Login...');
        const loginRes = await axios.post(`${API_URL}/login`, {
            email: 'admin@uptimebuddy.com',
            password: 'Admin@123'
        });
        
        const { accessToken } = loginRes.data;
        const cookies = loginRes.headers['set-cookie'];
        const refreshTokenCookie = cookies ? cookies.find(c => c.startsWith('refreshToken')) : null;

        console.log('✓ Login successful');
        console.log(`✓ Access Token received (length: ${accessToken.length})`);
        console.log(`✓ Refresh Token cookie set: ${!!refreshTokenCookie}`);

        // 2. Test Admin Route
        console.log('\n2. Testing Admin Role Gate...');
        const adminRes = await axios.get(`${API_URL}/admin-test`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        console.log(`✓ Admin access granted: ${adminRes.data.message}`);

        // 3. Test API Key Generation
        console.log('\n3. Testing API Key Generation...');
        const keyRes = await axios.post(`${API_URL}/api-key`, {}, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const apiKey = keyRes.data.apiKey;
        console.log(`✓ API Key generated: ${apiKey.substring(0, 5)}...`);

        // 4. Test Token Refresh
        if (refreshTokenCookie) {
            console.log('\n4. Testing Token Refresh flow...');
            const refreshRes = await axios.post(`${API_URL}/refresh`, {}, {
                headers: { Cookie: refreshTokenCookie }
            });
            console.log(`✓ New Access Token received: ${!!refreshRes.data.accessToken}`);
        }

        console.log('\n--- VERIFICATION SUCCESSFUL ---');
    } catch (err) {
        console.error('\n--- VERIFICATION FAILED ---');
        if (err.response) {
            console.error(`Status: ${err.response.status}`);
            console.error(`Error: ${JSON.stringify(err.response.data)}`);
        } else {
            console.error(err.message);
        }
    }
}

// NOTE: Ensure the backend is running before executing this!
// verify();

module.exports = verify;
